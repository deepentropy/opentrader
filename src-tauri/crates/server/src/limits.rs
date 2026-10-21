/*
 * Limits of a public server (web demo):
 *
 *   - API calls per visitor IP: a token bucket (OPENTRADER_RATE_PER_MIN calls
 *     a minute on average, bursts of OPENTRADER_RATE_BURST); over it the call
 *     answers 429.
 *   - Visitors connected at once (OPENTRADER_MAX_CLIENTS): a new tab over the
 *     cap gets 503 "too many visitors" on its events connection, and the page
 *     says so.
 *   - Distinct symbols streamed for all visitors together
 *     (OPENTRADER_MAX_LIVE_SYMBOLS): a chart or watchlist subscription that
 *     would add symbols over it answers 503 (the bars still load, without
 *     live updates).
 *
 * 0 = no limit. The visitor IP is the proxy's `CF-Connecting-IP` /
 * `X-Forwarded-For` when present, else the connection's address.
 */
use axum::http::HeaderMap;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::Instant;

pub const TOO_MANY_VISITORS: &str = "too many visitors";

pub struct Limits {
    /// Calls a second (refill) and bucket size; rate 0 = unlimited.
    rate: f64,
    burst: f64,
    pub max_clients: usize,
    pub max_live_symbols: usize,
    buckets: Mutex<HashMap<IpAddr, (f64, Instant)>>,
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(default)
}

impl Limits {
    pub fn new(per_min: usize, burst: usize, max_clients: usize, max_live_symbols: usize) -> Self {
        Self {
            rate: per_min as f64 / 60.0,
            burst: burst.max(1) as f64,
            max_clients,
            max_live_symbols,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn from_env() -> Self {
        Self::new(
            env_usize("OPENTRADER_RATE_PER_MIN", 600),
            env_usize("OPENTRADER_RATE_BURST", 120),
            env_usize("OPENTRADER_MAX_CLIENTS", 500),
            env_usize("OPENTRADER_MAX_LIVE_SYMBOLS", 2000),
        )
    }

    /// One API call from `ip`: false when over its rate.
    pub fn allow(&self, ip: IpAddr) -> bool {
        self.allow_at(ip, Instant::now())
    }

    fn allow_at(&self, ip: IpAddr, now: Instant) -> bool {
        if self.rate <= 0.0 {
            return true;
        }
        let mut map = self.buckets.lock().unwrap();
        // Forget idle visitors now and then (a full bucket is the same as none).
        if map.len() > 10_000 {
            let full = self.burst / self.rate;
            map.retain(|_, (_, t)| now.duration_since(*t).as_secs_f64() < full);
        }
        let (tokens, at) = map.entry(ip).or_insert((self.burst, now));
        *tokens = (*tokens + now.duration_since(*at).as_secs_f64() * self.rate).min(self.burst);
        *at = now;
        if *tokens < 1.0 {
            return false;
        }
        *tokens -= 1.0;
        true
    }
}

/// The visitor's IP: the proxy's headers first, else the socket's.
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<IpAddr> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if let Some(ip) = header("cf-connecting-ip").and_then(|v| v.trim().parse().ok()) {
        return Some(ip);
    }
    if let Some(ip) = header("x-forwarded-for").and_then(|v| v.split(',').next()).and_then(|v| v.trim().parse().ok()) {
        return Some(ip);
    }
    peer.map(|p| p.ip())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn token_bucket_refills() {
        let l = Limits::new(60, 3, 0, 0);
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        let t0 = Instant::now();
        assert!(l.allow_at(ip, t0));
        assert!(l.allow_at(ip, t0));
        assert!(l.allow_at(ip, t0));
        assert!(!l.allow_at(ip, t0));
        // 1 call a second: one more after a second.
        assert!(l.allow_at(ip, t0 + Duration::from_millis(1000)));
        assert!(!l.allow_at(ip, t0 + Duration::from_millis(1000)));
        // Another visitor has its own bucket.
        assert!(l.allow_at("10.0.0.2".parse().unwrap(), t0));
    }

    #[test]
    fn zero_rate_is_unlimited() {
        let l = Limits::new(0, 1, 0, 0);
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        for _ in 0..1000 {
            assert!(l.allow(ip));
        }
    }

    #[test]
    fn ip_from_proxy_headers() {
        let mut h = HeaderMap::new();
        let peer: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        assert_eq!(client_ip(&h, Some(peer)), Some("127.0.0.1".parse().unwrap()));
        h.insert("x-forwarded-for", "203.0.113.9, 10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&h, Some(peer)), Some("203.0.113.9".parse().unwrap()));
        h.insert("cf-connecting-ip", "198.51.100.7".parse().unwrap());
        assert_eq!(client_ip(&h, Some(peer)), Some("198.51.100.7".parse().unwrap()));
    }
}
