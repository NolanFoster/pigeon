use worker::*;

pub async fn serve_index(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let kv = ctx.kv("__STATIC_CONTENT")?;
    match kv.get("index.html").text().await? {
        Some(html) => {
            let headers = Headers::new();
            headers.set("Content-Type", "text/html; charset=utf-8")?;
            Ok(Response::ok(html)?.with_headers(headers))
        }
        None => Response::error("Not found", 404),
    }
}
