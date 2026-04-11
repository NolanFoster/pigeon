use std::cell::RefCell;

use worker::*;

use crate::models::Message;

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
        let pair = WebSocketPair::new()?;
        let server = pair.server.clone();
        let client = pair.client;

        server.accept()?;

        // Send history if ?since= is provided
        let since: Option<i64> = url
            .query_pairs()
            .find(|(k, _)| k == "since")
            .and_then(|(_, v)| {
                if v == "all" {
                    Some(0)
                } else {
                    v.parse().ok()
                }
            });

        if let Some(since_ts) = since {
            if let Ok(db) = self.env.d1("DB") {
                // We need to know the topic — extract from DO name isn't possible,
                // so we'll skip history replay in the DO and let the client fetch via /json
                let _ = (db, since_ts); // suppress unused warnings
            }
        }

        self.connections.borrow_mut().push(server);

        Response::from_websocket(client)
    }

    async fn handle_broadcast(&self, req: &mut Request) -> Result<Response> {
        let msg: Message = req.json().await?;
        let json = serde_json::to_string(&msg)?;

        // Fan out to all connected WebSockets, remove dead ones
        self.connections.borrow_mut().retain(|ws| {
            ws.send_with_str(&json).is_ok()
        });

        Response::ok("ok")
    }
}
