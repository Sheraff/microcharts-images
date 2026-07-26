import { CHARTS } from "./catalog.generated";
import { HttpError } from "./http-error";
import type { ChartDefinition, ChartProp } from "./types";

const MAX_QUERY_BYTES = 15_000;
const MAX_DATA_BYTES = 256_000;
const MAX_PROPS_BYTES = 20_000;
const MAX_DATA_POINTS = 5_000;
const MAX_VALUE_NODES = 10_000;
const MAX_VALUE_DEPTH = 20;
const MAX_STRING_LENGTH = 4_096;

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

const chartDefinitions = CHARTS as readonly ChartDefinition[];
const chartsByIdentifier = new Map<string, ChartDefinition>();

for (const chart of chartDefinitions) {
  chartsByIdentifier.set(chart.name.toLowerCase(), chart);
  chartsByIdentifier.set(chart.slug.toLowerCase(), chart);
}

export function listCharts(): readonly ChartDefinition[] {
  return chartDefinitions;
}

export function resolveChart(identifier: string): ChartDefinition | undefined {
  return chartsByIdentifier.get(identifier.toLowerCase());
}

export function isSupportedProp(prop: ChartProp): boolean {
  if (UNSUPPORTED_PROPS.has(prop.name) || prop.interactive) return false;
  const alternatives = splitAlternatives(prop.type);
  return alternatives.length === 0 || !alternatives.every(isFunctionType);
}

export function publicPropType(prop: ChartProp): string {
  return prop.name === "width" || prop.name === "height" ? "number" : prop.type;
}

export function parseProps(url: URL, chart: ChartDefinition): Record<string, unknown> {
  if (new TextEncoder().encode(url.search).byteLength > MAX_QUERY_BYTES) {
    throw new HttpError(413, `The query string exceeds ${MAX_QUERY_BYTES / 1_000} kB.`);
  }

  const declared = new Map(chart.props.map((prop) => [prop.name, prop]));
  const props: Record<string, unknown> = {};

  url.searchParams.forEach((raw, name) => {
    if (Object.hasOwn(props, name)) {
      throw new HttpError(400, `Prop "${name}" was provided more than once.`);
    }

    const definition = declared.get(name);
    if (!definition) {
      throw new HttpError(400, `Unknown prop "${name}" for ${chart.name}.`);
    }
    assertSupported(definition);
    props[name] = parseValue(raw, definition);
  });

  const missing = chart.props
    .filter((prop) => prop.required && !UNSUPPORTED_PROPS.has(prop.name))
    .filter((prop) => props[prop.name] === undefined)
    .map((prop) => prop.name);
  if (missing.length > 0) {
    throw new HttpError(
      400,
      `${chart.name} requires ${missing.map((name) => `"${name}"`).join(", ")}. Expected data shape: ${chart.dataShape}.`,
    );
  }

  validatePayload(props);
  return props;
}

function assertSupported(prop: ChartProp): void {
  if (UNSUPPORTED_PROPS.has(prop.name) || prop.interactive) {
    throw new HttpError(400, `Prop "${prop.name}" is not available for static image rendering.`);
  }

  const alternatives = splitAlternatives(prop.type);
  if (alternatives.length > 0 && alternatives.every(isFunctionType)) {
    throw new HttpError(400, `Prop "${prop.name}" requires a function and cannot be passed in a URL.`);
  }
}

function isFunctionType(type: string): boolean {
  return type.includes("=>") || type.trim() === "fn";
}

function parseValue(raw: string, prop: ChartProp): unknown {
  const type = prop.type.trim();
  const arrayExpected = splitAlternatives(type).every((alternative) =>
    isArrayType(alternative.trim()),
  );

  if (arrayExpected && !raw.trimStart().startsWith("[")) {
    if (type.includes("{") || !raw.includes(",")) {
      throw new HttpError(400, `Prop "${prop.name}" must be a JSON array.`);
    }
    const value = raw.split(",").map((part) => parsePrimitive(part.trim()));
    assertMatchesType(value, prop);
    return value;
  }

  let value: unknown;
  if (raw.startsWith("[") || raw.startsWith("{") || raw.startsWith('"')) {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new HttpError(400, `Prop "${prop.name}" contains invalid JSON.`);
    }
  } else if (allowsBoolean(type) && (raw === "true" || raw === "false")) {
    value = raw === "true";
  } else if (allowsNull(type) && raw === "null") {
    value = null;
  } else if (allowsNumber(type) && isJsonNumber(raw)) {
    value = Number(raw);
  } else {
    value = raw;
  }

  assertMatchesType(value, prop);
  return value;
}

function parsePrimitive(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (isJsonNumber(raw)) return Number(raw);
  return raw;
}

function isJsonNumber(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
}

function isArrayType(type: string): boolean {
  return type.startsWith("[") || type.endsWith("[]") || type.startsWith("Array<");
}

function allowsBoolean(type: string): boolean {
  return /\bboolean\b|(?:^|\|)\s*(?:true|false)\s*(?:\||$)/.test(type);
}

function allowsNull(type: string): boolean {
  return /\bnull\b/.test(type);
}

function allowsNumber(type: string): boolean {
  return /\bnumber\b|(?:^|\|)\s*-?\d+(?:\.\d+)?\s*(?:\||$)/.test(type);
}

function assertMatchesType(value: unknown, prop: ChartProp): void {
  if (matchesAnyType(value, prop.type)) return;

  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  throw new HttpError(400, `Prop "${prop.name}" must be ${prop.type}; received ${actual}.`);
}

function matchesAnyType(value: unknown, type: string): boolean {
  return splitAlternatives(type).some((alternative) => matchesType(value, alternative.trim()));
}

