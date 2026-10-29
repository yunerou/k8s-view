import { inject, injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { LogSession, type LogTarget } from "../app/LogSession";
import { LogSource } from "../app/ports/LogSource";
import { ResourceSource } from "../app/ports/ResourceSource";
import { Settings } from "../app/ports/Settings";
import { formatNotice } from "../core/logs/LogFormat";

const CTRL_C = "\x03";

/**
 * Logs in VS Code terminals (Pseudoterminal, preserving ANSI colors): one terminal and one `LogSession` per open.
 * Ctrl+C stops streaming; afterward, Enter closes the terminal and R reopens it.
 */
@injectable()
export class LogTerminals implements vscode.Disposable {
  private readonly sessions = new Set<LogSession>();

  constructor(
    private readonly source = inject(ResourceSource),
    private readonly logs = inject(LogSource),
    private readonly settings = inject(Settings),
  ) {}

  open(target: LogTarget): void {
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<void>();
    let session: LogSession | undefined;
    const sink = { line: (text: string) => write.fire(`${text.replace(/\r?\n/g, "\r\n")}\r\n`) };
    const start = () => {
      session = new LogSession(
        target,
        {
          tailLines: this.settings.logTailLines(),
          timestamps: this.settings.logTimestamps(),
          highlight: this.settings.logHighlight(),
        },
        this.source,
        this.logs,
        sink,
      );
      this.sessions.add(session);
      session.start();
    };
    const stop = () => {
      if (!session) return;
      session.dispose();
      this.sessions.delete(session);
      session = undefined;
    };
    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: start,
      close: () => {
        stop();
        write.dispose();
        close.dispose();
      },
      handleInput: (data) => {
        if (session) {
          if (data !== CTRL_C) return;
          stop();
          sink.line(formatNotice("Stopped. Press Enter to close, R to restart.", "■"));
        } else if (data === "\r") {
          close.fire();
        } else if (data.toLowerCase() === "r") {
          sink.line("");
          start();
        }
      },
    };
    const terminal = vscode.window.createTerminal({
      name: `Logs ${target.title}`,
      pty,
      iconPath: new vscode.ThemeIcon("output"),
      isTransient: true,
    });
    terminal.show();
  }

  dispose(): void {
    for (const s of this.sessions) s.dispose();
    this.sessions.clear();
  }
}
