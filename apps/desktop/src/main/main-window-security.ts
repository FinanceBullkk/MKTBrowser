/**
 * The renderer's security surface, extracted so it can be asserted on directly.
 *
 * These settings used to live inline in `createWindow()` and were "tested" by regex-matching
 * `index.ts` for `/contextIsolation:\s*true/`. That check passes if the option sits in dead code,
 * if something overrides it later, or if a second window is constructed without it — it proves a
 * string exists in a file, not that the renderer is sandboxed. Pulling the options out into a
 * function lets the contract test call it and inspect the object Electron actually receives.
 *
 * Deliberately free of any runtime `electron` import: the types are erased at compile time, so the
 * contract test can import this module in a plain Node process with no Electron runtime.
 */
import { join } from "node:path";
import type { BrowserWindowConstructorOptions, WebContents } from "electron";

export interface MainWindowOptionsInput {
  /** Directory of the built main-process bundle. The preload path is resolved relative to it. */
  mainDir: string;
  /** Resolved application icon, or `null` when none was found for this platform. */
  iconPath: string | null;
  /** Set only after a usable tray exists, so a background start cannot strand the window. */
  initiallyHidden?: boolean;
}

/**
 * Construction options for the one and only application window.
 *
 * The four `webPreferences` flags are the renderer isolation contract: a sandboxed, context
 * isolated renderer with no Node integration and no relaxed web security. Everything the renderer
 * is allowed to do goes through the preload bridge instead.
 */
export function mainWindowOptions(input: MainWindowOptionsInput): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0b0f",
    icon: input.iconPath ?? undefined,
    show: !input.initiallyHidden,
    webPreferences: {
      preload: join(input.mainDir, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };
}

/**
 * Refuse both ways a renderer can be navigated somewhere it should not go: opening a new window,
 * and navigating the existing one. The app only ever renders its own bundled HTML, so there is no
 * legitimate navigation to allow through.
 */
export function applyNavigationHardening(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
}
