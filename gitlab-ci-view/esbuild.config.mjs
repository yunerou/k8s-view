import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: { extension: "src/extension.ts", "mcp-bridge": "src/bridge/mcp-bridge.ts" },
  bundle: true,
  outdir: "dist",
  format: "cjs",
  platform: "node",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

if (watch) await (await context(options)).watch();
else await build(options);
