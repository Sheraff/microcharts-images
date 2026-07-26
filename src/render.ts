import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMPONENTS } from "./registry.generated";
import STYLES from "./styles.generated.css" with { type: "text" };
import { HttpError } from "./http-error";
import type { ChartDefinition } from "./types";

const MAX_OUTPUT_BYTES = 512_000;
const MAX_DIMENSION = 4_096;

export interface RenderResult {
  svg: string;
  width: number;
  height: number;
}

export function renderChart(
  chart: ChartDefinition,
  props: Record<string, unknown>,
): RenderResult {
  const component = COMPONENTS[chart.slug];
  if (!component) {
    throw new HttpError(406, `${chart.name} has an HTML root and is not available as SVG.`);
  }

  let markup: string;
  try {
    markup = renderToStaticMarkup(createElement(component, props));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown rendering error";
    throw new HttpError(400, `${chart.name} could not render these props: ${message}`);
  }

  const rootTag = /^<svg\b[^>]*>/.exec(markup)?.[0];
  if (!rootTag) throw new Error(`${chart.name} did not render an SVG root.`);

  if (!/\bxmlns=/.test(rootTag)) {
    markup = markup.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const rootEnd = markup.indexOf(">") + 1;
  const styles = STYLES.replaceAll("]]>", "]]]]><![CDATA[>");
  markup = `${markup.slice(0, rootEnd)}<style><![CDATA[${styles}]]></style>${markup.slice(rootEnd)}`;

  const bytes = new TextEncoder().encode(markup).byteLength;
  if (bytes > MAX_OUTPUT_BYTES) {
    throw new HttpError(413, `${chart.name} produced more than ${MAX_OUTPUT_BYTES / 1_000} kB of SVG.`);
  }

  const size = extractSize(rootTag);
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > MAX_DIMENSION ||
    size.height > MAX_DIMENSION
  ) {
    throw new HttpError(
      400,
      `${chart.name} produced an invalid ${size.width}x${size.height} image. Dimensions must be from 1 to ${MAX_DIMENSION}.`,
    );
  }

  return { svg: markup, ...size };
}

function extractSize(rootTag: string): { width: number; height: number } {
  const width = /\bwidth="([\d.]+)"/.exec(rootTag)?.[1];
  const height = /\bheight="([\d.]+)"/.exec(rootTag)?.[1];
  if (width !== undefined && height !== undefined) {
    return { width: Number(width), height: Number(height) };
  }

  const viewBox = /\bviewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"/.exec(rootTag);
  return {
    width: Number(viewBox?.[1] ?? 0),
    height: Number(viewBox?.[2] ?? 0),
  };
}
