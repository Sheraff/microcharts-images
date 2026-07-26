import { DOMParser } from "@xmldom/xmldom";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHARTS, LIBRARY_VERSION } from "../src/catalog.generated";

const BASE_URL = "https://images.example.test";

function request(path: string, index = 1, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "cf-connecting-ip": `192.0.2.${index}`,
      ...init?.headers,
    },
  });
}

function chartUrl(name: string, props: Readonly<Record<string, unknown>>): string {
  const url = new URL(`/${name}`, BASE_URL);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return `${url.pathname}${url.search}`;
}

describe("SVG API", () => {
  it("renders the documented HeatCell request", async () => {
    const response = await request("/HeatCell?value=42&domain=0,100&title=Load");
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("x-microcharts-version")).toBe(LIBRARY_VERSION);
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(response.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("<style>");
    expect(svg).toContain('syntax: "<number>"');
    expect(svg).toContain("<title>Load</title>");
    expect(() =>
      new DOMParser({
        onError: (level, message) => {
          throw new Error(`${level}: ${message}`);
        },
      }).parseFromString(svg, "image/svg+xml"),
    ).not.toThrow();
  });

  it("accepts slugs and an explicit .svg extension", async () => {
    const response = await request("/heat-cell.svg?value=0.5", 2);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("mc-heat-cell");
  });

  it("accepts JSON arrays for series data", async () => {
    const response = await request("/Sparkline?data=%5B3%2C5%2C4%2C8%5D&title=Revenue", 3);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Revenue");
  });

  it("supports HEAD and conditional requests", async () => {
    const first = await request("/HeatCell?value=0.25&title=Conditional", 4);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const conditional = await request("/HeatCell?value=0.25&title=Conditional", 4, {
      headers: { "If-None-Match": etag! },
    });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");

    const head = await request("/HeatCell?value=0.25&title=Head", 4, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBeTruthy();
    expect(await head.text()).toBe("");
  });

  it.each([
    ["missing required props", "/HeatCell", 400],
    ["unknown props", "/HeatCell?value=1&wat=1", 400],
    ["duplicate props", "/HeatCell?value=1&value=2", 400],
    ["invalid tuples", "/HeatCell?value=1&domain=100", 400],
    ["wrong tuple lengths", "/HeatCell?value=1&domain=0,50,100", 400],
    ["wrong array values", "/Sparkline?data=%5B%22not-a-number%22%5D", 400],
    ["XML control characters", "/HeatCell?value=1&title=%00", 400],
    ["unsafe colors", "/HeatCell?value=1&color=url(https%3A%2F%2Fexample.com)", 400],
    ["HTML-rooted charts", "/Delta?value=0.1", 406],
    ["unsupported formats", "/HeatCell.png?value=1", 406],
    ["unknown charts", "/NotAChart?value=1", 404],
  ])("rejects %s", async (_case, path, status) => {
    const response = await request(path, 5);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unsafe static props", async () => {
    const response = await request("/Sparkline?data=1,2,3&style=%7B%7D", 6);
    expect(response.status).toBe(400);
    const problem = (await response.json()) as { detail: string };
    expect(problem.detail).toContain('Invalid prop "style"');
  });

  it("rejects unsafe color arrays", async () => {
    const response = await request(
      "/MicroDonut?data=%5B1%2C2%5D&colors=%5B%22url(https%3A%2F%2Fexample.com)%22%5D",
      6,
    );
    expect(response.status).toBe(400);
  });

  it("requires deterministic dates for CalendarStrip", async () => {
    const response = await request("/CalendarStrip?data=%5B%5D", 6);
    expect(response.status).toBe(400);
    const problem = (await response.json()) as { detail: string };
    expect(problem.detail).toContain('"end"');
  });

  it("supports weak, wildcard, and list ETag matching", async () => {
    const first = await request("/HeatCell?value=0.75&title=ETags", 6);
    const etag = first.headers.get("etag")!;

    for (const value of [`W/${etag}`, `"other", ${etag}`, "*"]) {
      const response = await request("/HeatCell?value=0.75&title=ETags", 6, {
        headers: { "If-None-Match": value },
      });
      expect(response.status).toBe(304);
    }
  });
});

describe("discovery endpoints", () => {
  it("describes the service", async () => {
    const response = await request("/", 7);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.version).toBe(LIBRARY_VERSION);
    expect(body.supportedCharts).toBe(104);
  });

  it("publishes the catalog", async () => {
    const response = await request("/catalog.json", 8);
    const body = (await response.json()) as { charts: Array<{ svg: boolean }> };
    expect(response.status).toBe(200);
    expect(body.charts).toHaveLength(106);
    expect(body.charts.filter((chart) => chart.svg)).toHaveLength(104);
    const heatCell = (body.charts as Array<{ name?: string; props?: Array<{ name: string }> }>).find(
      (chart) => chart.name === "HeatCell",
    );
    expect(heatCell?.props?.some((prop) => prop.name === "style")).toBe(false);
  });

  it("handles CORS and methods", async () => {
    const options = await request("/HeatCell", 9, { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");

    const post = await request("/HeatCell", 9, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("catalog samples", () => {
  const svgCharts = CHARTS.filter((chart) => chart.svg);

  it("has a sample for every SVG chart", () => {
    expect(svgCharts.every((chart) => chart.sample !== undefined)).toBe(true);
  });

  it.each(svgCharts.map((chart, index) => [chart.name, chart, index] as const))(
    "renders %s",
    async (_name, chart, index) => {
      const response = await request(chartUrl(chart.name, chart.sample ?? {}), (index % 240) + 10);
      const svg = await response.text();
      expect(response.status, svg).toBe(200);
      expect(svg).toMatch(/^<svg\b/);
      expect(svg).toContain("<style>");
    },
  );
});
