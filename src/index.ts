import { LIBRARY_VERSION } from "./catalog.generated";
import { HttpError } from "./http-error";
import { isSupportedProp, listCharts, parseProps, publicPropType, resolveChart } from "./request";
import { renderChart } from "./render";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
} as const;

export default {
  async fetch(request, env): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "Only GET, HEAD, and OPTIONS are supported.");
      }

      const url = new URL(request.url);
      if (url.pathname === "/") return informationalResponse(request);
      if (url.pathname === "/catalog.json") return catalogResponse(request);

      const identifier = chartIdentifier(url.pathname);
      const chart = resolveChart(identifier);
      if (!chart) throw new HttpError(404, `Unknown chart "${identifier}".`);
      if (!chart.svg) {
        throw new HttpError(406, `${chart.name} has an HTML root and is not available as SVG.`);
      }

      const props = parseProps(url, chart);
      const client = request.headers.get("cf-connecting-ip") ?? "local";
      const rateLimit = await env.RATE_LIMITER.limit({ key: client });
      if (!rateLimit.success) throw new HttpError(429, "Render rate limit exceeded.");

      const result = renderChart(chart, props);
      const etag = await createEtag(result.svg);
      const headers = imageHeaders(chart.slug, result.svg, etag);

      if (etagMatches(request.headers.get("If-None-Match"), etag)) {
        headers.delete("Content-Length");
        return new Response(null, { status: 304, headers });
      }

      return new Response(request.method === "HEAD" ? null : result.svg, { headers });
    } catch (error) {
      if (error instanceof HttpError) return problemResponse(request, error);
      console.error(error);
      return problemResponse(request, new HttpError(500, "The chart could not be rendered."));
    }
  },
} satisfies ExportedHandler<Env>;

function chartIdentifier(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(1));
  } catch {
    throw new HttpError(400, "The chart path is not valid URL encoding.");
  }
  if (!decoded || decoded.includes("/")) throw new HttpError(404, "Expected /{componentName}.");
  if (decoded.toLowerCase().endsWith(".svg")) return decoded.slice(0, -4);
  if (decoded.includes(".")) {
    throw new HttpError(406, "Only SVG output is currently supported.");
  }
  return decoded;
}

function imageHeaders(slug: string, svg: string, etag: string): Headers {
  return new Headers({
    ...CORS_HEADERS,
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

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  return header.trim() === "*" || header.split(",").some((value) => normalize(value) === etag);
}

function informationalResponse(request: Request): Response {
  const body = {
    name: "Microcharts Images",
    description: "Render @microcharts/react components as standalone SVG images.",
    version: LIBRARY_VERSION,
    example: "/HeatCell?value=42&domain=0,100&title=Load",
    catalog: "/catalog.json",
    supportedCharts: listCharts().filter((chart) => chart.svg).length,
  };
  return jsonResponse(request, body, "public, max-age=3600");
}

function catalogResponse(request: Request): Response {
  const body = {
    version: LIBRARY_VERSION,
    charts: listCharts().map((chart) => ({
      name: chart.name,
      slug: chart.slug,
      svg: chart.svg,
      dataShape: chart.dataShape,
      props: chart.props
        .filter(isSupportedProp)
        .map((prop) => ({ name: prop.name, type: publicPropType(prop), required: prop.required })),
      sample: chart.sample,
    })),
  };
  return jsonResponse(request, body, "public, max-age=86400");
}

function jsonResponse(request: Request, body: unknown, cacheControl: string): Response {
  const json = `${JSON.stringify(body, null, 2)}\n`;
  return new Response(request.method === "HEAD" ? null : json, {
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": cacheControl,
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function problemResponse(request: Request, error: HttpError): Response {
  const json = `${JSON.stringify({
    type: "about:blank",
    title: error.title,
    status: error.status,
    detail: error.message,
  })}\n`;
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
  if (error.status === 405) headers.Allow = "GET, HEAD, OPTIONS";
  if (error.status === 429) headers["Retry-After"] = "60";
  return new Response(request.method === "HEAD" ? null : json, {
    status: error.status,
    headers,
  });
}
