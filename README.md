# Pigeon

Push notifications, simple as HTTP. A self-hosted notification service built on [Cloudflare Workers](https://workers.cloudflare.com/) (Rust/WASM) with a PWA frontend.

Inspired by [ntfy](https://github.com/binwiederhier/ntfy).

## Features

- **Topic-based pub/sub** — publish to any topic with a simple HTTP POST
- **Web Push notifications** — receive notifications even when the browser is closed
- **Real-time streaming** — live message delivery via WebSocket
- **Installable PWA** — add to home screen on mobile or desktop
- **Markdown support** — render formatted messages with `X-Markdown: 1`
- **Filter by tag** — click any tag chip in the UI to filter messages
- **No signup required** — subscribe to any topic, start receiving messages

## Usage

Send a message:

```bash
curl -d "Hello!" https://pigeon.nolanfoster.workers.dev/mytopic
```

With a title and priority:

```bash
curl -H "X-Title: Alert" -H "X-Priority: 5" \
     -d "Server is down!" https://pigeon.nolanfoster.workers.dev/mytopic
```

With markdown:

```bash
curl -H "X-Markdown: 1" \
     -d "**bold** and _italic_ and [link](https://example.com)" \
     https://pigeon.nolanfoster.workers.dev/mytopic
```

### Headers

| Header | Description | Default |
|--------|-------------|---------|
| `X-Title` | Message title | Topic name |
| `X-Priority` | 1 (min) to 5 (max) | 3 |
| `X-Tags` | Comma-separated tags | — |
| `X-Click` | URL to open on notification click | — |
| `X-Markdown` | Set to `1` to enable markdown rendering | 0 |

### Priority and delivery

`X-Priority` isn't just cosmetic — it changes how the push service delivers the
message (RFC 8030 `Urgency`/`TTL`) and how the toast behaves on the device.
Default (no header) is **3 / normal**. Previously every message was sent with
`Urgency: high` and `TTL: 86400`; that is now reserved for priorities 4–5.

| `X-Priority` | Meaning | Urgency | TTL | Collapse | On-device |
|--------------|---------|---------|-----|----------|-----------|
| 1 | min | `very-low` | 1h | per topic | silent |
| 2 | low | `low` | 1h | per topic | — |
| 3 | default | `normal` | 4h | per topic | — |
| 4 | high | `high` | 10m | per topic | re-alert (`renotify`) |
| 5 | max / urgent | `high` | 2m | never | stays on screen (`requireInteraction`) |

Priorities 1–4 share a per-topic collapse key, so a busy topic is a single toast
that updates in place (like ntfy). Priority 5 keeps a unique tag so an urgent
alert can never overwrite another. The RFC 8030 `Topic` header sent to the push
service is a truncated SHA-256 hash of the topic name, never the raw name — the
header is unencrypted and must not leak a capability-URL topic to the push
service.

### API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/:topic` | Publish a message |
| `GET` | `/:topic/json?since=<ts>` | Poll messages since Unix timestamp (`all` for all) |
| `GET` | `/:topic/sse` | WebSocket stream of new messages |
| `DELETE` | `/:topic/messages` | Delete all messages for a topic |
| `DELETE` | `/:topic/messages/:id` | Delete a single message |
| `POST` | `/:topic/push/subscribe` | Register Web Push subscription |
| `DELETE` | `/:topic/push/subscribe` | Unregister Web Push subscription for one topic |
| `DELETE` | `/push/subscribe` | Unregister a push endpoint from **every** topic |
| `GET` | `/vapid-key` | Get VAPID public key for push setup |

Both unsubscribe endpoints take `{"endpoint": "https://…"}` as the body.

### Turning push notifications off

The button in the topics header is a toggle, not a status badge — press it again
to turn push off. Disabling does three things, and each one is enough on its own
to stop notifications:

- `DELETE /push/subscribe` clears the endpoint from every topic server-side, so
  topics this browser has already forgotten about are covered too.
- The browser's `PushSubscription` is revoked, which makes the push service
  reject any later delivery with `410 Gone` — the worker prunes those rows when
  it sees them.
- The choice is stored locally, so a reload doesn't re-register anything. If the
  browser still holds a subscription while push is off (a teardown interrupted
  by a closed tab), the next load finishes tearing it down instead of treating
  it as "still enabled".

If the server can't be reached, the delete is queued and retried on the next
load and whenever the network comes back; the button reports that cleanup is
still pending. Unsubscribing from a single topic unregisters push for that topic
the same way.

Chrome on Android now puts an **Unsubscribe** on every web-push toast. Pigeon
treats that as the same "off" switch: when the permission flips to *denied*, the
app runs the full teardown (`DELETE /push/subscribe`, revoke the subscription,
remember the choice) and the header button returns to **Enable Push
Notifications** — it does not show a "re-open Settings" prompt. If Chrome's
Safety Check auto-revokes the grant instead (permission back to *default*), the
button offers **Restore notifications** rather than silently re-subscribing.

Every content notification also carries a **Mute topic** action. Tapping it
unregisters only that topic's push row and closes the toast; other topics keep
pushing and the PWA is not foregrounded. On browsers without notification
actions (Safari on iOS) the button is simply omitted.

### Installed-app notifications

When the PWA is open (installed or sitting in a tab), push delivery respects
what's already on screen:

- A message for the topic you're currently viewing doesn't also raise an OS
  toast — it's already in the list.
- Tapping a notification for another topic focuses the existing window and
  opens that topic, instead of spawning a second window.
- The home-screen icon shows an unread-count badge (Chromium desktop/Android
  and installed iOS 16.4+ PWAs); it clears as you read.
- If Chrome rotates the push endpoint, the service worker resubscribes and
  re-registers every topic automatically, so push doesn't silently stop.

### Todo lists

Any topic can act as a todo list — no special endpoint, just a tag convention. Publish a message with the `todo` tag and the UI renders it with a checkbox:

```bash
curl -H "X-Tags: todo" -d "Buy milk" https://your-worker.dev/groceries
```

Checking the box publishes a `todo,done` message whose body is the original message's id. Unchecking deletes that marker again, so an accidental tick is undoable without touching the task itself. Completion state is computed by the UI from the message stream; nothing extra is stored. Mixed topics work too — non-`todo` messages render normally alongside checklist items.

Ticking a task never reorders the list. That matters because an edit — including ticking a `- [ ]` box inside a markdown body — republishes the message under a new id and timestamp; the UI keeps the replacement in the position of the message it replaced, and returns keyboard focus to the checkbox that was clicked.

### Editing messages

Each message card has an edit (pencil) button. Editing pre-fills the compose box with the message's title, tags, priority, and body; saving deletes the original via `DELETE /:topic/messages/:id` and publishes the new one. WebSocket subscribers receive a `{"deleted": true, "id": "..."}` event so all open clients update in real time.

## Self-Hosting

### Prerequisites

- [Rust](https://rustup.rs/) with `wasm32-unknown-unknown` target
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI
- [worker-build](https://crates.io/crates/worker-build) (`cargo install worker-build`)

### Setup

1. **Clone and configure:**

   ```bash
   git clone https://github.com/NolanFoster/pigeon.git
   cd pigeon
   ```

2. **Create the D1 database:**

   ```bash
   npx wrangler d1 create pigeon-db
   ```

   Update `database_id` in `wrangler.toml` with the ID from the output.

3. **Run the migrations:**

   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```

4. **Generate VAPID keys:**

   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out vapid_private.pem
   openssl ec -in vapid_private.pem -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '='
   ```

   Store the base64url-encoded private key as a secret:

   ```bash
   npx wrangler secret put VAPID_PRIVATE_KEY
   ```

5. **Update `wrangler.toml`:**

   Set `VAPID_SUBJECT` to your `mailto:` address. The `VAPID_PUBLIC_KEY` is derived from the private key at runtime, but you can set it in `[vars]` for reference.

6. **Deploy:**

   ```bash
   npx wrangler deploy
   ```

### Local Development

```bash
npx wrangler dev
```

## Architecture

```
Client (curl/app)                    Browser (PWA)
    |                                    |
    | POST /:topic                       | WebSocket /:topic/sse
    v                                    v
+------------------ Cloudflare Worker (Rust -> WASM) ------------------+
|  Router                                                              |
|  +- publish.rs   -> D1 insert + DO broadcast + Web Push fan-out      |
|  +- poll.rs      -> D1 query (since=)                                |
|  +- subscribe.rs -> Proxy WebSocket to TopicRoom DO                  |
|  +- push.rs      -> Push subscription CRUD + VAPID key               |
+----------------------------------------------------------------------+
|  TopicRoom (Durable Object, per-topic)                               |
|  +- In-memory WebSocket fan-out                                      |
+----------------------------------------------------------------------+
|  D1 (SQLite): messages, push_subscriptions                           |
+----------------------------------------------------------------------+
```

## Security model

Pigeon is intentionally simple: there is no account system, no API tokens, and
no per-topic ACLs. Knowing a topic name is the only thing required to publish,
read, or delete its messages. Pick unguessable names (treat them like
capability URLs) and rotate them when they leak. If you need stronger access
control, put Pigeon behind a reverse proxy that enforces auth — or front it
with Cloudflare Access / WAF rate-limit rules.

End-to-end encrypted topics are different: the server only sees an opaque
ciphertext envelope and a fixed `[encrypted]` placeholder. Anyone with the
shared passphrase can read messages; the server cannot. Share-link
fragments (`#k=…`) embed the passphrase — send them only over a trusted
channel and assume any recipient gains full read+write on that topic.

Frontend hardening:

- Markdown is parsed via `marked` and run through `DOMPurify` before render;
  `javascript:`, `data:`, `blob:`, etc. URLs are stripped from both `href` and
  `src` attributes.
- All `<script>` sources are self-hosted or pinned with Subresource Integrity;
  CSP forbids inline scripts.
- `/:topic/push/subscribe` rejects endpoints that aren't on a recognized push
  service (FCM, Mozilla autopush, WNS, Apple APNs) to prevent the worker from
  becoming a generic HTTP-POST amplifier.
- The unsubscribe endpoints delete by push endpoint URL, which is itself an
  unguessable capability URL issued by the push service. Anyone holding it can
  already impersonate that subscriber, so being able to unregister it grants
  nothing new — and making "off" work without an account is worth more.
- Chrome on Android runs an on-device model over notification titles, bodies,
  and action labels. Pigeon never sends an empty body or a generic
  "Pigeon"/"Alert" title, and it rejects action labels that read like
  permission prompts (`Allow`, `Verify`, `Click here`, …) so a spammy topic
  can't get the whole origin flagged. Anyone who can POST to a topic can still
  make every subscriber's phone show a toast — keep topic names unguessable.

## License

MIT
