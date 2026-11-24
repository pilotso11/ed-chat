import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { keyList, type Keys, type Settings } from "../core/settings.js";
import {
  acceleratorFromKey,
  chipPatternFromKey,
  getAt,
  keyProblems,
  resetAll,
  type FormField,
  type FormSection,
  type KeyInput,
} from "../core/settingsForm.js";
import { sameValue } from "../core/paths.js";
import type { SettingsSnapshot } from "../shared/settingsIpc.js";

// The settings window. It edits settings.json through main: the form shows the settings in use,
// keeps the player's edits until Save, and main writes only the values that differ from the
// defaults. A settings.json that does not parse is never overwritten: the window shows the error.

const keyInput = (e: KeyboardEvent): KeyInput => ({
  key: e.key,
  code: e.code,
  ctrl: e.ctrlKey,
  alt: e.altKey,
  shift: e.shiftKey,
  meta: e.metaKey,
});

/** Whether the field, or a section, matches the search. */
const matches = (f: FormField, q: string) =>
  !q || `${f.label} ${f.help} ${f.path}`.toLowerCase().includes(q);
const sectionMatches = (s: FormSection, q: string): boolean =>
  s.fields.some((f) => matches(f, q)) || s.sections.some((c) => sectionMatches(c, q));

/** The text shown for a value that is edited as text: lists one to a line, JSON, numbers. */
function textOf(f: FormField, v: unknown): string {
  if (f.kind.type === "list") return (v as string[]).join("\n");
  if (f.kind.type === "json") return JSON.stringify(v, null, 2);
  if (v === null || v === undefined) return "";
  return String(v);
}

interface FieldProps {
  field: FormField;
  value: unknown;
  draft: string | undefined;
  error: string | undefined;
  displays: number;
  onValue(v: unknown): void;
  /** Text typed in a field that must parse first; error is why it does not. */
  onDraft(text: string, value: unknown, error?: string): void;
}

