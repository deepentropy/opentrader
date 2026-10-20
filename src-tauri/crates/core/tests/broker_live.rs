/*
 * Live check of the broker connection against a PAPER IB Gateway / TWS.
 * Ignored by default; run with
 *   IB_PAPER_ADDR=127.0.0.1:4002 cargo test -p opentrader-core --test broker_live -- --ignored --nocapture
 * It places one buy limit far below the market, changes its price and
 * cancels it.
 */
use opentrader_core::broker::types::*;
use opentrader_core::broker::Broker;
use opentrader_core::host::{Host, HostRef};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

#[derive(Default)]
struct Events(Mutex<Vec<(String, serde_json::Value)>>);

impl Host for Events {
    fn emit_value(&self, name: &'static str, payload: serde_json::Value) {
        self.0.lock().unwrap().push((name.to_string(), payload));
    }
}

async fn wait_for(broker: &Broker, what: &str, f: impl Fn(&BrokerState) -> bool) -> BrokerState {
    for _ in 0..100 {
        let s = broker.state();
        if f(&s) {
            return s;
        }
        tokio::time::sleep(StdDuration::from_millis(200)).await;
    }
    panic!("timed out waiting for {what}: {:#?}", broker.state().orders);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn paper_round_trip() {
    let addr = std::env::var("IB_PAPER_ADDR").unwrap_or_else(|_| "127.0.0.1:4002".into());
    let (host, port) = addr.rsplit_once(':').unwrap();
    let events = Arc::new(Events::default());
    let h: HostRef = events.clone();
    let broker = Broker::default();
    let s = broker
        .connect(h, BrokerConfig { host: host.into(), port: port.parse().unwrap(), client_id: 901 })
        .await
        .expect("connect");
    assert_eq!(s.connection, ConnectionState::Connected);
    let account = s.account.clone().expect("an account");
    assert!(account.starts_with('D'), "not a paper account: {account}");
    println!("accounts {:?}", s.accounts);

    let s = wait_for(&broker, "account summary", |s| s.summary.as_ref().is_some_and(|x| x.equity.is_some())).await;
    let sum = s.summary.unwrap();
    println!("equity {:?} balance {:?} available {:?} margin {:?} upnl {:?} rpnl {:?}",
        sum.equity, sum.balance, sum.available_funds, sum.account_margin, sum.unrealized_pnl, sum.realized_pnl);
    tokio::time::sleep(StdDuration::from_secs(3)).await;
    for p in broker.state().positions {
        println!("position {} {:?} {} @ {} last {:?} upnl {:?}", p.symbol, p.side, p.qty, p.avg_price, p.last, p.unrealized_pnl);
    }
    println!("orders {} executions {}", broker.state().orders.len(), broker.state().executions.len());

    broker.watch_quote(Some("NASDAQ:AAPL".into())).await.expect("quote");

    let ticket = OrderTicket {
        symbol: "NASDAQ:AAPL".into(),
        side: Side::Buy,
        order_type: OrderType::Limit,
        qty: 1.0,
        limit_price: Some(1.0),
        stop_price: None,
        duration: Duration::Gtc,
        outside_rth: false,
        take_profit: None,
        stop_loss: None,
    };
    let id = broker.place_order(ticket.clone()).await.expect("place");
    println!("placed {id}");
    let s = wait_for(&broker, "working order", |s| {
        s.orders.iter().any(|o| o.id == id && matches!(o.status, OrderStatus::Working | OrderStatus::Inactive))
    })
    .await;
    let o = s.orders.iter().find(|o| o.id == id).unwrap();
    println!("order {} {:?} {:?} {} {:?} perm {}", o.symbol, o.side, o.order_type, o.qty, o.limit_price, o.perm_id);
    assert_eq!(o.symbol, "NASDAQ:AAPL");

    broker
        .modify_order(id.clone(), OrderTicket { limit_price: Some(1.01), ..ticket.clone() })
        .await
        .expect("modify");
    wait_for(&broker, "modified price", |s| s.orders.iter().any(|o| o.id == id && o.limit_price == Some(1.01))).await;

    broker.cancel_order(id.clone()).await.expect("cancel");
    wait_for(&broker, "cancelled", |s| s.orders.iter().any(|o| o.id == id && o.status == OrderStatus::Cancelled)).await;

    let quotes = events.0.lock().unwrap().iter().filter(|(n, _)| n == "broker-quote").count();
    let states = events.0.lock().unwrap().iter().filter(|(n, _)| n == "broker-state").count();
    println!("events: {states} broker-state, {quotes} broker-quote");
    if let Some((_, q)) = events.0.lock().unwrap().iter().rev().find(|(n, _)| n == "broker-quote") {
        println!("last quote {q}");
    }
    for n in broker.state().notices.iter().take(10) {
        println!("notice {:?} {} {}", n.level, n.code, n.message);
    }
    assert!(states > 0);
    broker.disconnect().await;
    assert_eq!(broker.state().connection, ConnectionState::Disconnected);
}
