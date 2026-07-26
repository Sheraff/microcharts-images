import { sValidator } from "@hono/standard-validator";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { LIBRARY_VERSION } from "./catalog.generated";
import { chartPaths, charts, isSupportedProp, publicPropType } from "./charts";
import { HttpError } from "./http-error";
import { createQuerySchema, MAX_QUERY_BYTES } from "./query";
import { renderChart } from "./render";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();
const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const querySizeLimit: MiddlewareHandler<AppEnv> = async (context, next) => {
  const search = new URL(context.req.url).search;
  if (new TextEncoder().encode(search).byteLength > MAX_QUERY_BYTES) {
    return problemResponse(
      context.req.raw,
      new HttpError(413, `The query string exceeds ${MAX_QUERY_BYTES / 1_000} kB.`),
    );
  }
  await next();
};

app.use("*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"] }));
app.use("*", async (context, next) => {
  if (!ALLOWED_METHODS.has(context.req.method)) {
    return problemResponse(
      context.req.raw,
      new HttpError(405, "Only GET, HEAD, and OPTIONS are supported."),
    );
  }
  await next();
});
app.options("*", (context) => context.body(null, 204));
app.on(["GET", "HEAD"], "/", (context) => homepageResponse(context.req.raw));
app.on(["GET", "HEAD"], "/catalog.json", (context) => catalogResponse(context.req.raw));

for (const chart of charts) {
  const paths = chartPaths(chart);
  if (!chart.svg) {
    app.on(["GET", "HEAD"], paths, (context) =>
      problemResponse(
        context.req.raw,
        new HttpError(406, `${chart.name} has an HTML root and is not available as SVG.`),
      ),
    );
    continue;
  }

  app.on(
    ["GET", "HEAD"],
    paths,
    querySizeLimit,
    sValidator("query", createQuerySchema(chart), (result, context) => {
      if (!result.success) {
        return problemResponse(
          context.req.raw,
          new HttpError(400, validationDetail(result.error[0])),
        );
      }
    }),
    async (context) => {
      const client = context.req.header("cf-connecting-ip") ?? "local";
      const rateLimit = await context.env.RATE_LIMITER.limit({ key: client });
      if (!rateLimit.success) throw new HttpError(429, "Render rate limit exceeded.");

      const props = (
        context.req as unknown as { valid(target: "query"): Record<string, unknown> }
      ).valid("query");
      const result = renderChart(chart, props);
      const etag = await createEtag(result.svg);
      const headers = imageHeaders(chart.slug, result.svg, etag);
      if (etagMatches(context.req.header("If-None-Match"), etag)) {
        headers.delete("Content-Length");
        return new Response(null, { status: 304, headers });
      }
      return new Response(context.req.method === "HEAD" ? null : result.svg, { headers });
    },
  );
}

app.notFound((context) =>
  problemResponse(context.req.raw, new HttpError(404, "No chart or service route matches this URL.")),
);

app.onError((error, context) => {
  if (error instanceof HttpError) return problemResponse(context.req.raw, error);
  console.error(error);
  return problemResponse(context.req.raw, new HttpError(500, "The chart could not be rendered."));
});

function validationDetail(issue: { message: string; path?: readonly unknown[] } | undefined): string {
  if (!issue) return "Invalid search parameters.";
  const segment = issue.path?.[0];
  const key =
    typeof segment === "object" && segment !== null && "key" in segment
      ? (segment as { key: PropertyKey }).key
      : segment;
  return key === undefined ? issue.message : `Invalid prop "${String(key)}": ${issue.message}`;
}

function imageHeaders(slug: string, svg: string, etag: string): Headers {
  return new Headers({
    "Cache-Control": "public, max-age=86400",
    "Cloudflare-CDN-Cache-Control": "public, max-age=31536000",
    "Content-Disposition": `inline; filename="${slug}.svg"`,
    "Content-Length": String(new TextEncoder().encode(svg).byteLength),
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cross-Origin-Resource-Policy": "cross-origin",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "X-Microcharts-Version": LIBRARY_VERSION,
  });
}

