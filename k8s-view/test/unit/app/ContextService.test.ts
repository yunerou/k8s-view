import { describe, expect, test } from "vitest";
import { ContextService } from "../../../src/app/ContextService";
import { FakeClusterApi, FakeKubeConfig, FakeSettings, FakeState } from "../helpers/fakes";

const ctx = (name: string, namespace?: string) => ({
  name,
  cluster: `${name}-cluster`,
  user: `${name}-user`,
  namespace,
});

function setup(opts: { current?: string; state?: FakeState } = {}) {
  const kubeconfig = new FakeKubeConfig([ctx("dev", "team-a"), ctx("prod"), ctx("kind")], opts.current ?? "dev");
  const state = opts.state ?? new FakeState();
  const settings = new FakeSettings();
  const api = new FakeClusterApi();
  const service = new ContextService(kubeconfig, state, settings, api);
  const events: (string | undefined)[] = [];
  service.onDidChange((c) => events.push(c ? `${c.name}/${c.namespace ?? "*"}` : undefined));
  return { kubeconfig, state, settings, api, service, events };
}

describe("ContextService", () => {
  test("starts from kubeconfig current-context and its namespace", async () => {
    const { service } = setup();
    await service.initialize();
    expect(service.current?.name).toBe("dev");
    expect(service.current?.cluster).toBe("dev-cluster");
    expect(service.current?.scope).toEqual({ type: "single", name: "team-a" });
  });

  test("restores remembered context per workspace and namespace per context", async () => {
    const state = new FakeState();
    state.workspace.set("k8sView.context", "prod");
    state.global.set("k8sView.namespace/prod", { type: "all" });
    const { service } = setup({ state });
    await service.initialize();
    expect(service.current?.name).toBe("prod");
    expect(service.current?.scope).toEqual({ type: "all" });
  });

  test("context without namespace defaults to all namespaces", async () => {
    const { service } = setup({ current: "kind" });
    await service.initialize();
    expect(service.current?.scope).toEqual({ type: "all" });
  });

  test("selectContext persists, restores that context's namespace and fires", async () => {
    const { service, state, events } = setup();
    await service.initialize();
    await service.selectNamespace({ type: "single", name: "team-b" });
    await service.selectContext("prod");
    await service.selectNamespace({ type: "single", name: "web" });
    await service.selectContext("dev");
    expect(state.workspace.get("k8sView.context")).toBe("dev");
    expect(service.current?.scope).toEqual({ type: "single", name: "team-b" });
    expect(events).toEqual(["dev/team-a", "dev/team-b", "prod/*", "prod/web", "dev/team-b"]);
  });

  test("selecting an unknown context is rejected", async () => {
    const { service } = setup();
    await service.initialize();
    await expect(service.selectContext("nope")).rejects.toThrow(/Unknown context/);
  });

  test("kubeconfig reload keeps the selection when the context still exists", async () => {
    const { service, kubeconfig } = setup();
    await service.initialize();
    await service.selectContext("prod");
    kubeconfig.list = [ctx("prod"), ctx("new")];
    kubeconfig.changed.fire();
    await service.whenIdle();
    expect(service.current?.name).toBe("prod");
    kubeconfig.list = [ctx("new")];
    kubeconfig.current = "new";
    kubeconfig.changed.fire();
    await service.whenIdle();
    expect(service.current?.name).toBe("new");
  });

  test("protected contexts follow the setting", async () => {
    const { service, settings, events } = setup();
    await service.initialize();
    expect(service.current?.isProtected).toBe(false);
    settings.set({ protected: ["d.v"] }, ["context.protected"]);
    expect(service.current?.isProtected).toBe(true);
    expect(events.at(-1)).toBe("dev/team-a");
  });

  test("connection check reports server version or error", async () => {
    const { service, api } = setup();
    await service.initialize();
    await service.checkConnection();
    expect(service.connection).toEqual({ state: "connected", serverVersion: "v1.34.0" });
    api.versions.set("prod", new Error("Unauthorized"));
    await service.selectContext("prod");
    await service.checkConnection();
    expect(service.connection).toEqual({ state: "error", message: "Unauthorized" });
  });

  test("namespace list falls back to recent + defaults on 403", async () => {
    const { service, api } = setup();
    await service.initialize();
    await service.selectNamespace({ type: "single", name: "team-b" });
    api.namespaces.set("dev", FakeClusterApi.forbidden());
    const ns = await service.loadNamespaces();
    expect(ns.forbidden).toBe(true);
    expect(ns.items).toEqual(["team-b", "team-a"]);
    api.namespaces.set("dev", ["a", "b"]);
    expect(await service.loadNamespaces()).toEqual({ items: ["a", "b"], forbidden: false });
  });

  test("follows external context/namespace only when enabled", async () => {
    const { service, settings } = setup();
    await service.initialize();
    await service.applyExternalContext("prod");
    expect(service.current?.name).toBe("dev");
    settings.set({ follow: true }, ["context.followKubernetesExtension"]);
    await service.applyExternalContext("prod");
    await service.applyExternalNamespace("web");
    expect(service.current?.name).toBe("prod");
    expect(service.current?.namespace).toBe("web");
  });

  test("connection check can be cancelled", async () => {
    const { service, api } = setup();
    await service.initialize();
    api.hang = true;
    const check = service.checkConnection();
    expect(service.connection).toEqual({ state: "connecting" });
    service.cancelConnection();
    expect(await check).toEqual({ state: "error", message: "Connection cancelled." });
  });

  test("exec auth contexts sign in through the terminal before connecting", async () => {
    const { service, api } = setup();
    await service.initialize();
    api.loginRequired.add("dev");
    const check = service.checkConnection();
    expect(service.connection).toEqual({ state: "connecting", login: true });
    expect(api.logins).toEqual(["dev"]);
    api.finishLogin();
    expect(await check).toEqual({ state: "connected", serverVersion: "v1.34.0" });
    // Credentials already available: do not reopen the terminal.
    await service.checkConnection();
    expect(api.logins).toEqual(["dev"]);
  });

  test("reconnect signs in again for exec auth contexts only", async () => {
    const { service, api } = setup();
    await service.initialize();
    await service.checkConnection({ reauthenticate: true });
    expect(api.logins).toEqual([]);
    api.execAuth.add("dev");
    await service.checkConnection();
    expect(api.logins).toEqual([]);
    const check = service.checkConnection({ reauthenticate: true });
    expect(service.connection).toEqual({ state: "connecting", login: true });
    api.finishLogin();
    expect(await check).toEqual({ state: "connected", serverVersion: "v1.34.0" });
    expect(api.logins).toEqual(["dev"]);
  });

  test("switching context cancels a pending sign-in", async () => {
    const { service, api } = setup();
    await service.initialize();
    api.loginRequired.add("dev");
    const check = service.checkConnection();
    await service.selectContext("prod");
    await check;
    expect(service.current?.name).toBe("prod");
    expect(service.connection).toEqual({ state: "unknown" });
  });
});