function matchesType(value: unknown, type: string): boolean {
  if (type.startsWith("readonly ")) type = type.slice("readonly ".length).trim();
  if (!type || type === "unknown" || type.includes("per chart")) return true;
  if (isFunctionType(type)) return false;
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) return false;
    const elementType = type.slice(0, -2).trim();
    return value.every((item) => matchesAnyType(item, elementType));
  }
  if (type.startsWith("Array<") && type.endsWith(">")) {
    if (!Array.isArray(value)) return false;
    const elementType = type.slice("Array<".length, -1);
    return value.every((item) => matchesAnyType(item, elementType));
  }
  if (type.startsWith("[") && type.endsWith("]")) {
    if (!Array.isArray(value)) return false;
    const elements = splitTopLevel(type.slice(1, -1), new Set([","]));
    return value.length === elements.length && value.every((item, index) => matchesAnyType(item, elements[index]));
  }
  if (type.startsWith("(") && type.endsWith(")")) {
    return matchesAnyType(value, type.slice(1, -1));
  }
  if (type.startsWith("{") && type.endsWith("}")) {
    return matchesObject(value, type.slice(1, -1));
  }
  if (type.startsWith("Record<") || type.startsWith("Intl.")) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (type === "number") return typeof value === "number";
  if (type === "string" || type === "Date") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  if (type === "true") return value === true;
  if (type === "false") return value === false;
  if (["min", "max", "lo", "hi", "start", "end", "TL", "TR", "BL", "BR"].includes(type)) {
    return typeof value === "number";
  }
  if (/^-?\d+(?:\.\d+)?$/.test(type)) return value === Number(type);
  if (/^".*"$/.test(type)) {
    try {
      return value === JSON.parse(type);
    } catch {
      return false;
    }
  }
  return true;
}

function matchesObject(value: unknown, fieldsSource: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = splitTopLevel(fieldsSource, new Set([",", ";"]));

  return fields.every((field) => {
    const match = /^([A-Za-z_$][\w$]*)(\?)?(?:\s*:\s*(.+))?$/.exec(field.trim());
    if (!match) return true;
    const [, name, optional, nestedType] = match;
    if (!Object.hasOwn(record, name)) return optional === "?";
    return nestedType === undefined || matchesAnyType(record[name], nestedType);
  });
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

function splitAlternatives(type: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < type.length; index++) {
    const character = type[index];
    if ("([{<".includes(character)) depth++;
    if (")]}>".includes(character)) depth--;
    if (character === "|" && depth === 0) {
      alternatives.push(type.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(type.slice(start));
  return alternatives;
}

function validatePayload(props: Record<string, unknown>): void {
  const dataBytes = jsonSize(props.data);
  const { data: _, ...configuration } = props;
  if (dataBytes > MAX_DATA_BYTES) {
    throw new HttpError(413, `Data exceeds ${MAX_DATA_BYTES / 1_000} kB.`);
  }
  if (jsonSize(configuration) > MAX_PROPS_BYTES) {
    throw new HttpError(413, `Chart configuration exceeds ${MAX_PROPS_BYTES / 1_000} kB.`);
  }
  if (Array.isArray(props.data) && props.data.length > MAX_DATA_POINTS) {
    throw new HttpError(413, `Data exceeds ${MAX_DATA_POINTS} top-level points.`);
  }

  let nodes = 0;
  validateJson(props, 0, () => {
    nodes++;
    if (nodes > MAX_VALUE_NODES) {
      throw new HttpError(413, `Chart props exceed ${MAX_VALUE_NODES} values.`);
    }
  });

  for (const dimension of ["width", "height"] as const) {
    const value = props[dimension];
    if (value !== undefined && (typeof value !== "number" || value < 1 || value > 4_096)) {
      throw new HttpError(400, `Prop "${dimension}" must be a number from 1 to 4096.`);
    }
  }

  if (props.color !== undefined) validateColor(props.color);
  if (props.colors !== undefined) {
    if (!Array.isArray(props.colors)) throw new HttpError(400, 'Prop "colors" must be an array.');
    for (const color of props.colors) validateColor(color);
  }
  if (props.locale !== undefined) validateLocale(props.locale);
}

function validateJson(value: unknown, depth: number, visit: () => void): void {
  visit();
  if (depth > MAX_VALUE_DEPTH) {
    throw new HttpError(413, `Chart props exceed the maximum nesting depth of ${MAX_VALUE_DEPTH}.`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new HttpError(400, "All numbers must be finite.");
  }
  if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
    throw new HttpError(413, `A string prop exceeds ${MAX_STRING_LENGTH} characters.`);
  }
  if (typeof value === "string" && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value)) {
    throw new HttpError(400, "String props must contain valid XML characters.");
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1, visit);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) validateJson(item, depth + 1, visit);
  }
}

function validateColor(value: unknown): void {
  if (typeof value !== "string") throw new HttpError(400, 'Prop "color" must be a string.');
  if (value.length > 100 || /[;{}\\<>]|url\s*\(/i.test(value)) {
    throw new HttpError(400, 'Prop "color" contains unsupported CSS.');
  }
  if (/^var\(/i.test(value) && !/^var\(--mc-[a-z0-9-]+\)$/i.test(value)) {
    throw new HttpError(400, 'Prop "color" may only reference a built-in --mc-* variable.');
  }
}

function validateLocale(value: unknown): void {
  if (typeof value !== "string" && !Array.isArray(value)) {
    throw new HttpError(400, 'Prop "locale" must be a locale string or JSON string array.');
  }
  try {
    Intl.getCanonicalLocales(value as string | string[]);
  } catch {
    throw new HttpError(400, 'Prop "locale" contains an invalid BCP 47 locale.');
  }
}

function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
}
