import { useEffect, useState, type JSX } from "react";
import type { ProfileSummary } from "../../types";
import { profileDeletionConfirmation } from "../../../../shared/profile-deletion-contract";

interface Props {
  open: boolean;
  profile: ProfileSummary | null;
  onConfirm: (profileId: string, confirmation: string) => Promise<void>;
  onCancel: () => void;
}

export function DeleteProfileDialog(props: Props): JSX.Element | null {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expected = props.profile ? profileDeletionConfirmation(props.profile.id) : "";
  const blocked = props.profile?.isRunning ?? true;
  const canSubmit = value === expected && !blocked && !busy;

  useEffect(() => {
    if (props.open) {
      setValue("");
      setError(null);
    }
  }, [props.open, props.profile?.id]);

  if (!props.open || !props.profile) return null;

  async function submit(): Promise<void> {
    if (!canSubmit || !props.profile) return;
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(props.profile.id, value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(5,6,10,0.68)", backdropFilter: "blur(10px)" }}
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) props.onCancel();
      }}
    >
      <div
        className="w-[min(520px,calc(100vw-32px))] rounded-2xl p-6"
        style={{
          background: "rgba(17,18,24,0.97)",
          boxShadow: "inset 0 0 0 1px rgba(248,113,113,0.24), 0 32px 90px rgba(0,0,0,0.68)",
        }}
      >
        <div className="text-[15px] font-bold text-red-200">Permanently delete this profile?</div>
        <div className="mt-2 text-[13px] font-semibold text-slate-100">{props.profile.name}</div>
        <div className="mono mt-1 break-all text-[11px] text-slate-500">{props.profile.id}</div>

        <p className="mt-4 text-[12.5px] leading-relaxed text-slate-400">
          Cookies, login sessions, browsing state, and this profile directory will be permanently
          removed. MKTTool, Relay configuration, device credentials, and MultiZen data are not
          touched.
        </p>

        {props.profile.deletionPending && (
          <p className="mt-3 rounded-lg bg-amber-400/8 px-3 py-2 text-[11.5px] text-amber-200 ring-1 ring-inset ring-amber-300/20">
            A previous deletion attempt did not finish. Retrying resumes only this profile cleanup.
          </p>
        )}
        {blocked && (
          <p className="mt-3 rounded-lg bg-red-400/8 px-3 py-2 text-[11.5px] text-red-200 ring-1 ring-inset ring-red-300/20">
            Close this profile and wait for Chromium to exit before deleting it.
          </p>
        )}

        <label className="mt-4 block text-[11px] font-medium text-slate-500">
          Type this exact confirmation
        </label>
        <div className="mono mt-1.5 select-all break-all rounded-lg bg-black/25 px-3 py-2 text-[11px] text-red-200">
          {expected}
        </div>
        <input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={busy || blocked}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) props.onCancel();
            if (event.key === "Enter") void submit();
          }}
          className="mono mt-2 w-full rounded-[10px] border-0 bg-white/[0.04] px-3 py-2.5 text-[12px] text-slate-100 outline-none ring-1 ring-inset ring-white/[0.08] disabled:opacity-45"
          aria-label="Profile deletion confirmation"
        />

        {error && <div className="mt-3 text-[11.5px] leading-relaxed text-red-300">{error}</div>}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            className="btn-ghost rounded-[9px] px-3 py-[7px] text-[12px] disabled:opacity-45"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            className="rounded-[9px] border-0 bg-red-500/15 px-3 py-[7px] text-[12px] text-red-200 ring-1 ring-inset ring-red-400/35 disabled:cursor-not-allowed disabled:opacity-35"
            onClick={() => void submit()}
          >
            {busy
              ? "Deleting..."
              : props.profile.deletionPending
                ? "Finish deletion"
                : "Permanently delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
