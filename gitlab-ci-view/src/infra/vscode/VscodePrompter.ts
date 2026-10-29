import { injectable } from "@needle-di/core";
import * as vscode from "vscode";
import { type InputOptions, type PickItem, Prompter } from "../../app/ports/Prompter";

@injectable()
export class VscodePrompter extends Prompter {
  async pick<T>(
    items: readonly PickItem<T>[],
    options: { readonly title: string; readonly placeholder?: string },
  ): Promise<T | undefined> {
    const picked = await vscode.window.showQuickPick(
      items.map((i) => ({
        label: i.label,
        ...(i.description !== undefined ? { description: i.description } : {}),
        ...(i.detail !== undefined ? { detail: i.detail } : {}),
        value: i.value,
      })),
      {
        title: options.title,
        ...(options.placeholder !== undefined ? { placeHolder: options.placeholder } : {}),
        matchOnDescription: true,
        ignoreFocusOut: true,
      },
    );
    return picked?.value;
  }

  async input(o: InputOptions): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: o.title,
      ignoreFocusOut: true,
      ...(o.prompt !== undefined ? { prompt: o.prompt } : {}),
      ...(o.value !== undefined ? { value: o.value } : {}),
      ...(o.placeholder !== undefined ? { placeHolder: o.placeholder } : {}),
      ...(o.password ? { password: true } : {}),
      ...(o.validate ? { validateInput: o.validate } : {}),
    });
  }
}
