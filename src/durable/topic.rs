use std::cell::RefCell;

use worker::*;
use worker::wasm_bindgen::JsValue;

use crate::db;
use crate::models::{validate_topic, Message, ScheduledListItem, ScheduledMessage};
use crate::schedule::MAX_PENDING;

// Hard cap on concurrent WebSocket connections per topic. An attacker could
// otherwise sit on unlimited open sockets and pin DO memory. 256 leaves room
// for legitimate multi-tab/multi-device use while bounding the worst case.
const MAX_CONNECTIONS: usize = 256;

const SCHED_KEY_PREFIX: &str = "sched:";

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
            "/schedule" => self.handle_schedule(&mut req).await,
            "/list" => self.handle_list().await,
            _ => {
                // `/cancel/{id}` (DELETE). The live room never sees these paths.
                if let Some(rest) = path.strip_prefix("/cancel/") {
                    if !rest.is_empty() && req.method() == Method::Delete {
                        return self.handle_cancel(rest).await;
                    }
                }
                Response::error("Not found", 404)
            }
        }
    }

    /// The scheduler's alarm. At-least-once, so it must be idempotent: a message
    /// whose scheduled id already exists in D1 is not inserted or pushed again.
    async fn alarm(&self) -> Result<Response> {
        let now = Date::now().as_millis() as i64;
        let items = self.list_scheduled().await?;

        for (key, scheduled) in items {
            if scheduled.deliver_at > now {
                continue;
            }
            match self.fire_one(&scheduled).await {
                Ok(()) => {
                    let _ = self.state.storage().delete(&key).await;
                }
                Err(e) => {
                    // Leave the row in storage and reschedule below rather than
                    // letting the 6 alarm retries run out and drop the reminder.
                    console_log!("scheduled fire failed for {}: {:?}", scheduled.id, e);
                }
            }
        }

        self.reschedule_alarm().await?;
        Response::ok("ok")
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
                    // The WS replay shares the same 500-message cap as the JSON
                    // poll (get_messages_since bounds both). The `truncated`
                    // flag has no meaning over a socket; the page bootstraps
                    // from the capped poll and then streams live.
                    if let Ok((messages, _truncated)) =
                        db::get_messages_since(&database, &topic, since_ts).await
                    {
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

    async fn handle_schedule(&self, req: &mut Request) -> Result<Response> {
        let scheduled: ScheduledMessage = req.json().await?;

        // Cap pending rows at 50 per topic. A topic is a capability URL; an
        // uncapped schedule is a way to pin DO storage from one name.
        let pending = self.list_scheduled().await?;
        if pending.len() >= MAX_PENDING {
            return Response::error(
                "Too Many Requests: max scheduled messages for topic",
                429,
            );
        }

        let key = format!("{}{}", SCHED_KEY_PREFIX, scheduled.id);
        self.state.storage().put(&key, &scheduled).await?;
        self.reschedule_alarm().await?;
        Response::ok("ok")
    }

    async fn handle_cancel(&self, id: &str) -> Result<Response> {
        let key = format!("{}{}", SCHED_KEY_PREFIX, id);
        let existed = self.state.storage().delete(&key).await?;
        if existed {
            self.reschedule_alarm().await?;
            Ok(Response::ok("")?.with_status(204))
        } else {
            Response::error("Not found", 404)
        }
    }

    async fn handle_list(&self) -> Result<Response> {
        let items = self.list_scheduled().await?;
        let list: Vec<ScheduledListItem> = items
            .into_iter()
            .map(|(_, s)| ScheduledListItem {
                id: s.id,
                deliver_at: s.deliver_at / 1000,
                timezone: s.timezone,
                title: s.title,
                priority: s.priority,
            })
            .collect();
        Response::from_json(&list)
    }

    /// All pending `sched:` rows as `(key, value)` pairs.
    async fn list_scheduled(&self) -> Result<Vec<(String, ScheduledMessage)>> {
        let storage = self.state.storage();
        let map = storage
            .list_with_options(ListOptions::new().prefix(SCHED_KEY_PREFIX))
            .await?;

        let mut keys: Vec<String> = Vec::new();
        map.for_each(&mut |_value: JsValue, key: JsValue| {
            if let Some(k) = key.as_string() {
                keys.push(k);
            }
        });

        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            if let Some(msg) = storage.get::<ScheduledMessage>(&k).await? {
                out.push((k, msg));
            }
        }
        Ok(out)
    }

    /// Point the single alarm at the earliest pending `deliver_at`, or clear it
    /// when nothing is pending. Never called from the constructor.
    async fn reschedule_alarm(&self) -> Result<()> {
        let storage = self.state.storage();
        let items = self.list_scheduled().await?;
        if items.is_empty() {
            let _ = storage.delete_alarm().await;
            return Ok(());
        }
        let earliest = items
            .into_iter()
            .map(|(_, s)| s.deliver_at)
            .min()
            .unwrap_or(0);
        // A time at or before now fires (nearly) immediately, which is what we
        // want when the earliest row is already due.
        let date = js_sys::Date::new(&JsValue::from_f64(earliest as f64));
        storage.set_alarm(ScheduledTime::new(date)).await?;
        Ok(())
    }

    /// Deliver one scheduled message through the same insert/broadcast/push
    /// path a normal publish uses, with `created_at` set to the fire time.
    /// Idempotent: if the scheduled id is already a D1 row, it has fired.
    async fn fire_one(&self, s: &ScheduledMessage) -> Result<()> {
        let d1 = self.env.d1("DB")?;
        if db::get_message(&d1, &s.topic, &s.id).await?.is_some() {
            return Ok(());
        }

        let now = Date::now().as_millis() / 1000;
        let msg = Message {
            id: s.id.clone(),
            topic: s.topic.clone(),
            title: s.title.clone(),
            message: s.message.clone(),
            priority: s.priority,
            tags: s.tags.clone(),
            click: s.click.clone(),
            image: s.image.clone(),
            markdown: s.markdown,
            encrypted: s.encrypted,
            language: s.language.clone(),
            created_at: now as i64,
        };

        crate::routes::publish::insert_and_broadcast(&self.env, &msg).await?;

        let subscriptions = crate::webpush::prepare_subscriptions(&self.env, &s.topic).await?;
        if !subscriptions.is_empty() {
            crate::webpush::send_push_to_topic(&self.env, &msg, &subscriptions).await?;
        }
        Ok(())
    }
}
