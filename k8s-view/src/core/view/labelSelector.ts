interface Requirement {
  readonly key: string;
  readonly operator: string;
  readonly values?: readonly string[];
}

/**
 * Map selectors (Service.spec.selector) or LabelSelector (matchLabels/matchExpressions).
 * Empty selectors match nothing: used to find children, not list everything.
 */
export function matchesSelector(selector: unknown, labels: Readonly<Record<string, string>>): boolean {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) return false;
  const s = selector as Record<string, unknown>;
  const isLabelSelector = "matchLabels" in s || "matchExpressions" in s;
  const matchLabels = (isLabelSelector ? s["matchLabels"] : s) as Record<string, string> | undefined;
  const expressions = (isLabelSelector ? s["matchExpressions"] : undefined) as Requirement[] | undefined;
  const entries = Object.entries(matchLabels ?? {});
  if (entries.length === 0 && (expressions?.length ?? 0) === 0) return false;
  if (!entries.every(([k, v]) => labels[k] === v)) return false;
  return (expressions ?? []).every((r) => {
    const has = Object.hasOwn(labels, r.key);
    const value = labels[r.key];
    switch (r.operator) {
      case "In":
        return has && (r.values ?? []).includes(value!);
      case "NotIn":
        return !has || !(r.values ?? []).includes(value!);
      case "Exists":
        return has;
      case "DoesNotExist":
        return !has;
      default:
        return false;
    }
  });
}
