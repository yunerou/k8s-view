export function Codicon({ name, className }: { readonly name: string; readonly className?: string | undefined }) {
  return <span className={`codicon codicon-${name}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}
