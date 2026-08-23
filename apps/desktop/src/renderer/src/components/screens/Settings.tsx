import { useEffect, useState, type JSX, type ReactNode } from "react";
import {
  Boxes,
  Check,
  Chrome,
  Copy,
  DownloadCloud,
  Eye,
  EyeOff,
  KeyRound,
  Sparkles,
  Zap,
} from "lucide-react";
import { Pill } from "../atoms";
import { AdditionalLicenceKeys } from "./AdditionalLicenceKeys";
import type { AppSettings, ChromiumStatus, SystemInfo } from "../../types";

interface Props {
  onImport: () => void;
}

export function Settings({ onImport }: Props): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenShown, setTokenShown] = useState(false);
  // The licence key is edited as a draft rather than patched per keystroke:
  // every patch writes settings.json, and a 35-character key would mean 35
  // writes. Saved explicitly instead.
  const [licenceDraft, setLicenceDraft] = useState("");
  const [licenceShown, setLicenceShown] = useState(false);
  const [licenceSaved, setLicenceSaved] = useState(false);
  // Which engine build is actually live — the only honest confirmation that a
  // key took effect (146 keyless vs a current major). Already exposed on the
  // chromium channel, so no new IPC surface is needed here.
  const [engineStatus, setEngineStatus] = useState<ChromiumStatus | null>(null);
  // Upgrading is a deliberate act, not a background one: a new Chromium moves
  // the measured fingerprint of every profile at once, so it is guarded by an
  // explicit confirm rather than a single click.
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  useEffect(() => {
    if (!window.mktBrowser) return;
    void window.mktBrowser.settings.get().then((s) => {
      setSettings(s);
      setLicenceDraft(s.cloakBrowserLicenseKey);
    });
    void window.mktBrowser.system.info().then(setInfo);
    void window.mktBrowser.chromium.status().then(setEngineStatus);
    return window.mktBrowser.chromium.onStatus(setEngineStatus);
  }, []);

  async function patch(p: Partial<AppSettings>): Promise<void> {
    if (!settings) return;
    const next = await window.mktBrowser.settings.update(p);
    setSettings(next);
  }

  async function activateLatestEngine(): Promise<void> {
    setUpgrading(true);
    setUpgradeError(null);
    try {
      setEngineStatus(await window.mktBrowser.chromium.activateLatest());
    } catch (error) {
      setUpgradeError((error as Error).message);
    } finally {
      setUpgrading(false);
      setConfirmUpgrade(false);
    }
  }

  async function saveLicence(): Promise<void> {
    const trimmed = licenceDraft.trim();
    // Replacing the primary must not leave the old key in the pool. The store folds the primary
    // back into the list on read, so without this a swap would quietly keep both and rotation
    // would spend an attempt — and a cooldown — on a key the operator has just retired.
    const previous = settings?.cloakBrowserLicenseKey.trim() ?? "";
    const kept = (settings?.cloakBrowserLicenseKeys ?? [])
      .map((k) => k.trim())
      .filter((k) => k.length > 0 && k !== previous && k !== trimmed);
    await patch({
      cloakBrowserLicenseKey: trimmed,
      cloakBrowserLicenseKeys: trimmed ? [trimmed, ...kept] : kept,
    });
    setLicenceDraft(trimmed);
    setLicenceSaved(true);
    window.setTimeout(() => setLicenceSaved(false), 1800);
  }

  function copyMcpUrl(): void {
    if (!info?.mcpHttpUrl) return;
    navigator.clipboard.writeText(info.mcpHttpUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function copyMcpToken(): void {
    if (!info?.mcpAuthToken) return;
    navigator.clipboard.writeText(info.mcpAuthToken);
    setTokenCopied(true);
    window.setTimeout(() => setTokenCopied(false), 1500);
  }

  if (!settings) {
    return (
      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-[720px] mx-auto text-[13px] text-slate-500">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto" style={{ padding: "24px 32px" }}>
      <div className="max-w-[720px] mx-auto">
        <div className="text-lg font-bold tracking-tight text-slate-100 mb-1.5">Settings</div>
        <div className="text-[13px] text-slate-500 mb-5">
          Profile data and configuration stay on this device. This technical build has no
          application update or usage-reporting channel.
        </div>

        <Row
          icon={<Zap size={16} strokeWidth={1.5} />}
          title="MCP server"
          desc="Local HTTP transport for profile management. The current token cannot control or read browser pages, cookies, or raw CDP, and this build does not issue a page-control token. The MCP tab has ready-to-paste client configs."
        >
          <div className="flex gap-2 items-center flex-wrap">
            <Pill kind={info?.mcpHttpUrl ? "running" : "idle"} dot={!!info?.mcpHttpUrl}>
              {info?.mcpHttpUrl ? `running on :${new URL(info.mcpHttpUrl).port}` : "off"}
            </Pill>

            {info?.mcpHttpUrl && (
              <div
                className="flex-1 min-w-[260px] flex items-center gap-2"
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                }}
              >
                <span className="flex-1 mono text-[12px] text-slate-300 truncate">
                  {info.mcpHttpUrl}
                </span>
                <button
                  type="button"
                  onClick={copyMcpUrl}
                  className="text-purple-400 hover:text-purple-300 transition-colors"
                  aria-label="Copy URL"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            )}
          </div>

          {info?.mcpAuthToken && (
            <div className="mt-2">
              <div className="text-[11px] text-slate-500 mb-1">
                Profile-management token — required. Send as{" "}
                <span className="mono text-slate-400">Authorization: Bearer &lt;token&gt;</span>.
                Keep it secret; it can manage local profiles but cannot inspect or drive pages.
              </div>
              <div
                className="flex items-center gap-2"
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.03)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
                }}
              >
                <span className="flex-1 mono text-[12px] text-slate-300 truncate">
                  {tokenShown ? info.mcpAuthToken : "•".repeat(24)}
                </span>
                <button
                  type="button"
                  onClick={() => setTokenShown((v) => !v)}
                  className="text-slate-400 hover:text-slate-200 transition-colors"
                  aria-label={tokenShown ? "Hide token" : "Reveal token"}
                >
                  {tokenShown ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  onClick={copyMcpToken}
                  className="text-purple-400 hover:text-purple-300 transition-colors"
                  aria-label="Copy token"
                >
                  {tokenCopied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            </div>
          )}

          <label className="flex items-center gap-2.5 mt-3 text-[12px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.mcpHttpEnabled}
              onChange={(e) => void patch({ mcpHttpEnabled: e.target.checked })}
              className="w-3.5 h-3.5 rounded accent-purple-500"
            />
            Auto-start MCP HTTP transport on app launch
          </label>
        </Row>

        <Row
          icon={<Chrome size={16} strokeWidth={1.5} />}
          title="Browser engine"
          desc={
            info?.compatibilityEnginePin
              ? `Locked by compatibility set ${info.compatibilityEnginePin.sequence} at runtime ${info.compatibilityEnginePin.version}.`
              : "Applied on next app launch."
          }
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {engineOptions.map((option) => {
              const selected = settings.browserEngine === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={Boolean(info?.compatibilityEnginePin)}
                  onClick={() => void patch({ browserEngine: option.value })}
                  className="text-left p-3 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    boxShadow: selected
                      ? "inset 0 0 0 1px rgba(168,85,247,0.45)"
                      : "inset 0 0 0 1px rgba(255,255,255,0.07)",
                    background: selected ? "rgba(168,85,247,0.08)" : "rgba(255,255,255,0.025)",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-slate-100">{option.label}</span>
                    {selected && <Pill kind="running">active</Pill>}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </Row>

        <Row
          icon={<KeyRound size={16} strokeWidth={1.5} />}
          title="CloakBrowser licence"
          desc={
            <>
              Without a key, CloakBrowser stays on the last openly published build (146, May 2026).
              A browser that lags several Chrome majors behind stable is itself unusual enough to
              stand out. A free key is one browser at a time and needs no card — sign in at{" "}
              <span className="mono text-slate-400">cloakbrowser.dev/free</span>. Applied on next
              app launch.
            </>
          }
        >
          <div
            className="flex items-center gap-2"
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              background: "rgba(255,255,255,0.03)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
            }}
          >
            <input
              type={licenceShown ? "text" : "password"}
              value={licenceDraft}
              onChange={(e) => setLicenceDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveLicence();
              }}
              placeholder="Paste your CloakBrowser key"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 bg-transparent outline-none mono text-[12px] text-slate-300 placeholder:text-slate-600"
            />
            <button
              type="button"
              onClick={() => setLicenceShown((v) => !v)}
              className="text-slate-400 hover:text-slate-200 transition-colors"
              aria-label={licenceShown ? "Hide licence key" : "Reveal licence key"}
            >
              {licenceShown ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button
              type="button"
              onClick={() => void saveLicence()}
              disabled={licenceDraft.trim() === settings.cloakBrowserLicenseKey}
              className="text-[11px] px-2 py-1 rounded-md text-purple-300 hover:text-purple-200 disabled:text-slate-600 disabled:cursor-not-allowed transition-colors"
              style={{ boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.25)" }}
            >
              {licenceSaved ? "Saved" : "Save"}
            </button>
          </div>
          <div className="text-[11px] mt-2 flex items-center gap-2">
            {settings.cloakBrowserLicenseKey ? (
              <>
                <Pill kind="running">key set</Pill>
                <span className="text-slate-500">
                  Engine{" "}
                  <span className="mono text-slate-400">
                    {engineStatus?.kind === "ready" ? engineStatus.version : "—"}
                  </span>
                  . If a profile refuses to open, the reason is reported on launch — an invalid key,
                  or the free plan&apos;s one-browser-at-a-time limit.
                </span>
              </>
            ) : (
              <>
                <Pill kind="idle">no key</Pill>
                <span className="text-slate-500">Running the older keyless build.</span>
              </>
            )}
          </div>
          {settings.cloakBrowserLicenseKey && (
            <AdditionalLicenceKeys
              keys={settings.cloakBrowserLicenseKeys}
              primaryKey={settings.cloakBrowserLicenseKey}
              onChange={(next) => patch({ cloakBrowserLicenseKeys: next })}
            />
          )}
          {settings.cloakBrowserLicenseKey ? (
            <div className="text-[11px] mt-2">
              <button
                type="button"
                disabled={upgrading}
                onClick={() => {
                  if (confirmUpgrade) void activateLatestEngine();
                  else setConfirmUpgrade(true);
                }}
                className="px-2 py-1 rounded-md text-purple-300 hover:text-purple-200 disabled:text-slate-600 disabled:cursor-not-allowed transition-colors"
                style={{ boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.25)" }}
              >
                {upgrading
                  ? "Downloading…"
                  : confirmUpgrade
                    ? "Confirm — rotate every profile"
                    : "Update engine"}
              </button>
              <span className="text-slate-500 ml-2">
                {confirmUpgrade
                  ? "Every profile reports different hardware afterwards. Do this before accounts exist, or during a planned migration — never underneath a running one."
                  : "Pins the newest licensed build and downloads it. The current engine is removed first."}
              </span>
              {upgradeError ? (
                <div className="text-rose-300 mt-1">{upgradeError}</div>
              ) : null}
            </div>
          ) : null}
        </Row>

        <Row
          icon={<Boxes size={16} strokeWidth={1.5} />}
          title="Archives"
          desc=".mzar files are encrypted bundles of profiles — cookies, login state, fingerprints, notes — protected with a passphrase you set at export time."
        >
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary px-3 py-[7px] text-[12px] rounded-[9px]"
              onClick={onImport}
            >
              Import .mzar archive
            </button>
            <span className="text-[11px] text-slate-500 self-center">
              Existing encrypted .mzar archives remain format-compatible.
            </span>
          </div>
        </Row>

        <Row
          icon={<DownloadCloud size={16} strokeWidth={1.5} />}
          title="Application updates"
          desc="Automatic checks and installs are disabled. Install only an approved MKT Browser build supplied through the internal release process."
        >
          <Pill kind="idle">disabled</Pill>
        </Row>

        <Row icon={<Sparkles size={16} strokeWidth={1.5} />} title="About" desc="">
          <div className="mono text-[12px] text-slate-400 leading-relaxed">
            MKT Browser v{info?.appVersion ?? "0.0.0"} · {info?.platform ?? "—"} · Electron{" "}
            {electronVersion()}
          </div>
        </Row>
      </div>
    </div>
  );
}

const engineOptions: Array<{
  value: AppSettings["browserEngine"];
  label: string;
  description: string;
}> = [
  {
    value: "cloakbrowser",
    label: "CloakBrowser",
    description: "Source-patched Chromium from CloakHQ releases. Primary runtime.",
  },
  {
    value: "cft",
    label: "Chrome for Testing",
    description: "Compatibility fallback using Google's official automation build.",
  },
];

function electronVersion(): string {
  // Vite injects nothing useful here; just use a stable string for now.
  return "33";
}

function Row({
  icon,
  title,
  desc,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="flex items-start gap-3.5"
      style={{
        padding: "16px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <div
        className="flex items-center justify-center flex-shrink-0"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: "rgba(168,85,247,0.10)",
          boxShadow: "inset 0 0 0 1px rgba(168,85,247,0.18)",
          color: "#c084fc",
        }}
      >
        {icon}
      </div>
      <div className="flex-1">
        <div className="text-[13px] font-semibold text-slate-100">{title}</div>
        {desc && (
          <div className="text-[12px] text-slate-500 mt-1 leading-relaxed max-w-[480px]">
            {desc}
          </div>
        )}
        {children && <div className="mt-2.5">{children}</div>}
      </div>
    </div>
  );
}
