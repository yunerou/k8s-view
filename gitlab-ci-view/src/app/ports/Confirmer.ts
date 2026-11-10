/** Port: explicit approval in VS Code for every MCP mutation. */
export abstract class Confirmer {
  abstract confirm(title: string, detail: string): Promise<boolean>;
}