function KeysControl({ field, value, onValue }: FieldProps & { value: Keys }) {
  const chip = field.kind.type === "keys" && field.kind.chip;
  const keys = keyList(value);
  // The key being captured: its index, or keys.length for a new one.
  const [capturing, setCapturing] = useState<number | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const set = (next: string[]) => onValue(next.length === 1 ? next[0] : next);
  const onKeyDown = (e: KeyboardEvent) => {
    if (capturing === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturing(null);
      setHint(null);
      return;
    }
    const k = keyInput(e);
    const acc = chip ? chipPatternFromKey(k) : acceleratorFromKey(k);
    if (!acc) {
      // Only modifiers so far, or a chip key without a digit.
      if (chip && acceleratorFromKey(k)) setHint("Hold the modifiers and press a digit, 1 to 9");
      return;
    }
    const next = [...keys];
    next[capturing] = acc;
    setCapturing(null);
    setHint(null);
    set([...new Set(next)]);
  };
  return (
    <div className="keys" onKeyDown={onKeyDown}>
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="key">
          <button
            type="button"
            className={capturing === i ? "capture on" : "capture"}
            onClick={() => setCapturing(i)}
            onBlur={() => capturing === i && setCapturing(null)}
            title="Click, then press the new key"
          >
            {capturing === i ? "Press keys… (Esc cancels)" : k}
          </button>
          {keys.length > 1 && (
            <button
              type="button"
              className="remove"
              aria-label={`Remove ${k}`}
              onClick={() => set(keys.filter((_, j) => j !== i))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {capturing === keys.length ? (
        <button type="button" className="capture on" autoFocus onBlur={() => setCapturing(null)}>
          Press keys… (Esc cancels)
        </button>
      ) : (
        <button type="button" className="add" onClick={() => setCapturing(keys.length)}>
          + Add key
        </button>
      )}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function Control(p: FieldProps) {
  const { field: f, value, draft } = p;
  const id = `f-${f.path}`;
  switch (f.kind.type) {
    case "boolean":
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => p.onValue(e.target.checked)}
        />
      );
    case "choice": {
      const options = f.kind.options;
      return (
        <select
          id={id}
          value={String(value)}
          onChange={(e) =>
            p.onValue(options.find((o) => String(o) === e.target.value) ?? e.target.value)
          }
        >
          {options.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      );
    }
    case "display": {
      const n = Math.max(p.displays, typeof value === "number" ? value + 1 : 0);
      return (
        <select
          id={id}
          value={String(value)}
          onChange={(e) =>
            p.onValue(e.target.value === "primary" ? "primary" : Number(e.target.value))
          }
        >
          <option value="primary">primary</option>
          {Array.from({ length: n }, (_, i) => (
            <option key={i} value={String(i)}>
              monitor {i}
            </option>
          ))}
        </select>
      );
    }
    case "number": {
      const { integer, min, max, above } = f.kind;
      return (
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={integer ? 1 : "any"}
          value={draft ?? textOf(f, value)}
          onChange={(e) => {
            const t = e.target.value.trim();
            const n = Number(t);
            const bad =
              t === "" || !Number.isFinite(n)
                ? "Enter a number"
                : integer && !Number.isInteger(n)
                  ? "Enter a whole number"
                  : above !== undefined && n <= above
                    ? `More than ${above}${max !== undefined ? `, up to ${max}` : ""}`
                    : (min !== undefined && n < min) || (max !== undefined && n > max)
                      ? `From ${min ?? "-∞"} to ${max ?? "∞"}`
                      : undefined;
            p.onDraft(e.target.value, bad ? undefined : n, bad);
          }}
        />
      );
    }
    case "text":
      return (
        <input
          id={id}
          type="text"
          spellCheck={false}
          placeholder={f.kind.nullable ? "(not set)" : undefined}
          value={(value as string | null) ?? ""}
          onChange={(e) =>
            p.onValue(
              f.kind.type === "text" && f.kind.nullable && e.target.value.trim() === ""
                ? null
                : e.target.value,
            )
          }
        />
      );
    case "list":
      return (
        <textarea
          id={id}
          rows={3}
          spellCheck={false}
          placeholder="One to a line"
          value={draft ?? textOf(f, value)}
          onChange={(e) =>
            p.onDraft(
              e.target.value,
              e.target.value
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
            )
          }
        />
      );
    case "json":
      return (
        <textarea
          id={id}
          rows={8}
          spellCheck={false}
          value={draft ?? textOf(f, value)}
          onChange={(e) => {
            try {
              p.onDraft(e.target.value, JSON.parse(e.target.value));
            } catch {
              p.onDraft(e.target.value, undefined, "Not valid JSON");
            }
          }}
        />
      );
    case "keys":
      return <KeysControl {...p} value={value as Keys} />;
  }
}

export function SettingsApp() {
  const api = window.settingsApi;
  const [snap, setSnap] = useState<SettingsSnapshot | null>(null);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<{ error: string; path?: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  // For reload, which outlives a render: the edits and errors when the new values arrive.
  const kept = useRef({ edits, errors });
  kept.current = { edits, errors };

  const reload = useCallback(() => {
    void api.load().then((s) => {
      setSnap(s);
      // Text typed into a field that is not an edit (it matched the old value) would hide the
      // new value; text that is an edit, or not valid yet, stays.
      setDrafts((d) =>
        Object.fromEntries(
          Object.entries(d).filter(([p]) => p in kept.current.edits || p in kept.current.errors),
        ),
      );
    });
  }, [api]);
  useEffect(() => {
    reload();
    api.onChanged(reload);
  }, [api, reload]);

  const valueOf = useCallback(
    (path: string): unknown => (path in edits ? edits[path] : getAt(snap?.values, path)),
    [edits, snap],
  );

  const problems = useMemo(() => {
    if (!snap) return {};
    const h = { ...snap.values.hotkeys };
    for (const k of Object.keys(h) as (keyof Settings["hotkeys"])[])
      (h as Record<string, unknown>)[k] = valueOf(`hotkeys.${k}`);
    return keyProblems(h, snap.failedKeys);
  }, [snap, valueOf]);

  if (!snap) return <div className="settings loading">Loading…</div>;

  if (snap.fileError)
    return (
      <div className="settings broken">
        <h1>Settings</h1>
        <p className="error">{snap.fileError}</p>
        <p>
          settings.json has an error, so this window cannot change it. Fix the file, and this window
          shows the settings again.
        </p>
        <button type="button" onClick={() => api.openFile()}>
          Open settings.json
        </button>
      </div>
    );

  const setValue = (path: string, v: unknown) => {
    setStatus(null);
    setSaveError(null);
    setEdits((e) => {
      const next = { ...e };
      if (sameValue(v, getAt(snap.values, path))) delete next[path];
      else next[path] = v;
      return next;
    });
  };
  const clearDraft = (path: string) => {
    setDrafts(({ [path]: _d, ...rest }) => rest);
    setErrors(({ [path]: _e, ...rest }) => rest);
  };
  const setDraft = (path: string, text: string, v: unknown, error?: string) => {
    setDrafts((d) => ({ ...d, [path]: text }));
    setErrors(({ [path]: _e, ...rest }) => (error ? { ...rest, [path]: error } : rest));
    if (!error) setValue(path, v);
    else setStatus(null);
  };
  const reset = (f: FormField) => {
    clearDraft(f.path);
    setValue(f.path, f.default);
  };
  const revert = () => {
    setEdits({});
    setDrafts({});
    setErrors({});
    setSaveError(null);
    setStatus(null);
  };
  const resetEverything = () => {
    setDrafts({});
    setErrors({});
    setSaveError(null);
    setStatus("Every setting is set to its default. Save to keep it.");
    const next: Record<string, unknown> = {};
    for (const c of resetAll(snap.sections))
      if (!sameValue(c.value, getAt(snap.values, c.path))) next[c.path] = c.value;
    setEdits(next);
  };
  const dirty = Object.keys(edits).length > 0;
  const blocked = Object.keys(errors).length > 0;
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const r = await api.save(Object.entries(edits).map(([path, value]) => ({ path, value })));
      if (!r.ok) {
        setSaveError({ error: r.error, path: r.path });
        return;
      }
      setEdits({});
      setDrafts({});
      setSaveError(null);
      setStatus("Saved. The changes are in use.");
      reload();
    } catch (err) {
      setSaveError({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const q = query.trim().toLowerCase();

  const fieldRow = (f: FormField) => {
    const value = valueOf(f.path);
    const edited = f.path in edits;
    const isDefault = sameValue(value, f.default);
    const err =
      errors[f.path] ??
      (saveError?.path && (saveError.path === f.path || saveError.path.startsWith(`${f.path}.`))
        ? saveError.error
        : undefined);
    const problem = problems[f.path];
    return (
      <div key={f.path} className={`field${edited ? " edited" : ""}`} data-path={f.path}>
        <label htmlFor={`f-${f.path}`} className="label">
          {f.label}
          {f.playerOnly && (
            <span className="lock" title="Only you can change this. The assistant cannot.">
              {" "}
              🔒
            </span>
          )}
        </label>
        <div className="control">
          <Control
            field={f}
            value={value}
            draft={drafts[f.path]}
            error={err}
            displays={snap.displays}
            onValue={(v) => setValue(f.path, v)}
            onDraft={(t, v, e) => setDraft(f.path, t, v, e)}
          />
          <button
            type="button"
            className="reset"
            disabled={isDefault && !(f.path in drafts)}
            title={`Default: ${JSON.stringify(f.default)}`}
            onClick={() => reset(f)}
          >
            Reset
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {problem && <div className="warn">⚠ {problem}</div>}
        {f.help && <div className="help">{f.help}</div>}
      </div>
    );
  };

  const sectionBlock = (s: FormSection, depth: number): ReactNode => {
    if (!sectionMatches(s, q)) return null;
    const H = depth === 0 ? "h2" : "h3";
    return (
      <section key={s.path} id={`s-${s.path}`} className={`section depth-${depth}`}>
        <H>{s.title}</H>
        {s.help && <p className="section-help">{s.help}</p>}
        {s.fields.filter((f) => matches(f, q)).map(fieldRow)}
        {s.sections.map((c) => sectionBlock(c, depth + 1))}
      </section>
    );
  };

  const shown = snap.sections.filter((s) => sectionMatches(s, q));
  return (
    <div className="settings">
      <header>
        <h1>Settings</h1>
        <input
          className="search"
          type="search"
          placeholder="Search settings"
          aria-label="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={!dirty || blocked || saving}
            onClick={save}
          >
            Save
          </button>
          <button type="button" disabled={!dirty && !blocked} onClick={revert}>
            Revert
          </button>
          <button type="button" onClick={resetEverything}>
            Reset all
          </button>
          <button type="button" onClick={() => api.openFile()}>
            Open settings.json
          </button>
        </div>
      </header>
      {(status || saveError) && (
        <div className={saveError ? "banner error" : "banner"} role="status">
          {saveError ? `Not saved: ${saveError.error}` : status}
        </div>
      )}
      <div className="body">
        <nav>
          {shown.map((s) => (
            <a
              key={s.path}
              href={`#s-${s.path}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(`s-${s.path}`)?.scrollIntoView?.({ block: "start" });
              }}
            >
              {s.title}
            </a>
          ))}
        </nav>
        <main>
          {shown.length ? (
            shown.map((s) => sectionBlock(s, 0))
          ) : (
            <p className="empty">No setting matches “{query}”.</p>
          )}
        </main>
      </div>
    </div>
  );
}
