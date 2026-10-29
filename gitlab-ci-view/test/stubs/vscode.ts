/**
 * Minimal `vscode` API stub for app/ui unit tests (vitest aliases `vscode` → this file).
 * Implements only what is used; extend as needed.
 */

import { spawn } from "node:child_process";

declare global {
  interface Thenable<T> extends PromiseLike<T> {}
}

export class Disposable {
  readonly dispose: () => void;
  constructor(fn: () => void = () => {}) {
    this.dispose = fn;
  }
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const i of items) i.dispose();
    });
  }
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();
  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<void>;
}

export class CancellationTokenSource {
  private cancelled = false;
  private readonly emitter = new EventEmitter<void>();
  readonly token = {
    get isCancellationRequested(): boolean {
      return false;
    },
    onCancellationRequested: this.emitter.event,
  };
  constructor() {
    Object.defineProperty(this.token, "isCancellationRequested", { get: () => this.cancelled });
  }
  cancel(): void {
    this.cancelled = true;
    this.emitter.fire();
  }
  dispose(): void {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class MarkdownString {
  value = "";
  isTrusted = false;
  supportThemeIcons = false;
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(v: string): this {
    this.value += v;
    return this;
  }
  appendText(v: string): this {
    this.value += v;
    return this;
  }
  appendCodeblock(v: string, lang = ""): this {
    this.value += `\n\`\`\`${lang}\n${v}\n\`\`\`\n`;
    return this;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  iconPath?: ThemeIcon;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  accessibilityInformation?: { label: string };
  constructor(
    public label: string | { label: string },
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}
  static parse(value: string): Uri {
    const u = new URL(value);
    return new Uri(
      u.protocol.replace(/:$/, ""),
      u.host,
      decodeURIComponent(u.pathname),
      u.search.replace(/^\?/, ""),
      u.hash.replace(/^#/, ""),
    );
  }
  static file(path: string): Uri {
    return new Uri("file", "", path, "", "");
  }
  static from(c: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(c.scheme, c.authority ?? "", c.path ?? "", c.query ?? "", c.fragment ?? "");
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(
      base.scheme,
      base.authority,
      [base.path, ...segments].join("/").replace(/\/+/g, "/"),
      base.query,
      base.fragment,
    );
  }
  get fsPath(): string {
    return this.path;
  }
  with(change: Partial<{ scheme: string; authority: string; path: string; query: string; fragment: string }>): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString(): string {
    const q = this.query ? `?${this.query}` : "";
    return `${this.scheme}://${this.authority}${this.path}${q}`;
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export const l10n = {
  t(message: string, ...args: unknown[]): string {
    return message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)]));
  },
};

export class RelativePattern {
  constructor(
    readonly base: Uri,
    readonly pattern: string,
  ) {}
}

const noEvent = (() => new Disposable(() => undefined)) as Event<never>;

export const workspace = {
  fs: {
    async readFile(_uri: Uri): Promise<Uint8Array> {
      throw new Error("Stub: file not found");
    },
    async writeFile(_uri: Uri, _content: Uint8Array): Promise<void> {
      throw new Error("Stub: file writes are not implemented");
    },
    async createDirectory(_uri: Uri): Promise<void> {},
  },
  onDidCloseTextDocument: noEvent as Event<TextDocument>,
  async openTextDocument(uri: Uri): Promise<TextDocument> {
    return { uri, getText: () => "", positionAt: () => ({ line: 0, character: 0 }) };
  },
  isTrusted: true,
  workspaceFolders: undefined as { uri: Uri; name: string }[] | undefined,
  onDidChangeConfiguration: noEvent as Event<{ affectsConfiguration(section: string): boolean }>,
  getConfiguration(_section?: string) {
    return {
      get: <T>(_key: string, fallback?: T): T | undefined => fallback,
      inspect: <T>(_key: string): { globalValue?: T } | undefined => undefined,
    };
  },
  createFileSystemWatcher(_pattern: RelativePattern | string) {
    return {
      onDidChange: noEvent as Event<Uri>,
      onDidCreate: noEvent as Event<Uri>,
      onDidDelete: noEvent as Event<Uri>,
      dispose() {},
    };
  },
};

export interface TerminalOptions {
  readonly name?: string;
  readonly shellPath?: string;
  readonly shellArgs?: string[];
  readonly env?: Record<string, string>;
  readonly iconPath?: ThemeIcon;
  readonly isTransient?: boolean;
}

export interface Terminal {
  readonly name: string;
  readonly exitStatus: { readonly code: number | undefined } | undefined;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

const closedTerminal = new EventEmitter<Terminal>();

/**
 * Fake terminal: actually runs `shellPath shellArgs` (without a PTY), using `window.terminalInput` as stdin;
 * when the process exits, emits `onDidCloseTerminal` with the exit code.
 */
export const window = {
  state: { focused: true },
  onDidChangeWindowState: noEvent as Event<{ focused: boolean }>,
  activeTextEditor: undefined as { document: TextDocument } | undefined,
  onDidChangeActiveTextEditor: noEvent as Event<{ document: TextDocument } | undefined>,
  createStatusBarItem(_id: string, _alignment: StatusBarAlignment, _priority: number) {
    return {
      name: "",
      text: "",
      tooltip: "",
      command: undefined as unknown,
      backgroundColor: undefined as ThemeColor | undefined,
      show() {},
      hide() {},
      dispose() {},
    };
  },
  setStatusBarMessage(_message: string, _timeout: number): Disposable {
    return new Disposable();
  },
  createWebviewPanel(
    _type: string,
    _title: string,
    _column: ViewColumn,
    _options: WebviewOptions & { retainContextWhenHidden?: boolean },
  ): WebviewPanel {
    throw new Error("Stub: provide a webview panel in the test");
  },
  async showQuickPick<T extends QuickPickItem>(
    _items: readonly T[],
    _options?: { title?: string; matchOnDescription?: boolean },
  ): Promise<T | undefined> {
    return undefined;
  },
  async showWarningMessage(_message: string, ..._items: unknown[]): Promise<string | undefined> {
    return undefined;
  },
  async showInformationMessage(_message: string, ..._items: unknown[]): Promise<string | undefined> {
    return undefined;
  },
  async showErrorMessage(_message: string): Promise<string | undefined> {
    return undefined;
  },
  async showTextDocument(
    _document: TextDocument,
    _options?: { preview?: boolean; selection?: Range },
  ): Promise<void> {},
  terminals: [] as (TerminalOptions & { output: string })[],
  terminalInput: "",
  onDidCloseTerminal: closedTerminal.event,
  createTerminal(options: TerminalOptions): Terminal {
    const record = { ...options, output: "" };
    window.terminals.push(record);
    const terminal = {
      name: options.name ?? "",
      exitStatus: undefined as { code: number | undefined } | undefined,
      show() {},
      dispose() {
        child.kill();
      },
    };
    const child = spawn(options.shellPath ?? "/bin/sh", options.shellArgs ?? [], {
      env: { ...process.env, ...options.env },
    });
    child.stdin.end(window.terminalInput);
    child.stdout.on("data", (d: Buffer) => (record.output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (record.output += d.toString()));
    child.on("close", (code) => {
      terminal.exitStatus = { code: code ?? undefined };
      closedTerminal.fire(terminal);
    });
    return terminal;
  },
};

export const env = {
  async openExternal(_uri: Uri): Promise<boolean> {
    return true;
  },
  clipboard: {
    text: "",
    async writeText(v: string): Promise<void> {
      env.clipboard.text = v;
    },
  },
};

// Types used in src/ signatures (needed only for test project typechecking)
export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}
export interface ExtensionContext {
  readonly extensionUri: Uri;
  readonly subscriptions: { dispose(): unknown }[];
  readonly workspaceState: Memento;
  readonly globalState: Memento;
  readonly secrets: SecretStorage;
}
export interface LogOutputChannel {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
export interface TreeDataProvider<T> {
  onDidChangeTreeData?: Event<T | undefined>;
  getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
  getChildren(element?: T): T[] | undefined | Thenable<T[] | undefined>;
}

export enum ViewColumn {
  Active = -1,
}
export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}
export interface QuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly kind?: QuickPickItemKind;
}
export interface Position {
  readonly line: number;
  readonly character: number;
}
export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}
export interface TextDocument {
  readonly uri: Uri;
  getText(): string;
  positionAt(offset: number): Position;
}
export interface TextDocumentContentProvider {
  provideTextDocumentContent(uri: Uri): string | Thenable<string>;
}
export interface WebviewOptions {
  readonly enableScripts?: boolean;
  readonly localResourceRoots?: readonly Uri[];
}
export interface Webview {
  html: string;
  options: WebviewOptions;
  readonly cspSource: string;
  asWebviewUri(uri: Uri): Uri;
}
export interface WebviewPanelOnDidChangeViewStateEvent {
  readonly webviewPanel: WebviewPanel;
}
export interface WebviewPanel {
  title: string;
  iconPath?: ThemeIcon;
  readonly active: boolean;
  readonly visible: boolean;
  readonly webview: Webview;
  readonly onDidDispose: Event<void>;
  readonly onDidChangeViewState: Event<WebviewPanelOnDidChangeViewStateEvent>;
  reveal(): void;
  dispose(): void;
}
export interface WebviewPanelSerializer<T> {
  deserializeWebviewPanel(panel: WebviewPanel, state: T | undefined): Thenable<void>;
}
export const commands = {
  registerCommand(_id: string, _handler: (...args: never[]) => unknown): Disposable {
    return new Disposable();
  },
  async executeCommand(_id: string, ..._args: unknown[]): Promise<unknown> {
    return undefined;
  },
};

export interface SecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}
