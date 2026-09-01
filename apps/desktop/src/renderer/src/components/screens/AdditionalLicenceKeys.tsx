import { useState, type JSX } from "react";
import { Plus, X } from "lucide-react";

/**
 * The keys beyond the primary one.
 *
 * A one-seat vendor entitlement is the safe default. Additional keys are only editable when the
 * caller has a separately verified vendor entitlement; the renderer must never infer entitlement
 * from the number of strings in settings.json. Keys are shown by their last six characters so a
 * full credential never lands in a screenshot or the DOM.
 */

interface Props {
  /** Every key the installation may use, primary included, as stored. */
  keys: readonly string[];
  /** The primary key: listed here as the first entry and never removable from this panel. */
  primaryKey: string;
  /** Persist the new list. The store folds the primary back in and drops duplicates on read. */
  onChange: (next: string[]) => Promise<void>;
  /**
   * Whether an opaque vendor entitlement has been verified for additional local seats.
   *
   * This intentionally defaults to false. A caller must opt in with fresh vendor evidence; a
   * persisted list of keys is not evidence. Keeping this boundary in the component also protects
   * older callers that do not know about the capability yet.
   */
  additionalKeysEnabled?: boolean;
}

/** Enough to identify a key without being able to reuse it. */
function keyTail(key: string): string {
  return key.length <= 6 ? "*".repeat(key.length) : key.slice(-6);
}

export function AdditionalLicenceKeys({
  keys,
  primaryKey,
  onChange,
  additionalKeysEnabled = false,
}: Props): JSX.Element {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const primary = primaryKey.trim();
  const stored = keys.map((k) => k.trim()).filter((k) => k.length > 0);
  const extras = stored.filter((k) => k !== primary);

  async function commit(next: string[]): Promise<void> {
    setBusy(true);
    try {
      await onChange(next);
    } finally {
      setBusy(false);
    }
  }

  async function add(): Promise<void> {
    if (!additionalKeysEnabled) {
      setError("Additional licence keys require a verified vendor entitlement.");
      return;
    }
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
        {additionalKeysEnabled
          ? "Additional licence keys are enabled by a verified vendor entitlement. Changes apply on the next app launch."
           : "This installation is limited to one local profile at a time. Additional licence keys stay inactive until a vendor entitlement is verified; stored keys can still be removed."}
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
                title={
                  additionalKeysEnabled
                    ? "Remove this stored licence key"
                    : "Remove this inactive stored key; adding or activating extra seats requires vendor entitlement"
                }
                className="text-slate-600 hover:text-slate-300 disabled:text-slate-700 disabled:cursor-not-allowed transition-colors"
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
          disabled={!additionalKeysEnabled || busy}
          aria-disabled={!additionalKeysEnabled}
          className="flex-1 bg-transparent outline-none mono text-[12px] text-slate-300 placeholder:text-slate-600"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={!additionalKeysEnabled || busy || draft.trim().length === 0}
          className="text-[11px] px-2 py-1 rounded-md text-purple-300 hover:text-purple-200 disabled:text-slate-600 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
          style={{ boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.25)" }}
        >
          <Plus size={11} />
          Add
        </button>
      </div>

      {error && <div className="text-[11px] text-amber-400/80 mt-1.5">{error}</div>}

      {extras.length > 0 && (
        <div className="text-[11px] text-slate-500 mt-2 leading-relaxed">
          {additionalKeysEnabled
            ? "Stored additional keys remain local and are used only after the verified entitlement is active."
            : "Stored additional keys are preserved but inactive. Nothing is deleted; verify an entitlement before enabling them."}
        </div>
      )}
    </div>
  );
}
