import { CHARTS } from "./catalog.generated";
import type { ChartDefinition, ChartProp } from "./types";

const UNSUPPORTED_PROPS = new Set([
  "animate",
  "children",
  "className",
  "defaultSelectedIndex",
  "id",
  "live",
  "onActive",
  "onSelect",
  "readout",
  "selectedIndex",
  "seriesStrings",
  "strings",
  "style",
]);

export const charts = CHARTS as readonly ChartDefinition[];

export function isSupportedProp(prop: ChartProp): boolean {
  if (UNSUPPORTED_PROPS.has(prop.name) || prop.interactive) return false;
  const alternatives = splitAlternatives(prop.type);
  return !alternatives.every(isFunctionType);
}

export function publicPropType(prop: ChartProp): string {
  return prop.name === "width" || prop.name === "height" ? "number" : prop.type;
}

export function chartPaths(chart: ChartDefinition): string[] {
  return [...new Set([chart.name, chart.name.toLowerCase(), chart.slug])].flatMap((name) => [
    `/${name}`,
    `/${name}.svg`,
  ]);
}

function isFunctionType(type: string): boolean {
  return type.includes("=>") || type.trim() === "fn";
}

function splitAlternatives(type: string): string[] {
  return splitTopLevel(type, new Set(["|"]));
}

function splitTopLevel(source: string, separators: ReadonlySet<string>): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if ("([{<".includes(character)) depth++;
    if (")]}>".includes(character)) depth--;
    if (separators.has(character) && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

export { isFunctionType, splitAlternatives, splitTopLevel };
