import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type EnvironmentOptions } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const outDir = join(root, "dist/webview");
const entries = ["context", "table"] as const;

/**
 * Each entry has its own build environment → a self-contained ES module `<entry>.js` + `<entry>.css`,
 * without shared chunks or hashes (extension HTML references filenames directly).
 */
function entryEnvironment(name: string): EnvironmentOptions {
  return {
    consumer: "client",
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      cssCodeSplit: true,
      rolldownOptions: {
        input: { [name]: join(root, `webview-ui/${name}/main.tsx`) },
        output: { entryFileNames: "[name].js", assetFileNames: `${name}[extname]`, codeSplitting: false },
      },
    },
  };
}

/** Copy codicon.css + codicon.ttf next to the bundle (linked by `#vscode-codicon-stylesheet`). */
function copyCodicons(): void {
  const dist = join(dirname(createRequire(import.meta.url).resolve("@vscode/codicons/package.json")), "dist");
  for (const f of ["codicon.css", "codicon.ttf"]) copyFileSync(join(dist, f), join(outDir, f));
}

export default defineConfig({
  plugins: [react()],
  environments: Object.fromEntries(entries.map((e) => [e, entryEnvironment(e)])),
  builder: {
    async buildApp(builder) {
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      for (const e of entries) {
        const env = builder.environments[e];
        if (!env) throw new Error(`Missing Vite environment "${e}"`);
        await builder.build(env);
      }
      copyCodicons();
    },
  },
});
