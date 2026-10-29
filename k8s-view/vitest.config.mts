import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { transform } from "esbuild";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** Oxc only transforms legacy decorators; esbuild transforms TC39 decorators to match the actual extension build. */
function standardDecorators(): Plugin {
  return {
    name: "k8s-view:standard-decorators",
    enforce: "pre",
    async transform(code, id) {
      if (!/\.tsx?$/.test(id) || !/^\s*@\w+\(/m.test(code)) return null;
      const result = await transform(code, {
        loader: id.endsWith(".tsx") ? "tsx" : "ts",
        target: "es2022",
        sourcemap: true,
        sourcefile: id,
      });
      return { code: result.code, map: result.map };
    },
  };
}

export default defineConfig({
  plugins: [standardDecorators(), react()],
  resolve: {
    alias: { vscode: fileURLToPath(new URL("./test/stubs/vscode.ts", import.meta.url)) },
  },
  test: {
    include: ["test/unit/**/*.test.{ts,tsx}"],
    environment: "node",
    coverage: { provider: "v8", include: ["src/**", "webview-ui/**"] },
  },
});
