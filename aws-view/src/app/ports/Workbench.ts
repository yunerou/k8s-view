/** Port: VS Code windows, terminals and extensions. */
export abstract class Workbench {
  /** `ssh-remote+…` authority when this window is a Remote - SSH window, otherwise `undefined`. */
  abstract remoteAuthority(): string | undefined;
  abstract openRemoteWindow(authority: string, folderPath: string): Promise<void>;
  abstract openTerminal(name: string, shellPath: string, shellArgs: readonly string[]): void;
  abstract hasExtension(id: string): boolean;
  abstract installExtension(id: string): Promise<void>;
  abstract openExternal(url: string): Promise<void>;
}
