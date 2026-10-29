export interface PickItem<T> {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly value: T;
}

export interface InputOptions {
  readonly title: string;
  readonly prompt?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly password?: boolean;
  /** Return an error message, or `undefined` if valid. */
  readonly validate?: (value: string) => string | undefined;
}

/** Port: Quick Pick / Input Box. `undefined` = user canceled. */
export abstract class Prompter {
  abstract pick<T>(
    items: readonly PickItem<T>[],
    options: { readonly title: string; readonly placeholder?: string },
  ): Promise<T | undefined>;
  abstract input(options: InputOptions): Promise<string | undefined>;
}
