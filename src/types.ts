export type ValueShape =
  | { kind: "unknown" | "number" | "string" | "boolean" | "null" | "never" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; item: ValueShape }
  | { kind: "tuple"; items: readonly ValueShape[] }
  | { kind: "object"; fields: readonly ValueField[] }
  | { kind: "record"; value: ValueShape }
  | { kind: "union"; options: readonly ValueShape[] };

export interface ValueField {
  name: string;
  optional: boolean;
  value: ValueShape;
}

export interface ChartProp {
  name: string;
  type: string;
  required: boolean;
  interactive?: boolean;
}

export interface ChartDefinition {
  name: string;
  slug: string;
  dataShape: string;
  svg: boolean;
  props: readonly ChartProp[];
  sample?: Readonly<Record<string, unknown>>;
}
