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
app.options("*", (context) => context.body(null, 204));
app.on(["GET", "HEAD"], "/", (context) => informationalResponse(context.req.raw));
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

app.on(["GET", "HEAD"], "*", (context) => {
  const identifier = unknownIdentifier(context.req.path);
  const chartName = identifier.toLowerCase().endsWith(".svg") ? identifier.slice(0, -4) : identifier;
  const status = chartName.includes(".") ? 406 : 404;
  const detail = status === 406 ? "Only SVG output is currently supported." : `Unknown chart "${chartName}".`;
  return problemResponse(context.req.raw, new HttpError(status, detail));
});
app.all("*", (context) =>
  problemResponse(
    context.req.raw,
    new HttpError(405, "Only GET, HEAD, and OPTIONS are supported."),
  ),
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

function unknownIdentifier(pathname: string): string {
  try {
    return decodeURIComponent(pathname.slice(1));
  } catch {
    throw new HttpError(400, "The chart path is not valid URL encoding.");
  }
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

function informationalResponse(request: Request): Response {
  return jsonResponse(
    request,
    {
      name: "Microcharts Images",
      description: "Render @microcharts/react components as standalone SVG images.",
      version: LIBRARY_VERSION,
      example: "/HeatCell?value=42&domain=0,100&title=Load",
      catalog: "/catalog.json",
      supportedCharts: charts.filter((chart) => chart.svg).length,
    },
    "public, max-age=3600",
  );
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
