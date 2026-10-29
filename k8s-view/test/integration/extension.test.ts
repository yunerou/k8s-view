import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import type { TestApi } from "../../src/extension";

const NS = "k8s-view-test";

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function kubectl(...args: string[]): string {
  return execFileSync("kubectl", args, { encoding: "utf8" });
}

describe("K8s View on a kind cluster", () => {
  let api: TestApi;

  before(async () => {
    const ext = vscode.extensions.getExtension<TestApi>("yunerou.k8s-view");
    assert.ok(ext, "extension is installed");
    api = (await ext.activate()) as TestApi;
    assert.ok(api, "test API is exposed (K8S_VIEW_INTEGRATION=1)");
    const kind = api.contexts.contexts().find((c) => c.name.startsWith("kind-"));
    assert.ok(kind, "a kind context exists in the kubeconfig");
    await api.contexts.selectContext(kind.name);
    await api.contexts.selectNamespace({ type: "single", name: NS });
  });

  it("loads the built-in views and the workspace view", () => {
    const ids = api.views.views().map((v) => v.id);
    for (const id of ["workload", "config", "service", "serviceaccount", "team"]) assert.ok(ids.includes(id), id);
  });

  it("connects to the cluster", async () => {
    const state = await api.contexts.checkConnection();
    assert.equal(state.state, "connected");
  });

  it("lists fixture resources in the built-in views", async () => {
    const workload = api.sessions.session("workload")!;
    workload.setVisible(true);
    await workload.whenReady();
    const deployments = await waitFor("deployment web", () => {
      const c = workload.openSection("deployments");
      return c.items.some((r) => r.name === "web") && c;
    });
    assert.ok(deployments.items.length >= 1);
    const config = api.sessions.session("config")!;
    await config.whenReady();
    const secrets = await waitFor("secret credentials", () =>
      config.openSection("secrets").items.find((r) => r.name === "credentials"),
    );
    assert.deepEqual(secrets.object["data"], { password: "<7 bytes>" }, "secret values are masked");
  });

  it("filters with the workspace view", async () => {
    const team = api.sessions.session("team")!;
    await team.whenReady();
    const items = await waitFor("team deployments", () => {
      const c = team.openSection("deployments");
      return c.state === "ready" && c.items;
    });
    assert.deepEqual(
      items.map((r) => r.name),
      ["web"],
    );
  });

  it("updates through the watch without refresh", async () => {
    const config = api.sessions.session("config")!;
    config.openSection("configmaps");
    await waitFor("configmaps loaded", () => config.openSection("configmaps").state === "ready");
    kubectl("create", "configmap", "live-update", "-n", NS, "--from-literal=a=b");
    try {
      await waitFor("live-update configmap", () =>
        config.openSection("configmaps").items.some((r) => r.name === "live-update"),
      );
    } finally {
      kubectl("delete", "configmap", "live-update", "-n", NS, "--wait=false");
    }
  });

  it("resolves ServiceAccount → RoleBinding → ClusterRole", async () => {
    const sa = api.sessions.session("serviceaccount")!;
    await sa.whenReady();
    const builder = await waitFor("sa builder", () =>
      sa.openSection("serviceaccounts").items.find((r) => r.name === "builder"),
    );
    const defs = sa.sectionDefinition("serviceaccounts")!.children;
    const bindings = await waitFor("rolebinding", () => {
      const groups = sa.openChildren("it/builder", builder, defs);
      const rb = groups.find((g) => g.def.id === "rolebindings");
      return rb && !rb.pending && rb.items.length > 0 && rb;
    });
    assert.equal(bindings.items[0]?.type === "resource" && bindings.items[0].resource.name, "builder-view");
  });

  it("runs a command bound to a resource and refreshes", async () => {
    const cronjob = api.sessions.session("workload")!;
    await cronjob.whenReady();
    const nightly = await waitFor("cronjob nightly", () =>
      cronjob.openSection("cronjobs").items.find((r) => r.name === "nightly"),
    );
    const trigger = api.commands.get("cronjob.trigger")!;
    assert.ok(trigger.matches(nightly));
    const result = await api.executor.execute(trigger, [nightly]);
    assert.equal(result, "ok");
    await waitFor(
      "manual job",
      () =>
        cronjob.openSection("cronjobs").items.length > 0 &&
        kubectl("get", "jobs", "-n", NS, "-o", "name").includes("nightly-manual-"),
    );
  });

  it("blocks dangerous commands by default", async () => {
    const workload = api.sessions.session("workload")!;
    const web = workload.openSection("deployments").items.find((r) => r.name === "web")!;
    const restart = api.commands.get("workload.restart")!;
    assert.equal(await api.executor.execute(restart, [web]), "blocked");
  });
});
