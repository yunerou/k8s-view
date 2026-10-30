import { useEffect, useState } from "react";
import { type TagEditorInit, TagRequests } from "../../src/shared/protocol";
import { type TagRow, validateTags } from "../../src/shared/tags";
import { Banner } from "../components/Banner";
import { Codicon } from "../components/Codicon";
import { VscodeButton, VscodeTextfield } from "../components/vsc";
import { eventValue } from "../shared/events";
import { request } from "../shared/messenger";

interface EditRow extends TagRow {
  /** Stable React key while rows are added and removed. */
  readonly id: number;
}

let nextId = 0;
const withId = (row: TagRow): EditRow => ({ ...row, id: nextId++ });
const emptyRow = () => withId({ key: "", value: "" });

function hiddenText(count: number): string {
  return count === 1
    ? "1 tag managed by AWS (aws:…) is hidden and stays unchanged."
    : `${count} tags managed by AWS (aws:…) are hidden and stay unchanged.`;
}

export function TagApp() {
  const [init, setInit] = useState<TagEditorInit>();
  const [rows, setRows] = useState<EditRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void request(TagRequests.getInit)
      .then((i) => {
        setInit(i);
        setRows([...i.rows.map(withId), emptyRow()]);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (!init) return error ? <Banner kind="error">{error}</Banner> : <p className="muted">Loading tags…</p>;

  const validation = validateTags(rows);
  const invalid = validation.error !== undefined || validation.rows.some((e) => e !== undefined);
  const update = (id: number, patch: Partial<TagRow>) =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const result = await request(TagRequests.save, { rows: rows.map(({ key, value }) => ({ key, value })) });
      if (result.error) setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="tags">
      <h1>
        Tags · {init.label} <span className="muted">{init.instanceId}</span>
      </h1>
      {error && <Banner kind="error">{error}</Banner>}
      {validation.error && <Banner kind="warning">{validation.error}</Banner>}
      {init.readOnlyCount > 0 && <p className="muted">{hiddenText(init.readOnlyCount)}</p>}
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, index) => {
            const problem = validation.rows[index];
            return (
              <tr key={r.id}>
                <td>
                  <VscodeTextfield
                    aria-label={`Key ${index + 1}`}
                    value={r.key}
                    invalid={problem !== undefined}
                    onInput={(e) => update(r.id, { key: eventValue(e) })}
                  />
                  {problem && <div className="field-error">{problem}</div>}
                </td>
                <td>
                  <VscodeTextfield
                    aria-label={`Value ${index + 1}`}
                    value={r.value}
                    onInput={(e) => update(r.id, { value: eventValue(e) })}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="icon-button"
                    title="Remove tag"
                    aria-label={`Remove tag ${index + 1}`}
                    onClick={() => setRows((current) => current.filter((x) => x.id !== r.id))}
                  >
                    <Codicon name="trash" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="actions">
        <VscodeButton secondary onClick={() => setRows((current) => [...current, emptyRow()])}>
          Add tag
        </VscodeButton>
        <span className="spacer" />
        <VscodeButton secondary onClick={() => void request(TagRequests.cancel)}>
          Cancel
        </VscodeButton>
        <VscodeButton disabled={invalid || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </VscodeButton>
      </div>
    </main>
  );
}
