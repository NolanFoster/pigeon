use worker::*;

mod db;
mod durable;
mod models;
mod routes;
mod webpush;

// Embed static files directly in the binary
const INDEX_HTML: &str = include_str!("../public/index.html");
const APP_JS: &str = include_str!("../public/app.js");
const CRYPTO_JS: &str = include_str!("../public/crypto.js");
const KEYSTORE_JS: &str = include_str!("../public/keystore.js");
const STYLE_CSS: &str = include_str!("../public/style.css");
const SW_JS: &str = include_str!("../public/sw.js");
const MANIFEST_JSON: &str = include_str!("../public/manifest.json");
// Pinned, self-hosted third-party JS. Self-hosting eliminates CDN-compromise
// XSS, allows a strict `script-src 'self'` CSP, and avoids leaking visitor IPs
// to third parties. Pinned versions: marked 11.1.1, DOMPurify 3.2.4,
// SortableJS 1.15.2.
const MARKED_JS: &str = include_str!("../public/vendor/marked.min.js");
const DOMPURIFY_JS: &str = include_str!("../public/vendor/purify.min.js");
const SORTABLE_JS: &str = include_str!("../public/vendor/Sortable.min.js");
const ICON_192: &[u8] = include_bytes!("../public/icon-192.png");
const ICON_512: &[u8] = include_bytes!("../public/icon-512.png");
const SCREENSHOT_WIDE: &[u8] = include_bytes!("../public/screenshot-wide.png");
const SCREENSHOT_NARROW: &[u8] = include_bytes!("../public/screenshot-narrow.png");
const FAVICON: &[u8] = include_bytes!("../public/favicon.png");
const LOGO: &[u8] = include_bytes!("../public/logo.png");
const BADGE: &[u8] = include_bytes!("../public/badge.png");

// CSP: scripts come from self plus the pinned (SRI-protected) Toast UI Editor
// origin. Inline styles are allowed because Toast UI Editor injects them at
// runtime; nothing in our own code requires 'unsafe-inline' for scripts.
const CSP: &str = "default-src 'self'; \
script-src 'self' https://uicdn.toast.com; \
style-src 'self' 'unsafe-inline' https://uicdn.toast.com https://fonts.googleapis.com; \
font-src 'self' https://fonts.gstatic.com data:; \
img-src 'self' data: https:; \
connect-src 'self' wss: https:; \
worker-src 'self'; \
manifest-src 'self'; \
frame-ancestors 'none'; \
base-uri 'none'; \
object-src 'none'; \
form-action 'self'";

fn apply_security_headers(headers: &Headers) -> Result<()> {
    headers.set("Content-Security-Policy", CSP)?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("Referrer-Policy", "no-referrer")?;
    headers.set(
        "Permissions-Policy",
        "geolocation=(), microphone=(), camera=(), payment=()",
    )?;
    headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains",
    )?;
    Ok(())
}

fn serve_static_with_cache(
    content: &str,
    content_type: &str,
    cache_control: &str,
) -> Result<Response> {
    let headers = Headers::new();
    headers.set("Content-Type", content_type)?;
    headers.set("Cache-Control", cache_control)?;
    apply_security_headers(&headers)?;
    Ok(Response::ok(content)?.with_headers(headers))
}

fn serve_static(content: &str, content_type: &str) -> Result<Response> {
    serve_static_with_cache(content, content_type, "public, max-age=3600")
}

#[event(fetch, respond_with_errors)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    let path = req.path();

    // Serve static files
    match path.as_str() {
        // The HTML shell drives version pinning of every other asset; serving
        // it from a stale cache hides post-incident asset rotations from
        // already-warmed browsers. Everything else can be cached normally.
        "/" | "/index.html" => {
            return serve_static_with_cache(INDEX_HTML, "text/html; charset=utf-8", "no-cache")
        }
        "/app.js" => return serve_static(APP_JS, "application/javascript; charset=utf-8"),
        "/crypto.js" => return serve_static(CRYPTO_JS, "application/javascript; charset=utf-8"),
        "/keystore.js" => return serve_static(KEYSTORE_JS, "application/javascript; charset=utf-8"),
        "/style.css" => return serve_static(STYLE_CSS, "text/css; charset=utf-8"),
        "/sw.js" => {
            let headers = Headers::new();
            headers.set("Content-Type", "application/javascript; charset=utf-8")?;
            headers.set("Service-Worker-Allowed", "/")?;
            apply_security_headers(&headers)?;
            return Ok(Response::ok(SW_JS)?.with_headers(headers));
        }
        "/manifest.json" => return serve_static(MANIFEST_JSON, "application/json"),
        "/vendor/marked.min.js" => return serve_static(MARKED_JS, "application/javascript; charset=utf-8"),
        "/vendor/purify.min.js" => return serve_static(DOMPURIFY_JS, "application/javascript; charset=utf-8"),
        "/vendor/Sortable.min.js" => return serve_static(SORTABLE_JS, "application/javascript; charset=utf-8"),
        "/favicon.ico" | "/favicon.png" | "/icon-192.png" | "/icon-512.png" | "/screenshot-wide.png" | "/screenshot-narrow.png" | "/logo.png" | "/badge.png" => {
            let data = match path.as_str() {
                "/favicon.ico" | "/favicon.png" => FAVICON,
                "/icon-192.png" => ICON_192,
                "/icon-512.png" => ICON_512,
                "/screenshot-wide.png" => SCREENSHOT_WIDE,
                "/screenshot-narrow.png" => SCREENSHOT_NARROW,
                "/logo.png" => LOGO,
                "/badge.png" => BADGE,
                _ => unreachable!(),
            };
            let headers = Headers::new();
            headers.set("Content-Type", "image/png")?;
            headers.set("Cache-Control", "public, max-age=86400")?;
            apply_security_headers(&headers)?;
            return Ok(Response::from_bytes(data.to_vec())?.with_headers(headers));
        }
        "/vapid-key" => {
            let private_key = env.secret("VAPID_PRIVATE_KEY")?.to_string();
            let public_key = webpush::vapid::get_public_key_b64(&private_key)?;
            let resp = Response::ok(public_key)?;
            apply_security_headers(resp.headers())?;
            return Ok(resp);
        }
        _ => {}
    }

    let resp = Router::new()
        .get_async("/vapid-key", routes::push::vapid_key)
        .post_async("/:topic", routes::publish::handle)
        .get_async("/:topic/json", routes::poll::handle)
        .get_async("/:topic/sse", routes::subscribe::handle)
        .delete_async("/:topic/messages", routes::poll::delete)
        .delete_async("/:topic/messages/:id", routes::poll::delete_one)
        .post_async("/:topic/push/subscribe", routes::push::subscribe)
        .delete_async("/:topic/push/subscribe", routes::push::unsubscribe)
        .run(req, env)
        .await?;
    // WebSocket upgrade responses (status 101) carry the protocol switch in
    // their headers — leave those alone. Everything else (JSON / plaintext)
    // gets the same baseline as static responses.
    if resp.status_code() != 101 {
        apply_security_headers(resp.headers())?;
    }
    Ok(resp)
}
