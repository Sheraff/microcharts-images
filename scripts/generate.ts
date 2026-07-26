import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChartDefinition, ValueShape } from "../src/types.ts";

interface SnapshotProp {
  name: string;
  type: string;
  required: boolean;
  interactive?: boolean;
}

interface CatalogChart {
  name: string;
  slug: string;
  status: "stable";
  staticImport: string;
  dataShape: string;
  props: SnapshotProp[];
  sample?: Record<string, unknown>;
}

interface CatalogSnapshot {
  sharedProps: SnapshotProp[];
  charts: CatalogChart[];
}

interface DeclaredProp {
  name: string;
  optional: boolean;
}

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(
  await readFile(join(root, "scripts", "catalog.snapshot.json"), "utf8"),
) as CatalogSnapshot;
const reactPackagePath = require.resolve("@microcharts/react/package.json");
const reactPackage = JSON.parse(await readFile(reactPackagePath, "utf8")) as { version: string };
const reactDist = join(dirname(reactPackagePath), "dist");
const htmlCharts = new Set(["delta", "token-confidence"]);
const requiredOverrides = new Map([["calendar-strip", new Set(["end"])]]);

const stableCharts = catalog.charts.filter((chart) => chart.status === "stable");
const sharedProps = new Map(catalog.sharedProps.map((prop) => [prop.name, prop]));

async function propertiesFromDeclaration(
  path: string,
  interfaceName: string,
): Promise<DeclaredProp[]> {
  const source = await readFile(path, "utf8");
  const start = source.indexOf(`interface ${interfaceName}`);
  if (start === -1) {
    const importedFrom = new RegExp(
      `import \\{[^}]*\\bas ${interfaceName}\\b[^}]*\\} from "([^"]+)"`,
    ).exec(source)?.[1];
    if (!importedFrom) throw new Error(`Could not find ${interfaceName} from ${path}`);
    return propertiesFromDeclaration(
      join(dirname(path), importedFrom.replace(/\.js$/, ".d.ts")),
      interfaceName,
    );
  }
  const bodyStart = source.indexOf("{", start) + 1;
  const bodyEnd = source.indexOf("\n}", bodyStart);
  if (bodyEnd === -1) throw new Error(`Could not parse ${interfaceName}`);

  const inherited = [...source.slice(start, bodyStart).matchAll(/"([A-Za-z_$][\w$]*)"/g)].map(
    (match) => ({ name: match[1], optional: true }),
  );
  const own = [
    ...source.slice(bodyStart, bodyEnd).matchAll(/^\s{2}([A-Za-z_$][\w$]*)(\?)?:/gm),
  ].map((match) => ({ name: match[1], optional: match[2] === "?" }));
  return [...inherited, ...own];
}

