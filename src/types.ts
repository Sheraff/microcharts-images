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
