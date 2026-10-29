/** Base64-decoded Secret key value: UTF-8 text, or binary (retained as base64). */
export type DecodedSecretValue =
  | { readonly key: string; readonly type: "text"; readonly text: string }
  | { readonly key: string; readonly type: "binary"; readonly size: number; readonly base64: string };

const decoder = new TextDecoder("utf-8", { fatal: true });
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters other than tabs/newlines indicate binary data
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/** Decode Secret `data` (base64), ordered by key. */
export function decodeSecretData(data: Readonly<Record<string, string>> | undefined): DecodedSecretValue[] {
  return Object.keys(data ?? {})
    .sort()
    .map((key): DecodedSecretValue => {
      const base64 = (data![key] ?? "").replace(/\s/g, "");
      const bytes = Buffer.from(base64, "base64");
      try {
        const text = decoder.decode(bytes);
        if (!CONTROL.test(text)) return { key, type: "text", text };
      } catch {
        // Not valid UTF-8
      }
      return { key, type: "binary", size: bytes.length, base64 };
    });
}
