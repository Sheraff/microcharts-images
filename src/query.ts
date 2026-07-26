import * as v from "valibot";
import { isSupportedProp, propShape } from "./charts";
import type { ChartDefinition, ChartProp, ValueShape } from "./types";

export const MAX_QUERY_BYTES = 15_000;

const MAX_DATA_BYTES = 256_000;
const MAX_PROPS_BYTES = 20_000;
const MAX_DATA_POINTS = 5_000;
const MAX_VALUE_NODES = 10_000;
const MAX_VALUE_DEPTH = 20;
const MAX_STRING_LENGTH = 4_096;

type QueryInput = Record<string, string | string[]>;
type ChartProps = Record<string, unknown>;

const finiteNumber = v.pipe(v.number(), v.finite("Numbers must be finite."));
const text = v.pipe(
  v.string(),
  v.maxLength(MAX_STRING_LENGTH, `Strings cannot exceed ${MAX_STRING_LENGTH} characters.`),
  v.check(isXmlText, "Strings must contain valid XML characters."),
);
const cssColor = v.pipe(
  text,
  v.check(isSafeColor, "Colors cannot contain external URLs or unsupported CSS."),
);
const valueSchemaCache = new Map<string, v.GenericSchema>();

export function createQuerySchema(
  chart: ChartDefinition,
): v.GenericSchema<QueryInput, ChartProps> {
  const entries: v.ObjectEntries = {};

  for (const prop of chart.props.filter(isSupportedProp)) {
    const shape = propShape(prop);
    const decoded = v.pipe(
      v.string(`Prop "${prop.name}" is required and must be provided once.`),
      v.rawTransform<string, unknown>((context) => {
        try {
          return decodeValue(context.dataset.value, prop.name, shape);
        } catch (error) {
          context.addIssue({
            message: error instanceof Error ? error.message : `Prop "${prop.name}" is invalid.`,
          });
          return context.NEVER;
        }
      }),
      schemaForProp(prop, shape),
    );
    entries[prop.name] = prop.required ? decoded : v.optional(decoded);
  }

  return v.pipe(
    v.strictObject(entries, `Unknown prop for ${chart.name}.`),
    v.rawCheck<ChartProps>((context) => {
      const issue = payloadIssue(context.dataset.value as ChartProps);
      if (issue) context.addIssue({ message: issue });
    }),
  ) as v.GenericSchema<QueryInput, ChartProps>;
}

function schemaForProp(prop: ChartProp, shape: ValueShape): v.GenericSchema {
  if (prop.name === "width" || prop.name === "height") {
    return v.pipe(
      finiteNumber,
      v.minValue(1, `Prop "${prop.name}" must be at least 1.`),
      v.maxValue(4_096, `Prop "${prop.name}" cannot exceed 4096.`),
    );
  }
  if (prop.name === "color") return cssColor;
  if (prop.name === "colors") return v.array(cssColor);
  const cached = valueSchemaCache.get(prop.type);
  if (cached) return cached;
  const schema = schemaFromShape(shape);
  valueSchemaCache.set(prop.type, schema);
  return schema;
}

function schemaFromShape(shape: ValueShape): v.GenericSchema {
  switch (shape.kind) {
    case "number":
      return finiteNumber;
    case "string":
      return text;
    case "boolean":
      return v.boolean();
    case "null":
      return v.null_();
    case "literal":
      return v.literal(shape.value);
    case "array":
      return v.array(schemaFromShape(shape.item));
    case "tuple":
      return v.strictTuple(
        shape.items.map(schemaFromShape) as [v.GenericSchema, ...v.GenericSchema[]],
      );
    case "object": {
      const entries: v.ObjectEntries = {};
      for (const field of shape.fields) {
        const schema = schemaFromShape(field.value);
        entries[field.name] = field.optional ? v.optional(schema) : schema;
      }
      return v.strictObject(entries);
    }
    case "record":
      return v.record(text, schemaFromShape(shape.value));
    case "union":
      return v.union(
        shape.options.map(schemaFromShape) as [
          v.GenericSchema,
          v.GenericSchema,
          ...v.GenericSchema[],
        ],
      );
    case "never":
      return v.never("Function props are not supported.");
    case "unknown":
      return v.unknown();
  }
}

function decodeValue(raw: string, propName: string, shape: ValueShape): unknown {
  const trimmed = raw.trimStart();
  if (expectsArray(shape) && !trimmed.startsWith("[")) {
    if (containsObject(shape) || !raw.includes(",")) {
      throw new Error(`Prop "${propName}" must be a JSON array.`);
    }
    return raw.split(",").map((part) => parsePrimitive(part.trim()));
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Prop "${propName}" contains invalid JSON.`);
    }
  }
  if (accepts(shape, "boolean") && (raw === "true" || raw === "false")) {
    return raw === "true";
  }
  if (accepts(shape, "null") && raw === "null") return null;
  if (accepts(shape, "number") && isJsonNumber(raw)) return Number(raw);
  return raw;
}

function parsePrimitive(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (isJsonNumber(raw)) return Number(raw);
  return raw;
}

function expectsArray(shape: ValueShape): boolean {
  if (shape.kind === "union") return shape.options.every(expectsArray);
  return shape.kind === "array" || shape.kind === "tuple";
}

function containsObject(shape: ValueShape): boolean {
  if (shape.kind === "union") return shape.options.some(containsObject);
  if (shape.kind === "array") return containsObject(shape.item);
  if (shape.kind === "tuple") return shape.items.some(containsObject);
  return shape.kind === "object" || shape.kind === "record";
}

function accepts(shape: ValueShape, kind: "number" | "boolean" | "null"): boolean {
  if (shape.kind === "union") return shape.options.some((option) => accepts(option, kind));
  if (shape.kind === kind) return true;
  return shape.kind === "literal" && kind !== "null" && typeof shape.value === kind;
}

function isJsonNumber(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
}

function payloadIssue(props: ChartProps): string | undefined {
  const { data, ...configuration } = props;
  if (jsonSize(data) > MAX_DATA_BYTES) return `Data exceeds ${MAX_DATA_BYTES / 1_000} kB.`;
  if (jsonSize(configuration) > MAX_PROPS_BYTES) {
    return `Chart configuration exceeds ${MAX_PROPS_BYTES / 1_000} kB.`;
  }
  if (Array.isArray(data) && data.length > MAX_DATA_POINTS) {
    return `Data exceeds ${MAX_DATA_POINTS} top-level points.`;
  }

  const stack = [{ value: props as unknown, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (++nodes > MAX_VALUE_NODES) return `Chart props exceed ${MAX_VALUE_NODES} values.`;
    if (depth > MAX_VALUE_DEPTH) return `Chart props exceed ${MAX_VALUE_DEPTH} nesting levels.`;
    if (typeof value === "number" && !Number.isFinite(value)) return "Numbers must be finite.";
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) return `Strings cannot exceed ${MAX_STRING_LENGTH} characters.`;
      if (!isXmlText(value)) return "Strings must contain valid XML characters.";
    } else if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) stack.push({ value: item, depth: depth + 1 });
    }
  }

  if (props.locale !== undefined) {
    try {
      Intl.getCanonicalLocales(props.locale as string | string[]);
    } catch {
      return 'Prop "locale" contains an invalid BCP 47 locale.';
    }
  }
}

function isXmlText(value: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value);
}

function isSafeColor(value: string): boolean {
  if (value.length > 100 || /[;{}\\<>]|url\s*\(/i.test(value)) return false;
  return !/^var\(/i.test(value) || /^var\(--mc-[a-z0-9-]+\)$/i.test(value);
}

function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
}
