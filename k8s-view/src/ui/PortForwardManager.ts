import { type ChildProcess, spawn } from "node:child_process";
import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { ContextService } from "../app/ContextService";
import { Settings } from "../app/ports/Settings";
import type { PortForwardInfo, PortForwardRequest } from "./portForward";

export type { PortForwardInfo, PortForwardRequest } from "./portForward";

interface Session extends PortForwardInfo {
  readonly child: ChildProcess;
  state: "starting" | "active";
  stopped: boolean;
}

/**
 * Run `kubectl port-forward --context …` for pods or services (using the selected context); active sessions appear in
 * the status bar and as resources in the Service view (each session can be stopped individually).
 */
@injectable()
export class PortForwardManager implements vscode.Disposable {
  private readonly sessions = new Map<number, Session>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly item = vscode.window.createStatusBarItem(
    "k8sView.portForwards",
    vscode.StatusBarAlignment.Right,
    49,
  );
  private readonly channel = vscode.window.createOutputChannel("K8s View: Port-forward");
  private nextId = 1;

  constructor(
    private readonly contexts = inject(ContextService),
    private readonly settings = inject(Settings),
  ) {
    this.item.command = "k8sView.portForwards";
    this.item.name = "K8s View: Port-forwards";
  }

  /** Active sessions, optionally filtered by context. */
  list(context?: string): PortForwardInfo[] {
    return [...this.sessions.values()].filter((s) => context === undefined || s.request.context === context);
  }

  start(request: PortForwardRequest): void {
    const ports = request.ports.split(/\s+/).filter(Boolean);
    const duplicate = [...this.sessions.values()].find(
      (s) =>
        s.request.context === request.context &&
        s.request.namespace === request.namespace &&
        s.request.kind === request.kind &&
        s.request.name === request.name &&
        s.request.ports === request.ports,
    );
    if (duplicate) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Port-forward {0}/{1} {2} is already running.", request.kind, request.name, request.ports),
      );
      return;
    }
    const kind = request.kind === "service" ? "svc" : request.kind;
    const args = [
      "port-forward",
      `${kind}/${request.name}`,
      ...ports,
      "-n",
      request.namespace,
      "--context",
      request.context,
    ];
    const delimiter = process.platform === "win32" ? ";" : ":";
    const child = spawn("kubectl", args, {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        KUBECONFIG: this.contexts.kubeconfigEnv(),
        PATH: [...this.settings.extraPath(), process.env["PATH"] ?? ""].filter(Boolean).join(delimiter),
      },
    });
    const session: Session = {
      id: this.nextId++,
      request,
      child,
      state: "starting",
      startedAt: Date.now(),
      localPorts: ports.map((p) => Number(p.split(":")[0])).filter((n) => n > 0),
      stopped: false,
    };
    this.sessions.set(session.id, session);
    this.update();
    const label = `${kind}/${request.name}`;
    this.channel.appendLine(`$ kubectl ${args.join(" ")}`);
    let announced = false;
    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      this.channel.append(text);
      if (!announced && text.includes("Forwarding from")) {
        announced = true;
        session.state = "active";
        this.update();
        const open = vscode.l10n.t("Open in browser");
        void vscode.window
          .showInformationMessage(vscode.l10n.t("Port-forward {0}: {1}", label, request.ports), open)
          .then((a) => {
            if (a === open) this.openInBrowser(session.id);
          });
      }
    });
    child.stderr?.on("data", (d: Buffer) => this.channel.append(d.toString()));
    child.on("error", (err) => this.channel.appendLine(err.message));
    child.on("exit", (code) => {
      this.sessions.delete(session.id);
      this.update();
      if (!session.stopped) {
        const show = vscode.l10n.t("Show output");
        void vscode.window
          .showErrorMessage(vscode.l10n.t("Port-forward {0} stopped (exit {1})", label, String(code ?? "?")), show)
          .then((a) => {
            if (a === show) this.channel.show(true);
          });
      }
    });
  }

  async pick(): Promise<void> {
    const items = [...this.sessions.values()].map((s) => ({
      label: `$(${s.state === "active" ? "plug" : "loading~spin"}) ${s.request.kind}/${s.request.name}`,
      description: `${s.request.ports} · ${s.request.namespace} · ${s.request.context}`,
      session: s,
    }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No active port-forwards."));
      return;
    }
    const chosen = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Port-forwards"),
      placeHolder: vscode.l10n.t("Select one to stop"),
    });
    if (chosen) this.stop(chosen.session.id);
  }

  stop(id: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.stopped = true;
    s.child.kill();
  }

  /** Open `http://localhost:<port>`; prompt for a port if there are several. */
  async openInBrowser(id: number): Promise<void> {
    const ports = this.sessions.get(id)?.localPorts ?? [];
    const port =
      ports.length > 1
        ? await vscode.window.showQuickPick(
            ports.map((p) => String(p)),
            { title: vscode.l10n.t("Open which local port?") },
          )
        : ports[0]?.toString();
    if (port) await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
  }

  showOutput(): void {
    this.channel.show(true);
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
    this.item.dispose();
    this.channel.dispose();
    this.changed.dispose();
  }

  private update(): void {
    const n = this.sessions.size;
    this.item.text = `$(plug) ${n}`;
    this.item.tooltip = vscode.l10n.t("{0} active port-forward(s)", n);
    if (n > 0) this.item.show();
    else this.item.hide();
    this.changed.fire();
  }
}
