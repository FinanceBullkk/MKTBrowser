import { useState, type JSX } from "react";
import { Plus, X } from "lucide-react";

/**
 * The keys beyond the primary one, and what they buy.
 *
 * The engine binds a session to the key it was handed at spawn and refuses a second one, so
 * concurrency is per key: N keys the operator holds means up to N profiles open at once. The pool
 * and the launch-time rotation for that already existed; what did not exist was any way to tell the
 * app about a second key. `settings.json` accepted a list, the UI offered one text box, and the
 * only route to a second key was editing the file by hand — which is not a route.
 *
 * Keys are shown by their last six characters. That is enough to recognise which key an operator is
 * removing, and a full key rendered into the DOM is a credential sitting in a screenshot.
 */

interface Props {
  /** Every key the installation may use, primary included, as stored. */
  keys: readonly string[];
  /** The primary key: listed here as the first entry and never removable from this panel. */
  primaryKey: string;
  /** Persist the new list. The store folds the primary back in and drops duplicates on read. */
  onChange: (next: string[]) => Promise<void>;
}

/** Enough to identify a key without being able to reuse it. */
function keyTail(key: string): string {
  return key.length <= 6 ? "*".repeat(key.length) : key.slice(-6);
}

export function AdditionalLicenceKeys({ keys, primaryKey, onChange }: Props): JSX.Element {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const primary = primaryKey.trim();
  const stored = keys.map((k) => k.trim()).filter((k) => k.length > 0);
  const extras = stored.filter((k) => k !== primary);
  // The primary counts towards capacity even when it is not in the stored list, because the store
  // folds it in. Showing a total that disagrees with what the engine will do would be worse than
  // showing nothing.
  const total = (primary ? 1 : 0) + extras.length;

  async function commit(next: string[]): Promise<void> {
    setBusy(true);
    try {
      await onChange(next);
    } finally {
      setBusy(false);
    }
  }

  async function add(): Promise<void> {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === primary || extras.includes(trimmed)) {
      // Two slots on one key would advertise two sessions where the engine grants one: the operator
      // would be told a profile can open and then be refused.
      setError("That key is already in the list.");
      return;
    }
    setError(null);
    await commit([primary, ...extras, trimmed].filter(Boolean));
    setDraft("");
  }

  async function remove(key: string): Promise<void> {
    setError(null);
    await commit([primary, ...extras.filter((k) => k !== key)].filter(Boolean));
  }

  return (
    <div className="mt-3">
      <div className="text-[11px] text-slate-500 leading-relaxed">
        One key opens one profile at a time. Hold more keys to open more at once — a refused key is
        rested and the next one is tried automatically. Applied on next app launch.
      </div>

      {(extras.length > 0 || primary) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {primary && (
            <span
              className="mono text-[11px] text-slate-400 px-2 py-1 rounded-md"
              style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
              title="The primary key, edited in the field above"
            >
              …{keyTail(primary)}
              <span className="text-slate-600"> primary</span>
            </span>
          )}
          {extras.map((key) => (
            <span
              key={key}
              className="mono text-[11px] text-slate-400 px-2 py-1 rounded-md flex items-center gap-1.5"
              style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
            >
              …{keyTail(key)}
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(key)}
                aria-label={`Remove licence key ending ${keyTail(key)}`}
                className="text-slate-600 hover:text-slate-300 disabled:text-slate-700 transition-colors"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className="flex items-center gap-2 mt-2"
        style={{
          padding: "6px 10px",
          borderRadius: 10,
          background: "rgba(255,255,255,0.03)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
        }}
      >
        <input
          type="password"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="Add another CloakBrowser key"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent outline-none mono text-[12px] text-slate-300 placeholder:text-slate-600"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy || draft.trim().length === 0}
          className="text-[11px] px-2 py-1 rounded-md text-purple-300 hover:text-purple-200 disabled:text-slate-600 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
          style={{ boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.25)" }}
        >
          <Plus size={11} />
          Add
        </button>
      </div>

      {error && <div className="text-[11px] text-amber-400/80 mt-1.5">{error}</div>}

      {total > 0 && (
        <div className="text-[11px] text-slate-500 mt-2">
          <span className="mono text-slate-400">{total}</span>{" "}
          {total === 1 ? "key" : "keys"} — up to{" "}
          <span className="mono text-slate-400">{total}</span>{" "}
          {total === 1 ? "profile" : "profiles"} open at once.
        </div>
      )}
    </div>
  );
}
