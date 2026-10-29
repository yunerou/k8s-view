export type NamespaceScope = { readonly type: "single"; readonly name: string } | { readonly type: "all" }; // Multiple simultaneous namespaces: a later phase

/** Entity: selected context and namespace scope. Immutable; changing scope creates a new instance. */
export class ClusterContext {
  constructor(
    readonly name: string,
    readonly cluster: string,
    readonly user: string,
    readonly scope: NamespaceScope,
    readonly isProtected: boolean,
  ) {}

  withScope(scope: NamespaceScope): ClusterContext {
    return new ClusterContext(this.name, this.cluster, this.user, scope, this.isProtected);
  }

  /** Namespace when a single namespace is selected; `undefined` = All namespaces. */
  get namespace(): string | undefined {
    return this.scope.type === "single" ? this.scope.name : undefined;
  }

  equals(other: ClusterContext | undefined): boolean {
    return (
      !!other && other.name === this.name && other.namespace === this.namespace && other.scope.type === this.scope.type
    );
  }
}

export function scopeLabel(scope: NamespaceScope): string {
  return scope.type === "all" ? "All namespaces" : scope.name;
}

/** `k8sView.context.protected` is a list of regexes matching the entire context name. */
export function isProtectedContext(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    try {
      return new RegExp(`^(?:${p})$`).test(name);
    } catch {
      return false;
    }
  });
}
