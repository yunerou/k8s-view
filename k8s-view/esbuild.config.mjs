import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "cjs", // client-node is ESM; esbuild converts it to CJS.
  platform: "node",
  mainFields: ["module", "main"], // jsonc-parser's UMD build uses dynamic require; use the ESM build.
  target: "node22", // Safe baseline for forks; VS Code 1.143 runs Node 24.
  external: ["vscode", "bufferutil", "utf-8-validate"], // Two optional ws dependencies
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

if (watch) await (await context(options)).watch();
else await build(options);
