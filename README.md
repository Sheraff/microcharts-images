# Microcharts Images

A Cloudflare Worker that renders [`@microcharts/react`](https://microcharts.dev/) components as standalone SVG images.

```text
/HeatCell?value=42&domain=0,100&title=Load
```

The Worker supports all 104 SVG-rooted Microcharts components. `Delta` and `TokenConfidence` have HTML roots and return `406 Not Acceptable` until raster output is added.

## API

Use either the React component name or its kebab-case slug. The `.svg` extension is optional.

```text
/HeatCell?value=42&domain=0,100&title=Load
/heat-cell.svg?value=42&domain=0,100&label=value
/Sparkline?data=[3,5,4,8,6,9]&title=Revenue
```

Primitive props use their normal URL representation. Numeric arrays and tuples accept comma-separated shorthand. Nested arrays and objects must be JSON and should be URL encoded by clients.

```ts
const url = new URL("https://microcharts-images.example/Sparkline");
url.searchParams.set("data", JSON.stringify([3, 5, 4, 8, 6, 9]));
url.searchParams.set("title", "Weekly revenue");
```

`title` is the chart's accessible SVG title, not visible text. Consumers should still set `alt` when embedding the response with `<img>`.

`GET /catalog.json` lists components, accepted URL props, data shapes, and sample props. `GET /` returns basic service metadata.

## Responses

Successful chart requests return self-contained `image/svg+xml` with:

- Embedded Microcharts CSS
- An SVG namespace
- CORS and cross-origin image headers
- A content security policy
- A SHA-256 ETag
- One-day browser caching and one-year Cloudflare edge caching

Errors use `application/problem+json`. Only `GET`, `HEAD`, and `OPTIONS` are accepted.

The Worker limits valid cache-miss render attempts to 120 per client per minute in each Cloudflare location. Cached responses bypass Worker execution and do not consume this quota.

## Limits

- Query string: 15 kB
- Top-level data points: 5,000
- Data JSON: 256 kB
- Configuration JSON: 20 kB
- Nested values: 10,000 across 20 levels
- SVG output: 512 kB
- Dimensions: 1 to 4,096 units

Function, interactive, child, custom style, and translation-table props are rejected because they cannot safely cross a URL boundary.

## Development

Requires Node.js 20 or newer and pnpm.

```sh
pnpm install
pnpm dev
pnpm test
pnpm check
```

`pnpm generate` builds the static component registry, URL metadata, and embedded stylesheet from the installed React package and the committed catalog snapshot. Generated artifacts are committed and checked for drift in CI.

Regenerate Cloudflare binding and runtime types after changing `wrangler.jsonc`:

```sh
pnpm types
```

Build and deploy with Wrangler:

```sh
pnpm build
pnpm deploy
```