function valueShape(source: string): ValueShape {
  source = source.trim();
  const alternatives = splitTopLevel(source, new Set(["|"]));
  if (alternatives.length > 1) {
    const options = alternatives.map(valueShape).filter((option) => option.kind !== "never");
    if (options.length === 0) return { kind: "never" };
    if (options.length === 1) return options[0];
    return { kind: "union", options };
  }
  if (source.startsWith("readonly ")) return valueShape(source.slice("readonly ".length));
  if (!source || source === "unknown" || source.includes("per chart")) return { kind: "unknown" };
  if (source.includes("=>") || source === "fn") return { kind: "never" };
  if (source.endsWith("[]")) {
    return { kind: "array", item: valueShape(source.slice(0, -2)) };
  }
  if (source.startsWith("Array<") && source.endsWith(">")) {
    return { kind: "array", item: valueShape(source.slice("Array<".length, -1)) };
  }
  if (source.startsWith("[") && source.endsWith("]")) {
    return {
      kind: "tuple",
      items: splitTopLevel(source.slice(1, -1), new Set([","])).map(valueShape),
    };
  }
  if (source.startsWith("(") && source.endsWith(")")) {
    return valueShape(source.slice(1, -1));
  }
  if (source.startsWith("{") && source.endsWith("}")) {
    return {
      kind: "object",
      fields: splitTopLevel(source.slice(1, -1), new Set([",", ";"]))
        .map((field) => {
          const match = /^([A-Za-z_$][\w$]*)(\?)?(?:\s*:\s*(.+))?$/.exec(field.trim());
          if (!match) return undefined;
          const [, name, optional, nestedType] = match;
          return {
            name,
            optional: optional === "?",
            value: nestedType ? valueShape(nestedType) : { kind: "unknown" as const },
          };
        })
        .filter((field) => field !== undefined),
    };
  }
  if (source.startsWith("Record<") && source.endsWith(">")) {
    const parameters = splitTopLevel(source.slice("Record<".length, -1), new Set([","]));
    return { kind: "record", value: parameters[1] ? valueShape(parameters[1]) : { kind: "unknown" } };
  }
  if (source.startsWith("Intl.")) return { kind: "record", value: { kind: "unknown" } };
  if (source === "number") return { kind: "number" };
  if (source === "string" || source === "Date") return { kind: "string" };
  if (source === "boolean") return { kind: "boolean" };
  if (source === "null") return { kind: "null" };
  if (source === "true") return { kind: "literal", value: true };
  if (source === "false") return { kind: "literal", value: false };
  if (["min", "max", "lo", "hi", "start", "end", "TL", "TR", "BL", "BR"].includes(source)) {
    return { kind: "number" };
  }
  if (/^-?\d+(?:\.\d+)?$/.test(source)) {
    return { kind: "literal", value: Number(source) };
  }
  if (/^".*"$/.test(source)) {
    try {
      return { kind: "literal", value: JSON.parse(source) as string };
    } catch {
      return { kind: "never" };
    }
  }
  return { kind: "unknown" };
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

const definitions: ChartDefinition[] = [];
for (const chart of stableCharts) {
  const declaredProps = await propertiesFromDeclaration(
    join(reactDist, "charts", chart.slug, "index.d.ts"),
    `${chart.name}Props`,
  );
  const chartProps = new Map(chart.props.map((prop) => [prop.name, prop]));
  const props = declaredProps.map(({ name, optional }) => {
    const prop = chartProps.get(name) ?? sharedProps.get(name);
    return {
      name,
      type: prop?.type ?? "unknown",
      required: requiredOverrides.get(chart.slug)?.has(name) || (prop?.required ?? !optional),
      ...(prop?.interactive ? { interactive: true } : {}),
    };
  });

  definitions.push({
    name: chart.name,
    slug: chart.slug,
    dataShape: chart.dataShape,
    svg: !htmlCharts.has(chart.slug),
    props,
    ...(chart.sample ? { sample: chart.sample } : {}),
  });
}

const svgCharts = stableCharts.filter((chart) => !htmlCharts.has(chart.slug));
const valueShapes = Object.fromEntries(
  [...new Set(definitions.flatMap((chart) => chart.props.map((prop) => prop.type)))]
    .sort()
    .map((type) => [type, valueShape(type)]),
);
const registry = [
  ...svgCharts.map(
    (chart) => `import { ${chart.name} } from ${JSON.stringify(chart.staticImport)};`,
  ),
  "",
  "export const COMPONENTS = {",
  ...svgCharts.map((chart) => `  ${JSON.stringify(chart.slug)}: ${chart.name},`),
  "};",
  "",
].join("\n");

const metadata = [
  'import type { ChartDefinition, ValueShape } from "./types";',
  "",
  `export const LIBRARY_VERSION = ${JSON.stringify(reactPackage.version)};`,
  `export const VALUE_SHAPES = ${JSON.stringify(valueShapes, null, 2)} as const satisfies Readonly<Record<string, ValueShape>>;`,
  `export const CHARTS = ${JSON.stringify(definitions, null, 2)} as const satisfies readonly ChartDefinition[];`,
  "",
].join("\n");

await Promise.all([
  writeFile(join(root, "src", "registry.generated.ts"), registry),
  writeFile(join(root, "src", "catalog.generated.ts"), metadata),
]);

console.log(`Generated ${definitions.length} chart definitions (${svgCharts.length} SVG charts).`);
