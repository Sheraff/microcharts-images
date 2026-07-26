import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(await readFile(join(root, "scripts", "catalog.snapshot.json"), "utf8"));
const reactPackagePath = require.resolve("@microcharts/react/package.json");
const reactPackage = JSON.parse(await readFile(reactPackagePath, "utf8"));
const reactDist = join(dirname(reactPackagePath), "dist");
const htmlCharts = new Set(["delta", "token-confidence"]);
const requiredOverrides = new Map([["calendar-strip", new Set(["end"])]]);

const stableCharts = catalog.charts.filter((chart) => chart.status === "stable");
const sharedProps = new Map(catalog.sharedProps.map((prop) => [prop.name, prop]));

async function propertiesFromDeclaration(path, interfaceName) {
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

const definitions = [];
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
const registry = [
  'import type { ComponentType } from "react";',
  ...svgCharts.map(
    (chart) => `import { ${chart.name} } from ${JSON.stringify(chart.staticImport)};`,
  ),
  "",
  "export const COMPONENTS = {",
  ...svgCharts.map((chart) => `  ${JSON.stringify(chart.slug)}: ${chart.name},`),
  `} as unknown as Record<string, ComponentType<Record<string, unknown>>>;`,
  "",
].join("\n");

const metadata = [
  'import type { ChartDefinition } from "./types";',
  "",
  `export const LIBRARY_VERSION = ${JSON.stringify(reactPackage.version)};`,
  `export const CHARTS = ${JSON.stringify(definitions, null, 2)} as const satisfies readonly ChartDefinition[];`,
  "",
].join("\n");

const styles = await readFile(join(reactDist, "styles.css"), "utf8");
const styleModule = `export const STYLES = ${JSON.stringify(styles)};\n`;

await Promise.all([
  writeFile(join(root, "src", "registry.generated.ts"), registry),
  writeFile(join(root, "src", "catalog.generated.ts"), metadata),
  writeFile(join(root, "src", "styles.generated.ts"), styleModule),
]);

console.log(`Generated ${definitions.length} chart definitions (${svgCharts.length} SVG charts).`);
