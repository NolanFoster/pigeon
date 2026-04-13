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

### API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/:topic` | Publish a message |
| `GET` | `/:topic/json?since=<ts>` | Poll messages since Unix timestamp (`all` for all) |
| `GET` | `/:topic/sse` | WebSocket stream of new messages |
| `POST` | `/:topic/push/subscribe` | Register Web Push subscription |
| `DELETE` | `/:topic/push/subscribe` | Unregister Web Push subscription |
| `GET` | `/vapid-key` | Get VAPID public key for push setup |

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

3. **Run the migration:**

   ```bash
   npx wrangler d1 execute pigeon-db --remote --file=migrations/0001_initial.sql
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

## License

MIT
