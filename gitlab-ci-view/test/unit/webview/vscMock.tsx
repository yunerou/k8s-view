import type { ChangeEvent, FormEvent, ReactNode } from "react";

/**
 * happy-dom does not yet support `attachInternals`, so vscode-elements custom elements cannot run;
 * replace `webview-ui/components/vsc` with native elements exposing the same properties/events.
 */
interface Common {
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly "aria-label"?: string;
  readonly id?: string;
  readonly className?: string;
}

export function VscodeSingleSelect(
  props: Common & { readonly value?: string; readonly onChange?: (e: ChangeEvent<HTMLSelectElement>) => void },
) {
  return (
    <select
      id={props.id}
      aria-label={props["aria-label"]}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange?.(e)}
    >
      {props.children}
    </select>
  );
}

export function VscodeOption(props: Common & { readonly value?: string; readonly description?: string }) {
  return (
    <option value={props.value} title={props.description}>
      {props.children}
    </option>
  );
}

export function VscodeCheckbox(
  props: Common & {
    readonly checked?: boolean;
    readonly label?: string;
    readonly toggle?: boolean;
    readonly onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  },
) {
  return (
    <label>
      <input
        type="checkbox"
        checked={props.checked ?? false}
        disabled={props.disabled}
        onChange={(e) => props.onChange?.(e)}
      />
      {props.label}
    </label>
  );
}

export function VscodeButton(
  props: Common & { readonly icon?: string; readonly secondary?: boolean; readonly onClick?: () => void },
) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props["aria-label"]}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function VscodeTextfield(
  props: Common & {
    readonly value?: string;
    readonly placeholder?: string;
    readonly invalid?: boolean;
    readonly onInput?: (e: FormEvent<HTMLInputElement>) => void;
    readonly onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  },
) {
  return (
    <input
      id={props.id}
      aria-label={props["aria-label"]}
      placeholder={props.placeholder}
      value={props.value ?? ""}
      disabled={props.disabled}
      onInput={(e) => props.onInput?.(e)}
      onChange={() => undefined}
      onKeyDown={props.onKeyDown}
    />
  );
}
