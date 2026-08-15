import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateProfileInput,
  ProfileId,
  ProfileSummary,
  Profile,
  UpdateProfileInput,
  LaunchedProfile,
  FingerprintConfig,
} from "@mktbrowser/types";
import type { ActivityEvent } from "@mktbrowser/mcp-server";
import type { AppSettings } from "@mktbrowser/settings-store";
import type { ChromiumStatus, DeviceFamily, ExtensionConfig, ProxyConfig } from "@mktbrowser/types";
import {
  IPC,
  IPC_EVENTS,
  type IpcEventChannel,
  type IpcInvokeChannel,
} from "../shared/ipc-exposure-policy.ts";

/** Payload for the `extensions:installed` push (companion "Add to MKT Browser"). */
export type ExtensionInstalledEvent =
  | { ok: true; profileId: string; extension: ExtensionConfig }
  | { ok: false; profileId: string; error: string };

export interface ProxyGeoResult {
  country: string;
  countryName: string;
  timezone: string;
  city: string;
  ip: string;
}

/** Mirror of the catalog types from @mktbrowser/profile-manager. */
export interface DeviceCatalogEntry {
  family: DeviceFamily;
  label: string;
  screens: ReadonlyArray<{ width: number; height: number; label: string }>;
}
export interface LocaleCatalogEntry {
  id: string;
  label: string;
  locale: string;
  country: string;
  timezones: ReadonlyArray<string>;
}
export interface FingerprintReconcilePatch {
  device?: DeviceFamily;
  localeId?: string;
  screen?: { width: number; height: number };
  timezone?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

interface SystemInfo {
  mcpHttpUrl: string | null;
  appVersion: string;
  platform: NodeJS.Platform;
  compatibilityEnginePin: {
    sequence: number;
    engineKind: "cft" | "cloakbrowser";
    version: string;
  } | null;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

function invoke(channel: IpcInvokeChannel, ...args: unknown[]): Promise<any> {
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe<T>(channel: IpcEventChannel, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api = {
  profiles: {
    list: (): Promise<ProfileSummary[]> => invoke(IPC.PROFILES_LIST),
    get: (id: ProfileId): Promise<Profile | null> => invoke(IPC.PROFILES_GET, id),
    create: (input: CreateProfileInput): Promise<Profile> => invoke(IPC.PROFILES_CREATE, input),
    update: (id: ProfileId, patch: UpdateProfileInput): Promise<Profile> =>
      invoke(IPC.PROFILES_UPDATE, id, patch),
    deletePermanently: (input: { profileId: ProfileId; confirmation: string }): Promise<void> =>
      invoke(IPC.PROFILES_DELETE_PERMANENTLY, input),
    launch: (id: ProfileId): Promise<LaunchedProfile> => invoke(IPC.PROFILES_LAUNCH, id),
    close: (id: ProfileId): Promise<void> => invoke(IPC.PROFILES_CLOSE, id),
    exportArchive: (
      id: ProfileId,
      passphrase: string,
    ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> =>
      invoke(IPC.PROFILES_EXPORT, id, passphrase),
    importArchive: (
      passphrase: string,
    ): Promise<{ ok: true; id: ProfileId } | { ok: false; reason: string }> =>
      invoke(IPC.PROFILES_IMPORT, passphrase),
    onRunningChanged: (cb: (change: RunningStateChange) => void): (() => void) =>
      subscribe(IPC_EVENTS.PROFILES_RUNNING_CHANGED, cb),
    onProxyCountryUpdated: (cb: (update: { id: string; country: string }) => void): (() => void) =>
      subscribe(IPC_EVENTS.PROFILES_PROXY_COUNTRY_UPDATED, cb),
  },
  settings: {
    get: (): Promise<AppSettings> => invoke(IPC.SETTINGS_GET),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      invoke(IPC.SETTINGS_UPDATE, patch),
  },
  activity: {
    recent: (): Promise<ActivityEvent[]> => invoke(IPC.ACTIVITY_RECENT),
    onEvent: (cb: (e: ActivityEvent) => void): (() => void) =>
      subscribe(IPC_EVENTS.ACTIVITY_EVENT, cb),
  },
  system: {
    info: (): Promise<SystemInfo> => invoke(IPC.SYSTEM_INFO),
  },
  chromium: {
    status: (): Promise<ChromiumStatus> => invoke(IPC.CHROMIUM_STATUS),
    retry: (): Promise<ChromiumStatus> => invoke(IPC.CHROMIUM_RETRY),
    switchToCft: (): Promise<ChromiumStatus> => invoke(IPC.CHROMIUM_SWITCH_TO_CFT),
    onStatus: (cb: (status: ChromiumStatus) => void): (() => void) =>
      subscribe(IPC_EVENTS.CHROMIUM_STATUS, cb),
  },
  extensions: {
    list: (profileId: string): Promise<ExtensionConfig[]> => invoke(IPC.EXTENSIONS_LIST, profileId),
    addFromFile: (profileId: string): Promise<ExtensionConfig[]> =>
      invoke(IPC.EXTENSIONS_ADD_FROM_FILE, profileId),
    addFromFolder: (profileId: string): Promise<ExtensionConfig[]> =>
      invoke(IPC.EXTENSIONS_ADD_FROM_FOLDER, profileId),
    addFromWebStore: (profileId: string, urlOrId: string): Promise<ExtensionConfig[]> =>
      invoke(IPC.EXTENSIONS_ADD_FROM_WEB_STORE, profileId, urlOrId),
    remove: (profileId: string, extId: string): Promise<ExtensionConfig[]> =>
      invoke(IPC.EXTENSIONS_REMOVE, profileId, extId),
    toggle: (profileId: string, extId: string, enabled: boolean): Promise<ExtensionConfig[]> =>
      invoke(IPC.EXTENSIONS_TOGGLE, profileId, extId, enabled),
    // Staging (create sheet, no profile id yet).
    storeEntries: (): Promise<ExtensionConfig[]> => invoke(IPC.EXTENSIONS_STORE_ENTRIES),
    prepareFromWebStore: (urlOrId: string): Promise<ExtensionConfig> =>
      invoke(IPC.EXTENSIONS_PREPARE_FROM_WEB_STORE, urlOrId),
    prepareFromFile: (): Promise<ExtensionConfig | null> =>
      invoke(IPC.EXTENSIONS_PREPARE_FROM_FILE),
    prepareFromFolder: (): Promise<ExtensionConfig | null> =>
      invoke(IPC.EXTENSIONS_PREPARE_FROM_FOLDER),
    /** Real icon from the extension's manifest, as a data URI (or null). */
    icon: (ext: ExtensionConfig, profileId: string | null): Promise<string | null> =>
      invoke(IPC.EXTENSIONS_ICON, ext, profileId),
    onInstalled: (cb: (e: ExtensionInstalledEvent) => void): (() => void) =>
      subscribe(IPC_EVENTS.EXTENSIONS_INSTALLED, cb),
  },
  fingerprint: {
    generate: (): Promise<FingerprintConfig> => invoke(IPC.FINGERPRINT_GENERATE),
    devices: (): Promise<ReadonlyArray<DeviceCatalogEntry>> => invoke(IPC.FINGERPRINT_DEVICES),
    locales: (): Promise<ReadonlyArray<LocaleCatalogEntry>> => invoke(IPC.FINGERPRINT_LOCALES),
    reconcile: (
      current: FingerprintConfig,
      patch: FingerprintReconcilePatch,
    ): Promise<FingerprintConfig> => invoke(IPC.FINGERPRINT_RECONCILE, current, patch),
    localeForCountry: (cc: string): Promise<string | null> =>
      invoke(IPC.FINGERPRINT_LOCALE_FOR_COUNTRY, cc),
  },
  proxy: {
    detectGeo: (
      proxy: ProxyConfig,
      profileId?: string,
    ): Promise<{ ok: true; geo: ProxyGeoResult } | { ok: false; error: string }> =>
      invoke(IPC.PROXY_DETECT_GEO, proxy, profileId),
  },
};

contextBridge.exposeInMainWorld("mktBrowser", api);

export type MktBrowserApi = typeof api;
