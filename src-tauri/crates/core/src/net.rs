//! Outgoing connections and the user's proxy (Settings > Network): the HTTP
//! clients and the WebSocket connections of the core go through it. A change
//! applies at once: the clients are built again and the open streams reconnect.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use reqwest::{Client, ClientBuilder, Proxy, Url};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, USER_AGENT};
use tokio_tungstenite::{client_async_tls, connect_async, MaybeTlsStream, WebSocketStream};

use crate::data::gateway::user_agent;

/// A WebSocket connection, through the proxy or not.
pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Longest wait for the proxy to open a tunnel.
const TUNNEL_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest answer of a proxy to CONNECT.
const MAX_CONNECT_ANSWER: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProxyProtocol {
    #[default]
    Http,
    Socks5,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxySettings {
    pub enabled: bool,
    pub protocol: ProxyProtocol,
    pub host: String,
    pub port: String,
    pub username: String,
    pub password: String,
}

impl ProxySettings {
    /// The proxy's URL with its credentials; `None` when it is off or the
    /// server and port are not filled in yet.
    fn url(&self) -> Result<Option<Url>> {
        let host = self.host.trim();
        let port = self.port.trim();
        if !self.enabled || host.is_empty() || port.is_empty() {
            return Ok(None);
        }
        let port: u16 = port.parse().map_err(|_| anyhow!("invalid proxy port: {port}"))?;
        // socks5h: names are resolved by the proxy, none is looked up outside it.
        let scheme = match self.protocol {
            ProxyProtocol::Http => "http",
            ProxyProtocol::Socks5 => "socks5h",
        };
        let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
        let mut url = Url::parse(&format!("{scheme}://{host}:{port}")).map_err(|e| anyhow!("invalid proxy server: {e}"))?;
        if !self.username.is_empty() {
            url.set_username(&self.username).map_err(|_| anyhow!("invalid proxy username"))?;
            url.set_password(Some(&self.password)).map_err(|_| anyhow!("invalid proxy password"))?;
        }
        Ok(Some(url))
    }
}

#[derive(Clone)]
struct Active {
    settings: ProxySettings,
    url: Url,
}

fn active() -> &'static RwLock<Option<Active>> {
    static ACTIVE: RwLock<Option<Active>> = RwLock::new(None);
    &ACTIVE
}

fn generation() -> &'static watch::Sender<u64> {
    static GENERATION: OnceLock<watch::Sender<u64>> = OnceLock::new();
    GENERATION.get_or_init(|| watch::channel(0).0)
}

/// Applies the settings. Unusable ones (a port that is no number) are refused
/// and the proxy in use stays.
pub fn set_proxy(settings: &ProxySettings) -> Result<()> {
    let url = settings.url()?;
    if let Some(url) = &url {
        Proxy::all(url.as_str()).map_err(|e| anyhow!("invalid proxy: {e}"))?;
    }
    let next = url.map(|url| Active { settings: settings.clone(), url });
    {
        let mut cur = active().write().unwrap();
        let same = match (&*cur, &next) {
            (None, None) => true,
            (Some(a), Some(b)) => a.settings == b.settings,
            _ => false,
        };
        if same {
            return Ok(());
        }
        *cur = next;
    }
    generation().send_modify(|g| *g += 1);
    Ok(())
}

/// The proxy's URL with its credentials, for clients built elsewhere.
pub fn proxy_url() -> Option<Url> {
    active().read().unwrap().as_ref().map(|a| a.url.clone())
}

/// Fires when the proxy changes: a stream connects again through the new one.
pub fn proxy_changes() -> watch::Receiver<u64> {
    generation().subscribe()
}

/// An HTTP client kept for the whole process, built again when the proxy
/// changes (a clone shares the connection pool).
pub struct SharedClient {
    configure: fn(ClientBuilder) -> ClientBuilder,
    slot: RwLock<Option<(u64, Client)>>,
}

impl SharedClient {
    pub const fn new(configure: fn(ClientBuilder) -> ClientBuilder) -> Self {
        Self { configure, slot: RwLock::new(None) }
    }

