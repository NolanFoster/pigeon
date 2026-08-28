use std::cell::RefCell;

use worker::*;

use crate::{db, models::validate_topic};

// Hard cap on concurrent WebSocket connections per topic. An attacker could
// otherwise sit on unlimited open sockets and pin DO memory. 256 leaves room
// for legitimate multi-tab/multi-device use while bounding the worst case.
const MAX_CONNECTIONS: usize = 256;

#[durable_object]
pub struct TopicRoom {
    state: State,
    env: Env,
    connections: RefCell<Vec<WebSocket>>,
}

impl DurableObject for TopicRoom {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            connections: RefCell::new(Vec::new()),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        let path = url.path();

        match &*path {
            "/connect" => self.handle_connect(&url).await,
            "/broadcast" => self.handle_broadcast(&mut req).await,
            _ => Response::error("Not found", 404),
        }
    }
}

impl TopicRoom {
    async fn handle_connect(&self, url: &Url) -> Result<Response> {
        if self.connections.borrow().len() >= MAX_CONNECTIONS {
            return Response::error("Too Many Connections", 429);
        }

        let pair = WebSocketPair::new()?;
        let server = pair.server.clone();
        let client = pair.client;

        server.accept()?;

        // Register before replaying history. A publisher can now either find
        // this socket in the broadcast list or have its message included in the
        // replay, eliminating the otherwise unavoidable subscribe/publish gap.
        self.connections.borrow_mut().push(server.clone());

        let topic = url
            .query_pairs()
            .find(|(k, _)| k == "topic")
            .map(|(_, v)| v.to_string());
        let since: Option<i64> = url
            .query_pairs()
            .find(|(k, _)| k == "since")
            .and_then(|(_, v)| if v == "all" { Some(0) } else { v.parse().ok() });

        if let (Some(topic), Some(since_ts)) = (topic, since) {
            if validate_topic(&topic).is_ok() {
                if let Ok(database) = self.env.d1("DB") {
                    if let Ok(messages) = db::get_messages_since(&database, &topic, since_ts).await {
                        for message in messages {
                            let json = serde_json::to_string(&message)?;
                            // A failed send is harmless: broadcast cleanup will
                            // remove the stale socket on its next delivery.
                            let _ = server.send_with_str(&json);
                        }
                    }
                }
            }
        }

        Response::from_websocket(client)
    }

    async fn handle_broadcast(&self, req: &mut Request) -> Result<Response> {
        let json = req.text().await?;

        // Fan out to all connected WebSockets, remove dead ones
        self.connections.borrow_mut().retain(|ws| {
            ws.send_with_str(&json).is_ok()
        });

        Response::ok("ok")
    }
}
