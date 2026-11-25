/*
 * pass — the subscribed account's pass (#252), what the gateway asks for
 * real-time data.
 *
 * The frontend gets it from the accounts server (deploy/community,
 * `POST /auth/pass`, for a signed-in account on the paid plan), hands it here
 * and renews it before it expires (15 min). While there is one, market REST
 * calls send it as `X-OpenTrader-Pass` (bars and snapshots come real-time),
 * and the market stream connects to the real-time route with it and renews it
 * on the open socket. No pass: the free tier, delayed data, as before.
 *
 * The gateway gives REST real-time answers only to the device holding the
 * account's real-time stream session (gateway#19): the stream connects as soon
 * as there is a pass, is given a key when it authenticates, and REST calls send
 * both. The plan is decided by the accounts server and checked by the gateway
 * on every connection: nothing in this process can make a pass.
 *
 * The gateway keeps one real-time session per account. When another device
 * takes it, this one is told "signed in elsewhere": it stays on delayed data
 * (`elsewhere`) until the user takes the session back, so two devices do not
 * keep closing each other's stream.
 */
use std::sync::OnceLock;
use tokio::sync::watch;

/// The REST header of the pass (the gateway's `PASS_HEADER`).
pub const HEADER: &str = "X-OpenTrader-Pass";
/// The REST header of the stream session's key (the gateway's `SESSION_HEADER`).
pub const SESSION_HEADER: &str = "X-OpenTrader-Session";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pass {
    pub token: String,
    /// Expiry, UNIX seconds.
    pub exp: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct State {
    pub pass: Option<Pass>,
    /// Another device holds the account's real-time session.
    pub elsewhere: bool,
    /// The key of this device's real-time stream session, while it is up.
    pub session: Option<String>,
}

impl State {
    /// The pass to send at `now` (UNIX seconds): set, not expired, not given up to another device.
    pub fn usable(&self, now: i64) -> Option<&str> {
        if self.elsewhere {
            return None;
        }
        self.pass.as_ref().filter(|p| p.exp > now).map(|p| p.token.as_str())
    }
}

fn cell() -> &'static watch::Sender<State> {
    static CELL: OnceLock<watch::Sender<State>> = OnceLock::new();
    CELL.get_or_init(|| watch::channel(State::default()).0)
}

pub fn subscribe() -> watch::Receiver<State> {
    cell().subscribe()
}

/// A new pass from the frontend, or none (signed out, free plan).
pub fn set(pass: Option<Pass>) {
    cell().send_if_modified(|s| {
        let changed = s.pass != pass;
        s.pass = pass;
        changed
    });
}

/// The gateway closed this device's real-time stream for another device's (`true`), or the user took it back.
pub fn set_elsewhere(elsewhere: bool) {
    cell().send_if_modified(|s| {
        let changed = s.elsewhere != elsewhere;
        s.elsewhere = elsewhere;
        changed
    });
}

/// The real-time stream session authenticated (its key) or ended (none).
pub fn set_session(session: Option<String>) {
    cell().send_if_modified(|s| {
        let changed = s.session != session;
        s.session = session;
        changed
    });
}

/// Wait until the real-time stream session is up, at most `timeout`. True when it is.
pub async fn wait_live(timeout: std::time::Duration) -> bool {
    let mut rx = subscribe();
    tokio::time::timeout(timeout, rx.wait_for(|s| s.session.is_some())).await.is_ok_and(|r| r.is_ok())
}

/// The pass the gateway calls send now, if any.
pub fn current() -> Option<String> {
    cell().borrow().usable(chrono::Utc::now().timestamp()).map(str::to_string)
}

/// The pass and the session's key, once this device's real-time stream session
/// is up: what the gateway's real-time answers and screener feed take.
pub fn current_live() -> Option<(String, String)> {
    let s = cell().borrow();
    let session = s.session.clone()?;
    s.usable(chrono::Utc::now().timestamp()).map(|p| (p.to_string(), session))
}

/// Real-time data is asked for (a usable pass): the tier the entitlements are probed for.
pub fn realtime() -> bool {
    current().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pass_is_usable_until_it_expires_and_not_while_elsewhere() {
        let mut s = State { pass: Some(Pass { token: "otp1.a.b".into(), exp: 100 }), elsewhere: false, session: None };
        assert_eq!(s.usable(99), Some("otp1.a.b"));
        assert_eq!(s.usable(100), None);
        s.elsewhere = true;
        assert_eq!(s.usable(99), None);
        assert_eq!(State::default().usable(0), None);
    }

    #[test]
    fn set_elsewhere_notifies_only_on_change() {
        let mut rx = subscribe();
        rx.mark_unchanged();
        set_elsewhere(false);
        assert!(!rx.has_changed().unwrap());
        set_elsewhere(true);
        assert!(rx.has_changed().unwrap());
        rx.mark_unchanged();
        set_elsewhere(true);
        assert!(!rx.has_changed().unwrap());
        set_elsewhere(false);
        assert!(rx.has_changed().unwrap());
    }
}
