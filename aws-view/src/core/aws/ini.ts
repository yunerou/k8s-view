export type IniSections = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * AWS-style INI: `[section]`, `key = value`, full-line and inline (`  # …`) comments.
 * Indented lines under an empty-valued key (e.g. `s3 =`) become `parent.child`.
 */
export function parseIni(text: string): IniSections {
  const sections: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  let parent: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+[#;].*$/, "");
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      const name = (header[1] ?? "").trim().replace(/\s+/g, " ");
      sections[name] ??= {};
      current = sections[name];
      parent = undefined;
      continue;
    }
    const kv = /^(\s*)([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!current || !kv) continue;
    const [, indent = "", rawKey = "", rawValue = ""] = kv;
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (indent) {
      if (parent) current[`${parent}.${key}`] = value;
      continue;
    }
    current[key] = value;
    parent = value === "" ? key : undefined;
  }
  return sections;
}

export function serializeIni(sections: IniSections): string {
  const blocks = Object.entries(sections).map(([name, values]) =>
    [`[${name}]`, ...Object.entries(values).map(([k, v]) => `${k} = ${v}`)].join("\n"),
  );
  return `${blocks.join("\n\n")}\n`;
}
