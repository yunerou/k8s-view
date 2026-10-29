import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configJsonSchema } from "../src/core/config/schema";

// esbuild bundles this file into .tmp/gen-schema.cjs, then runs it from the k8s-view directory.
const out = join(process.cwd(), "schemas/k8s-view.schema.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
