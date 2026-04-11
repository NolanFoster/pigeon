use worker::*;

mod db;
mod durable;
mod models;
mod routes;
mod webpush;

// Embed static files directly in the binary
const INDEX_HTML: &str = include_str!("../public/index.html");
const APP_JS: &str = include_str!("../public/app.js");
const STYLE_CSS: &str = include_str!("../public/style.css");
const SW_JS: &str = include_str!("../public/sw.js");
const MANIFEST_JSON: &str = include_str!("../public/manifest.json");
const ICON_192: &[u8] = include_bytes!("../public/icon-192.png");
const ICON_512: &[u8] = include_bytes!("../public/icon-512.png");
const SCREENSHOT_WIDE: &[u8] = include_bytes!("../public/screenshot-wide.png");
const SCREENSHOT_NARROW: &[u8] = include_bytes!("../public/screenshot-narrow.png");
const FAVICON: &[u8] = include_bytes!("../public/favicon.png");

fn serve_static(content: &str, content_type: &str) -> Result<Response> {
    let headers = Headers::new();
    headers.set("Content-Type", content_type)?;
    headers.set("Cache-Control", "public, max-age=3600")?;
    Ok(Response::ok(content)?.with_headers(headers))
}

#[event(fetch, respond_with_errors)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    let path = req.path();

    // Serve static files
    match path.as_str() {
        "/" | "/index.html" => return serve_static(INDEX_HTML, "text/html; charset=utf-8"),
        "/app.js" => return serve_static(APP_JS, "application/javascript; charset=utf-8"),
        "/style.css" => return serve_static(STYLE_CSS, "text/css; charset=utf-8"),
        "/sw.js" => {
            let headers = Headers::new();
            headers.set("Content-Type", "application/javascript; charset=utf-8")?;
            headers.set("Service-Worker-Allowed", "/")?;
            return Ok(Response::ok(SW_JS)?.with_headers(headers));
        }
        "/manifest.json" => return serve_static(MANIFEST_JSON, "application/json"),
        "/favicon.ico" | "/favicon.png" | "/icon-192.png" | "/icon-512.png" | "/screenshot-wide.png" | "/screenshot-narrow.png" => {
            let data = match path.as_str() {
                "/favicon.ico" | "/favicon.png" => FAVICON,
                "/icon-192.png" => ICON_192,
                "/icon-512.png" => ICON_512,
                "/screenshot-wide.png" => SCREENSHOT_WIDE,
                "/screenshot-narrow.png" => SCREENSHOT_NARROW,
                _ => unreachable!(),
            };
            let headers = Headers::new();
            headers.set("Content-Type", "image/png")?;
            headers.set("Cache-Control", "public, max-age=86400")?;
            return Ok(Response::from_bytes(data.to_vec())?.with_headers(headers));
        }
        "/vapid-key" => {
            let private_key = env.secret("VAPID_PRIVATE_KEY")?.to_string();
            let public_key = webpush::vapid::get_public_key_b64(&private_key)?;
            return Response::ok(public_key);
        }
        _ => {}
    }

    Router::new()
        .get_async("/vapid-key", routes::push::vapid_key)
        .post_async("/:topic", routes::publish::handle)
        .get_async("/:topic/json", routes::poll::handle)
        .get_async("/:topic/sse", routes::subscribe::handle)
        .post_async("/:topic/push/subscribe", routes::push::subscribe)
        .delete_async("/:topic/push/subscribe", routes::push::unsubscribe)
        .run(req, env)
        .await
}
