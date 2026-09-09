import type { BrowserWindow, Menu, MenuItemConstructorOptions, Tray } from "electron";
import { win32 } from "node:path";

interface BackgroundOptions {
  createTray: () => Tray;
  buildMenu: (items: MenuItemConstructorOptions[]) => Menu;
  getWindow: () => BrowserWindow | null;
  quit: () => void;
  endSession: () => void;
  retryRelay: () => void;
}

export function usesNormalWindowsSession(input: {
  platform: string;
  isPackaged: boolean;
  explicitUserData: boolean;
  compatibilitySmoke: boolean;
  userDataPath?: string;
  canonicalUserDataPath?: string;
}): boolean {
  const usesCanonicalRoot =
    Boolean(input.userDataPath && input.canonicalUserDataPath) &&
    win32.resolve(input.userDataPath!).toLowerCase() ===
      win32.resolve(input.canonicalUserDataPath!).toLowerCase();
  return (
    input.platform === "win32" &&
    input.isPackaged &&
    (!input.explicitUserData || usesCanonicalRoot) &&
    !input.compatibilitySmoke
  );
}

/** Hiding is permitted only while a usable tray gives the operator a way back. */
export class WindowsBackgroundLifecycle {
  private tray: Tray | null = null;
  private quitting = false;
  private notified = false;
  private relayStatus = "Checking Relay...";
  private readonly options: BackgroundOptions;

  constructor(options: BackgroundOptions) {
    this.options = options;
    try {
      this.tray = options.createTray();
      this.tray.setToolTip("MKT Browser - background profile manager");
      this.refreshMenu();
      this.tray.on("double-click", () => this.show());
    } catch {
      this.tray?.destroy();
      this.tray = null;
    }
  }

  get canHide(): boolean {
    return this.tray !== null && !this.quitting;
  }

  attachWindow(window: BrowserWindow): void {
    window.on("close", (event) => {
      if (!this.canHide) return;
      event.preventDefault();
      window.hide();
      if (!this.notified) {
        this.notified = true;
        this.notify(
          "MKT Browser is still running",
          "Browser profiles stay open. Use the tray icon to reopen MKT Browser or Quit to close profiles.",
        );
      }
    });
    // Start a real quit, not an irreversible hidden state if Windows logout is later cancelled.
    window.on("query-session-end", () => this.requestQuit());
    window.on("session-end", () => {
      this.beginQuit();
      this.options.endSession();
    });
  }

  show(): void {
    if (this.quitting) return;
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.options.retryRelay();
  }

  setRelayStatus(message: string): void {
    this.relayStatus = message;
    if (!this.quitting) this.refreshMenu();
  }

  notify(title: string, content: string): void {
    try {
      this.tray?.displayBalloon({ title, content, iconType: "info", respectQuietTime: true });
    } catch {
      // Notification availability is not the tray's availability; the menu still works.
    }
  }

  beginQuit(): void {
    this.quitting = true;
  }

  dispose(): void {
    this.beginQuit();
    this.tray?.destroy();
    this.tray = null;
  }

  private requestQuit(): void {
    if (this.quitting) return;
    this.beginQuit();
    this.options.quit();
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    this.tray.setContextMenu(
      this.options.buildMenu([
        { label: "Open MKT Browser", click: () => this.show() },
        { type: "separator" },
        { label: this.relayStatus, enabled: false },
        {
          label: "Check Relay",
          click: () => {
            if (!this.quitting) this.options.retryRelay();
          },
        },
        { type: "separator" },
        { label: "Quit closes browser profiles; Relay stays running.", enabled: false },
        { label: "Quit MKT Browser", click: () => this.requestQuit() },
      ]),
    );
  }
}
