/** `value` of the event's source element (vscode-single-select, vscode-textfield). */
export function eventValue(e: { readonly target: EventTarget | null }): string {
  const v = (e.target as { value?: unknown } | null)?.value;
  return typeof v === "string" ? v : "";
}

/** `checked` of vscode-checkbox. */
export function eventChecked(e: { readonly target: EventTarget | null }): boolean {
  return (e.target as { checked?: unknown } | null)?.checked === true;
}