async function createEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hash}"`;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  return header.trim() === "*" || header.split(",").some((value) => normalize(value) === etag);
}

function homepageResponse(request: Request): Response {
  const examples = [
    ["Heat cell", "/HeatCell?value=42&domain=0,100&title=Load"],
    ["Sparkline", "/Sparkline?data=3,5,4,8,7,10&fill=true&title=Revenue"],
    ["Progress", "/Progress?value=68&max=100&label=percent&title=Upload"],
    ["Trend arrow", "/TrendArrow?value=-0.08&showValue=true&title=Latency"],
    [
      "Micro donut",
      "/MicroDonut?data=%5B%7B%22label%22%3A%22Used%22%2C%22value%22%3A72%7D%2C%7B%22label%22%3A%22Free%22%2C%22value%22%3A28%7D%5D&title=Storage",
    ],
  ] as const;
  const cards = examples
    .map(([name, path]) => {
      const escapedPath = escapeHtml(path);
      return `<figure><a href="${escapedPath}"><img src="${escapedPath}" alt="${name} example"></a><figcaption><strong>${name}</strong><code>${escapedPath}</code></figcaption></figure>`;
    })
    .join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>Microcharts Images</title>
<style>
body{max-width:70rem;margin:3rem auto;padding:0 1.25rem;font:16px/1.5 system-ui,sans-serif;color:#1a1917;background:#faf9f6}h1{margin-bottom:.25rem;font-size:clamp(2rem,7vw,4rem);letter-spacing:-.04em}header p{max-width:42rem;margin-top:0;color:#555}a{color:inherit}.examples{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1rem;margin:2.5rem 0}figure{margin:0;padding:1rem;border:1px solid #d8d5cf;border-radius:.35rem;background:white}figure a{display:grid;place-items:center;min-height:8rem}img{display:block;width:100%;height:7rem;object-fit:contain}figcaption{display:grid;gap:.4rem;margin-top:1rem}code{overflow-wrap:anywhere;font:12px/1.4 ui-monospace,monospace;color:#555}footer{padding-top:1rem;border-top:1px solid #d8d5cf;color:#555}
</style>
</head>
<body>
<header><h1>Microcharts Images</h1><p>Turn an <a href="https://microcharts.dev">@microcharts/react</a> component and URL query parameters into a standalone SVG. Use the image URL anywhere that accepts an <code>&lt;img&gt;</code>, Markdown image, or Open Graph image.</p></header>
<main><section class="examples" aria-label="Examples">${cards}</section></main>
<footer>${charts.filter((chart) => chart.svg).length} SVG charts in @microcharts/react ${LIBRARY_VERSION}. Browse every route and prop in <a href="/catalog.json">catalog.json</a>.</footer>
</body>
</html>`;
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function catalogResponse(request: Request): Response {
  return jsonResponse(
    request,
    {
      version: LIBRARY_VERSION,
      charts: charts.map((chart) => ({
        name: chart.name,
        slug: chart.slug,
        svg: chart.svg,
        dataShape: chart.dataShape,
        props: chart.props
          .filter(isSupportedProp)
          .map((prop) => ({ name: prop.name, type: publicPropType(prop), required: prop.required })),
        sample: chart.sample,
      })),
    },
    "public, max-age=86400",
  );
}

function jsonResponse(request: Request, body: unknown, cacheControl: string): Response {
  return new Response(request.method === "HEAD" ? null : `${JSON.stringify(body, null, 2)}\n`, {
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function problemResponse(request: Request, error: HttpError): Response {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
  if (error.status === 405) headers.Allow = "GET, HEAD, OPTIONS";
  if (error.status === 429) headers["Retry-After"] = "60";
  return new Response(
    request.method === "HEAD"
      ? null
      : `${JSON.stringify({
          type: "about:blank",
          title: error.title,
          status: error.status,
          detail: error.message,
        })}\n`,
    { status: error.status, headers },
  );
}

export default app;
