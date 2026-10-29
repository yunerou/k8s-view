/** Value object: a kind with discovered version/plural; keyed by `group/kind`. */
export class ResourceKind {
  constructor(
    readonly group: string,
    readonly version: string,
    readonly kind: string,
    readonly plural: string,
    readonly namespaced: boolean,
  ) {}

  static keyOf(group: string, kind: string): string {
    return `${group}/${kind}`;
  }

  static splitApiVersion(apiVersion: string): { group: string; version: string } {
    const slash = apiVersion.lastIndexOf("/");
    return slash < 0
      ? { group: "", version: apiVersion }
      : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
  }

  get key(): string {
    return ResourceKind.keyOf(this.group, this.kind);
  }

  get apiVersion(): string {
    return this.group ? `${this.group}/${this.version}` : this.version;
  }

  /** kubectl-style `kind.group`, used in commands: `deployment.apps`, `pod`. */
  get kubectlName(): string {
    return this.group ? `${this.plural}.${this.group}` : this.plural;
  }

  listPath(namespace: string | undefined): string {
    const base = this.group ? `/apis/${this.group}/${this.version}` : `/api/${this.version}`;
    return this.namespaced && namespace
      ? `${base}/namespaces/${encodeURIComponent(namespace)}/${this.plural}`
      : `${base}/${this.plural}`;
  }

  itemPath(namespace: string | undefined, name: string): string {
    return `${this.listPath(namespace)}/${encodeURIComponent(name)}`;
  }

  toString(): string {
    return this.group ? `${this.kind}.${this.group}` : this.kind;
  }
}