    pub fn get(&self) -> Client {
        let current = *generation().borrow();
        if let Some((built, client)) = &*self.slot.read().unwrap() {
            if *built == current {
                return client.clone();
            }
        }
        let mut builder = (self.configure)(Client::builder());
        if let Some(url) = proxy_url() {
            builder = builder.proxy(Proxy::all(url.as_str()).expect("proxy checked by set_proxy"));
        }
        let client = builder.build().expect("build reqwest client");
        *self.slot.write().unwrap() = Some((current, client.clone()));
        client
    }
}

/// Opens a WebSocket, through the proxy when there is one.
pub async fn connect_ws(url: &str) -> Result<WsStream> {
    let mut request = url.into_client_request()?;
    request.headers_mut().insert(USER_AGENT, HeaderValue::from_str(&user_agent())?);
    let Some(proxy) = active().read().unwrap().clone() else {
        let (ws, _resp) = connect_async(request).await?;
        return Ok(ws);
    };
    let target = Url::parse(url).context("invalid stream URL")?;
    let host = target.host_str().context("stream URL without a host")?.trim_matches(['[', ']']).to_string();
    let port = target.port_or_known_default().context("stream URL without a port")?;
    let tunnel = tokio::time::timeout(TUNNEL_TIMEOUT, open_tunnel(&proxy.settings, &host, port))
        .await
        .map_err(|_| anyhow!("proxy: no answer after {} s", TUNNEL_TIMEOUT.as_secs()))??;
    let (ws, _resp) = client_async_tls(request, tunnel).await?;
    Ok(ws)
}

/// A TCP stream to `host:port` through the proxy.
async fn open_tunnel(proxy: &ProxySettings, host: &str, port: u16) -> Result<TcpStream> {
    let server = (proxy.host.trim(), proxy.port.trim().parse::<u16>().context("invalid proxy port")?);
    match proxy.protocol {
        ProxyProtocol::Http => {
            let mut stream = TcpStream::connect(server).await.context("proxy: connection refused")?;
            http_connect(&mut stream, proxy, host, port).await?;
            Ok(stream)
        }
        ProxyProtocol::Socks5 => {
            use tokio_socks::tcp::Socks5Stream;
            let target = (host, port);
            let stream = if proxy.username.is_empty() {
                Socks5Stream::connect(server, target).await
            } else {
                Socks5Stream::connect_with_password(server, target, &proxy.username, &proxy.password).await
            };
            Ok(stream.context("proxy: SOCKS5 connection refused")?.into_inner())
        }
    }
}

