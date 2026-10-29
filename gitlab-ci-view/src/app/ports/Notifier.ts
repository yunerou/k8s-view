/** Port: VS Code notifications; returns the button clicked by the user. */
export abstract class Notifier {
  abstract info(message: string, ...actions: string[]): Promise<string | undefined>;
  abstract warn(message: string, ...actions: string[]): Promise<string | undefined>;
  abstract error(message: string, ...actions: string[]): Promise<string | undefined>;
}
