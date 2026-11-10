import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicFile(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
