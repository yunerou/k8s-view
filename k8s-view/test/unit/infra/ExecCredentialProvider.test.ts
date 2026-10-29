import { KubeConfig } from "@kubernetes/client-node";
import { beforeEach, describe, expect, test } from "vitest";
import { EventEmitter, window } from "vscode";
import { ExecCredentialProvider } from "../../../src/infra/kube/ExecCredentialProvider";
import type { KubeConfigAccess } from "../../../src/infra/kube/KubeConfigAccess";
import { FakeSettings } from "../helpers/fakes";

/** Fake exec plugin running via `node -e <script>`; credential expiration passed through exec config `env`. */
function setup(script: string, expiresInMs = 3_600_000) {
  const kc = new KubeConfig();
  const expiration = new Date(Date.now() + expiresInMs).toISOString();
  kc.loadFromOptions({
    clusters: [{ name: "c", server: "https://example.invalid", skipTLSVerify: true }],
    users: [
      { name: "token-user", token: "abc" },
      {
        name: "exec-user",
        exec: {
          apiVersion: "client.authentication.k8s.io/v1",
          command: process.execPath,
          args: ["-e", script],
          env: [{ name: "EXPIRES", value: expiration }],
        },
      },
    ],
    contexts: [
      { name: "plain", cluster: "c", user: "token-user" },
      { name: "eks", cluster: "c", user: "exec-user" },
    ],
    currentContext: "plain",
  });
  const changed = new EventEmitter<void>();
  const provider: KubeConfigAccess = { kubeConfig: () => kc, onDidChange: changed.event };
  return { credentials: new ExecCredentialProvider(provider, new FakeSettings()), changed };
}

const PRINT = `
const info = JSON.parse(process.env.KUBERNETES_EXEC_INFO);
if (info.spec.interactive) process.exit(9);
console.log(JSON.stringify({ status: { token: "t-" + process.pid, expirationTimestamp: process.env.EXPIRES } }));`;

/** Interactive plugin: read a "code" from stdin, print prompts to stderr and credentials to stdout. */
const INTERACTIVE = `
const info = JSON.parse(process.env.KUBERNETES_EXEC_INFO);
if (!info.spec.interactive) { console.error("needs a terminal"); process.exit(1); }
process.stderr.write("Enter code: ");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (input.trim() !== "42") { console.error("wrong code"); process.exit(3); }
  console.log(JSON.stringify({ status: { token: "secret", expirationTimestamp: process.env.EXPIRES } }));
});`;

beforeEach(() => {
  window.terminals.length = 0;
  window.terminalInput = "";
});

describe("ExecCredentialProvider", () => {
  test("only exec-auth contexts need a sign-in", () => {
    const { credentials } = setup(PRINT);
    expect(credentials.needsLogin("plain")).toBe(false);
    expect(credentials.needsLogin("eks")).toBe(true);
  });

  test("runs the plugin non-interactively and caches the credential until it expires", async () => {
    const { credentials, changed } = setup(PRINT);
    const [a, b] = await Promise.all([credentials.credential("exec-user"), credentials.credential("exec-user")]);
    expect(a.status.token).toMatch(/^t-\d+$/);
    expect(b).toBe(a);
    expect(await credentials.credential("exec-user")).toBe(a);
    expect(credentials.needsLogin("eks")).toBe(false);
    changed.fire();
    expect((await credentials.credential("exec-user")).status.token).not.toBe(a.status.token);
  });

  test("does not cache an expired credential", async () => {
    const { credentials } = setup(PRINT, -1000);
    const a = await credentials.credential("exec-user");
    expect((await credentials.credential("exec-user")).status.token).not.toBe(a.status.token);
    expect(credentials.needsLogin("eks")).toBe(true);
  });

  test("reports plugin failures with stderr", async () => {
    const { credentials } = setup(`console.error("token expired, run aws sso login"); process.exit(1);`);
    await expect(credentials.credential("exec-user")).rejects.toThrow(/token expired, run aws sso login/);
  });

  test("signs in through an interactive terminal; the token never reaches the terminal", async () => {
    const { credentials } = setup(INTERACTIVE);
    window.terminalInput = "42\n";
    await credentials.login("eks", new AbortController().signal);
    expect(window.terminals).toHaveLength(1);
    expect(window.terminals[0]?.name).toBe("Sign in: eks");
    expect(window.terminals[0]?.output).toContain("Enter code:");
    expect(window.terminals[0]?.output).not.toContain("secret");
    expect(credentials.needsLogin("eks")).toBe(false);
    expect((await credentials.credential("exec-user")).status.token).toBe("secret");
  });

  test("a failed sign-in reports the exit code and caches nothing", async () => {
    const { credentials } = setup(INTERACTIVE);
    window.terminalInput = "nope\n";
    await expect(credentials.login("eks", new AbortController().signal)).rejects.toThrow(/failed \(exit 3\)/);
    expect(window.terminals[0]?.output).toContain("Sign-in failed (exit 3)");
    expect(credentials.needsLogin("eks")).toBe(true);
  });

  test("cancelling closes the sign-in terminal", async () => {
    const { credentials } = setup("setTimeout(() => {}, 5_000)");
    const controller = new AbortController();
    const login = credentials.login("eks", controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(login).rejects.toThrow();
    expect(credentials.needsLogin("eks")).toBe(true);
  });

  test("reauthenticate runs the plugin in the terminal again even with a cached credential", async () => {
    const { credentials } = setup(INTERACTIVE);
    window.terminalInput = "42\n";
    await credentials.login("eks", new AbortController().signal);
    expect(credentials.needsLogin("eks")).toBe(false);
    expect(credentials.needsLogin("eks", true)).toBe(true);
    await credentials.login("eks", new AbortController().signal, true);
    expect(window.terminals).toHaveLength(2);
    expect(credentials.needsLogin("plain", true)).toBe(false);
  });

  test("a 401 invalidates the cached credential", async () => {
    const { credentials } = setup(PRINT);
    const a = await credentials.credential("exec-user");
    credentials.invalidate("eks");
    expect((await credentials.credential("exec-user")).status.token).not.toBe(a.status.token);
  });
});
