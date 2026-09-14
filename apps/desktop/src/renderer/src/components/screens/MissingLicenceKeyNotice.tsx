import { type JSX } from "react";
import { KeyRound } from "lucide-react";

interface Props {
  onOpenSettings: () => void;
}

/**
 * Shown on every screen until this install has a licence key of its own.
 *
 * Settings already explained the key, but only to someone who went looking. An operator who never
 * opens Settings runs the keyless 146 build indefinitely and is never told that a key exists, let
 * alone that it is theirs to register — the exact gap the unfamiliar-operator gate is there to
 * find. It is not a modal and not dismissible: nothing is blocked, and it stops appearing the
 * moment a key is saved, so it cannot become noise to click away.
 */
export function MissingLicenceKeyNotice({ onOpenSettings }: Props): JSX.Element {
  return (
    <div
      className="flex items-center gap-3 px-4 py-2 text-[12px]"
      style={{
        background: "rgba(168,85,247,0.06)",
        boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.06)",
      }}
    >
      <KeyRound size={14} strokeWidth={1.5} className="text-purple-300 shrink-0" />
      <span className="text-slate-400 leading-relaxed">
        No CloakBrowser key on this install — profiles still open, on the older keyless build (146,
        May 2026). <span className="text-slate-300">The key is yours to register</span>, not one to
        borrow: a key allows one browser at a time, so a shared key means a shared queue.
      </span>
      <div className="flex items-center gap-2 ml-auto shrink-0">
        <button
          type="button"
          onClick={() => void window.mktBrowser.system.openLicenceSignup()}
          className="px-2 py-1 rounded-md text-purple-300 hover:text-purple-200 transition-colors"
          style={{ boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.25)" }}
        >
          Register a key
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="px-2 py-1 rounded-md text-slate-400 hover:text-slate-200 transition-colors"
        >
          Open Settings
        </button>
      </div>
    </div>
  );
}
