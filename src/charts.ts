import { CHARTS, VALUE_SHAPES } from "./catalog.generated";
import type { ChartDefinition, ChartProp, ValueShape } from "./types";

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
const valueShapes: Readonly<Record<string, ValueShape>> = VALUE_SHAPES;

export function isSupportedProp(prop: ChartProp): boolean {
  if (UNSUPPORTED_PROPS.has(prop.name) || prop.interactive) return false;
  return propShape(prop).kind !== "never";
}

export function propShape(prop: ChartProp): ValueShape {
  const shape = valueShapes[prop.type];
  if (!shape) throw new Error(`No generated value shape for ${prop.type}.`);
  return shape;
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