/// HTTP CONNECT on an open connection to the proxy. Reads the answer byte by
/// byte: what follows it belongs to the tunnel.
async fn http_connect(stream: &mut TcpStream, proxy: &ProxySettings, host: &str, port: u16) -> Result<()> {
    let authority = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if !proxy.username.is_empty() {
        let credentials = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", proxy.username, proxy.password));
        request.push_str(&format!("Proxy-Authorization: Basic {credentials}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.context("proxy: send failed")?;

    let mut answer = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !answer.ends_with(b"\r\n\r\n") {
        if answer.len() >= MAX_CONNECT_ANSWER {
            bail!("proxy: answer too long");
        }
        if stream.read(&mut byte).await.context("proxy: read failed")? == 0 {
            bail!("proxy: closed the connection");
        }
        answer.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&answer);
    let status = text.lines().next().unwrap_or_default();
    match status.split_whitespace().nth(1) {
        Some("200") => Ok(()),
        _ => bail!("proxy: {status}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::copy_bidirectional;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    fn settings(protocol: ProxyProtocol, port: u16) -> ProxySettings {
        ProxySettings { enabled: true, protocol, host: "127.0.0.1".into(), port: port.to_string(), ..Default::default() }
    }

    /// A WebSocket server echoing text; its port.
    async fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                    while let Some(Ok(m)) = ws.next().await {
                        if m.is_text() {
                            ws.send(m).await.unwrap();
                        }
                    }
                });
            }
        });
        port
    }

    /// An HTTP proxy answering CONNECT and relaying; the port and each request's head.
    async fn http_proxy(required_auth: Option<String>) -> (u16, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                let tx = tx.clone();
                let required = required_auth.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if client.read(&mut byte).await.unwrap_or(0) == 0 {
                            return;
                        }
                        head.push(byte[0]);
                    }
                    let head = String::from_utf8_lossy(&head).to_string();
                    let _ = tx.send(head.clone());
                    if required.is_some_and(|a| !head.contains(&a)) {
                        let _ = client.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").await;
                        return;
                    }
                    let target = head.split_whitespace().nth(1).unwrap().to_string();
                    let mut upstream = TcpStream::connect(target).await.unwrap();
                    client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
                    let _ = copy_bidirectional(&mut client, &mut upstream).await;
                });
            }
        });
        (port, rx)
    }

    /// A SOCKS5 proxy without authentication; its port.
    async fn socks5_proxy() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut hello = [0u8; 2];
                    client.read_exact(&mut hello).await.unwrap();
                    let mut methods = vec![0u8; hello[1] as usize];
                    client.read_exact(&mut methods).await.unwrap();
                    client.write_all(&[5, 0]).await.unwrap();
                    let mut req = [0u8; 4];
                    client.read_exact(&mut req).await.unwrap();
                    assert_eq!(req[3], 1, "an IPv4 target in this test");
                    let mut addr = [0u8; 6];
                    client.read_exact(&mut addr).await.unwrap();
                    let target = (std::net::Ipv4Addr::new(addr[0], addr[1], addr[2], addr[3]), u16::from_be_bytes([addr[4], addr[5]]));
                    let mut upstream = TcpStream::connect(target).await.unwrap();
                    client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                    let _ = copy_bidirectional(&mut client, &mut upstream).await;
                });
            }
        });
        port
    }

    async fn talk_through(tunnel: TcpStream, port: u16) -> String {
        let (mut ws, _) = client_async_tls(format!("ws://127.0.0.1:{port}/"), tunnel).await.unwrap();
        ws.send(Message::Text("hello".into())).await.unwrap();
        ws.next().await.unwrap().unwrap().into_text().unwrap().to_string()
    }

    #[test]
    fn url_waits_for_the_server_and_port_and_encodes_the_credentials() {
        let mut s = ProxySettings::default();
        assert_eq!(s.url().unwrap(), None);
        s.enabled = true;
        assert_eq!(s.url().unwrap(), None);
        s.host = "proxy.local".into();
        assert_eq!(s.url().unwrap(), None);
        s.port = "3128".into();
        assert_eq!(s.url().unwrap().unwrap().as_str(), "http://proxy.local:3128/");
        s.username = "me".into();
        s.password = "p@ss:word".into();
        assert_eq!(s.url().unwrap().unwrap().as_str(), "http://me:p%40ss%3Aword@proxy.local:3128/");
        s.protocol = ProxyProtocol::Socks5;
        assert!(s.url().unwrap().unwrap().as_str().starts_with("socks5h://"));
        s.port = "abc".into();
        assert!(s.url().is_err());
    }

    /// The proxy is process-wide: tests connecting through the shared clients or
    /// `connect_ws` take turns with the test that sets it.
    static PROXY_IN_USE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// The client of the gateway calls sends the User-Agent.
    #[tokio::test]
    async fn gateway_calls_carry_the_user_agent() {
        let _turn = PROXY_IN_USE.lock().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut head = vec![0u8; 4096];
            let n = tcp.read(&mut head).await.unwrap();
            tcp.write_all(b"HTTP/1.1 200 OK
Content-Length: 0
Connection: close

").await.unwrap();
            String::from_utf8_lossy(&head[..n]).to_lowercase()
        });
        crate::data::market_rest::http().get(format!("http://127.0.0.1:{port}/")).send().await.unwrap();
        let head = server.await.unwrap();
        assert!(head.contains(&format!("user-agent: {}", user_agent()).to_lowercase()), "{head}");
    }

    #[tokio::test]
    async fn websocket_carries_the_user_agent() {
        let _turn = PROXY_IN_USE.lock().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut agent = None;
            tokio_tungstenite::accept_hdr_async(tcp, |req: &tokio_tungstenite::tungstenite::handshake::server::Request, res| {
                agent = req.headers().get(USER_AGENT).map(|v| v.to_str().unwrap().to_string());
                Ok(res)
            })
            .await
            .unwrap();
            agent
        });
        let _ws = connect_ws(&format!("ws://127.0.0.1:{port}/")).await.unwrap();
        assert_eq!(server.await.unwrap(), Some(user_agent()));
    }

    #[tokio::test]
    async fn websocket_through_an_http_proxy() {
        let server = echo_server().await;
        let (proxy, mut seen) = http_proxy(None).await;
        let tunnel = open_tunnel(&settings(ProxyProtocol::Http, proxy), "127.0.0.1", server).await.unwrap();
        assert_eq!(talk_through(tunnel, server).await, "hello");
        assert!(seen.recv().await.unwrap().starts_with(&format!("CONNECT 127.0.0.1:{server} HTTP/1.1")));
    }

    #[tokio::test]
    async fn websocket_through_a_socks5_proxy() {
        let server = echo_server().await;
        let proxy = socks5_proxy().await;
        let tunnel = open_tunnel(&settings(ProxyProtocol::Socks5, proxy), "127.0.0.1", server).await.unwrap();
        assert_eq!(talk_through(tunnel, server).await, "hello");
    }

    #[tokio::test]
    async fn http_proxy_credentials_and_refusal() {
        let server = echo_server().await;
        // base64("me:secret")
        let (proxy, _seen) = http_proxy(Some("Proxy-Authorization: Basic bWU6c2VjcmV0".into())).await;
        let mut s = settings(ProxyProtocol::Http, proxy);
        let err = open_tunnel(&s, "127.0.0.1", server).await.unwrap_err();
        assert!(err.to_string().contains("407"), "{err}");
        s.username = "me".into();
        s.password = "secret".into();
        let tunnel = open_tunnel(&s, "127.0.0.1", server).await.unwrap();
        assert_eq!(talk_through(tunnel, server).await, "hello");
    }

    /// The one test that sets the process-wide proxy: clients, streams and the change signal together.
    #[tokio::test]
    async fn the_shared_client_and_streams_follow_the_setting() {
        let _turn = PROXY_IN_USE.lock().await;
        static CLIENT: SharedClient = SharedClient::new(|b| b);
        let (proxy, mut seen) = http_proxy(None).await;
        let server = echo_server().await;
        let mut changes = proxy_changes();

        set_proxy(&settings(ProxyProtocol::Http, proxy)).unwrap();
        assert!(changes.has_changed().unwrap());
        changes.mark_unchanged();

        // A plain http URL through the proxy is sent to the proxy.
        let _ = CLIENT.get().get(format!("http://127.0.0.1:{server}/ping")).send().await;
        assert!(seen.recv().await.unwrap().contains(&format!("127.0.0.1:{server}/ping")));

        let mut ws = connect_ws(&format!("ws://127.0.0.1:{server}/")).await.unwrap();
        assert!(seen.recv().await.unwrap().starts_with("CONNECT "));
        ws.send(Message::Text("hello".into())).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().to_string(), "hello");

        // The same settings again: nothing changes. A bad port: refused, the proxy stays.
        set_proxy(&settings(ProxyProtocol::Http, proxy)).unwrap();
        assert!(!changes.has_changed().unwrap());
        let mut bad = settings(ProxyProtocol::Http, proxy);
        bad.port = "abc".into();
        assert!(set_proxy(&bad).is_err());
        assert!(proxy_url().is_some());

        // Off: direct again.
        set_proxy(&ProxySettings::default()).unwrap();
        assert!(changes.has_changed().unwrap());
        assert!(proxy_url().is_none());
        let mut ws = connect_ws(&format!("ws://127.0.0.1:{server}/")).await.unwrap();
        ws.send(Message::Text("direct".into())).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().to_string(), "direct");
        assert!(seen.try_recv().is_err());
    }
}
