import * as v from "valibot";
import { isFunctionType, isSupportedProp, splitAlternatives, splitTopLevel } from "./charts";
import type { ChartDefinition, ChartProp } from "./types";

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
const typeSchemaCache = new Map<string, v.GenericSchema>();

export function createQuerySchema(
  chart: ChartDefinition,
): v.GenericSchema<QueryInput, ChartProps> {
  const entries: v.ObjectEntries = {};

  for (const prop of chart.props.filter(isSupportedProp)) {
    const decoded = v.pipe(
      v.string(`Prop "${prop.name}" is required and must be provided once.`),
      v.rawTransform<string, unknown>((context) => {
        try {
          return decodeValue(context.dataset.value, prop);
        } catch (error) {
          context.addIssue({
            message: error instanceof Error ? error.message : `Prop "${prop.name}" is invalid.`,
          });
          return context.NEVER;
        }
      }),
      schemaForProp(prop),
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

function schemaForProp(prop: ChartProp): v.GenericSchema {
  if (prop.name === "width" || prop.name === "height") {
    return v.pipe(
      finiteNumber,
      v.minValue(1, `Prop "${prop.name}" must be at least 1.`),
      v.maxValue(4_096, `Prop "${prop.name}" cannot exceed 4096.`),
    );
  }
  if (prop.name === "color") return cssColor;
  if (prop.name === "colors") return v.array(cssColor);
  return schemaFromType(prop.type);
}

function schemaFromType(type: string): v.GenericSchema {
  type = type.trim();
  const cached = typeSchemaCache.get(type);
  if (cached) return cached;

  const alternatives = splitAlternatives(type);
  let schema: v.GenericSchema;
  if (alternatives.length > 1) {
    schema = v.union(
      alternatives.map(schemaFromSingleType) as [
        v.GenericSchema,
        v.GenericSchema,
        ...v.GenericSchema[],
      ],
    );
  } else {
    schema = schemaFromSingleType(type);
  }
  typeSchemaCache.set(type, schema);
  return schema;
}

function schemaFromSingleType(type: string): v.GenericSchema {
  type = type.trim();
  if (type.startsWith("readonly ")) return schemaFromType(type.slice("readonly ".length));
  if (!type || type === "unknown" || type.includes("per chart")) return v.unknown();
  if (isFunctionType(type)) return v.never("Function props are not supported.");
  if (type.endsWith("[]")) return v.array(schemaFromType(type.slice(0, -2)));
  if (type.startsWith("Array<") && type.endsWith(">")) {
    return v.array(schemaFromType(type.slice("Array<".length, -1)));
  }
  if (type.startsWith("[") && type.endsWith("]")) {
    return v.strictTuple(
      splitTopLevel(type.slice(1, -1), new Set([","])).map(schemaFromType) as [
        v.GenericSchema,
        ...v.GenericSchema[],
      ],
    );
  }
  if (type.startsWith("(") && type.endsWith(")")) {
    return schemaFromType(type.slice(1, -1));
  }
  if (type.startsWith("{") && type.endsWith("}")) {
    return objectSchema(type.slice(1, -1));
  }
  if (type.startsWith("Record<") && type.endsWith(">")) {
    const parameters = splitTopLevel(type.slice("Record<".length, -1), new Set([","]));
    return v.record(text, parameters[1] ? schemaFromType(parameters[1]) : v.unknown());
  }
  if (type.startsWith("Intl.")) return v.record(text, v.unknown());
  if (type === "number") return finiteNumber;
  if (type === "string" || type === "Date") return text;
  if (type === "boolean") return v.boolean();
  if (type === "null") return v.null_();
  if (type === "true") return v.literal(true);
  if (type === "false") return v.literal(false);
  if (["min", "max", "lo", "hi", "start", "end", "TL", "TR", "BL", "BR"].includes(type)) {
    return finiteNumber;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(type)) return v.literal(Number(type));
  if (/^".*"$/.test(type)) {
    try {
      return v.literal(JSON.parse(type) as string);
    } catch {
      return v.never();
    }
  }
  return v.unknown();
}

function objectSchema(fieldsSource: string): v.GenericSchema {
  const entries: v.ObjectEntries = {};
  for (const field of splitTopLevel(fieldsSource, new Set([",", ";"]))) {
    const match = /^([A-Za-z_$][\w$]*)(\?)?(?:\s*:\s*(.+))?$/.exec(field.trim());
    if (!match) continue;
    const [, name, optional, nestedType] = match;
    const schema = nestedType ? schemaFromType(nestedType) : v.unknown();
    entries[name] = optional ? v.optional(schema) : schema;
  }
  return v.strictObject(entries);
}

function decodeValue(raw: string, prop: ChartProp): unknown {
  const type = prop.type.trim();
  const trimmed = raw.trimStart();
  const arrayExpected = splitAlternatives(type).every((alternative) =>
    isArrayType(alternative.trim()),
  );

  if (arrayExpected && !trimmed.startsWith("[")) {
    if (type.includes("{") || !raw.includes(",")) {
      throw new Error(`Prop "${prop.name}" must be a JSON array.`);
    }
    return raw.split(",").map((part) => parsePrimitive(part.trim()));
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Prop "${prop.name}" contains invalid JSON.`);
    }
  }
  if (allowsBoolean(type) && (raw === "true" || raw === "false")) return raw === "true";
  if (type.includes("null") && raw === "null") return null;
  if (allowsNumber(type) && isJsonNumber(raw)) return Number(raw);
  return raw;
}

function parsePrimitive(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (isJsonNumber(raw)) return Number(raw);
  return raw;
}

function isArrayType(type: string): boolean {
  return type.startsWith("[") || type.endsWith("[]") || type.startsWith("Array<");
}

function allowsBoolean(type: string): boolean {
  return /\bboolean\b|(?:^|\|)\s*(?:true|false)\s*(?:\||$)/.test(type);
}

function allowsNumber(type: string): boolean {
  return /\bnumber\b|(?:^|\|)\s*-?\d+(?:\.\d+)?\s*(?:\||$)/.test(type);
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
