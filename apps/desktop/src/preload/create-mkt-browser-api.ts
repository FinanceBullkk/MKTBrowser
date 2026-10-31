import type { ActivityEvent } from "@mktbrowser/mcp-server";
import type { AppSettings } from "@mktbrowser/settings-store";
import type {
  ChromiumStatus,
  CreateProfileInput,
  DeviceFamily,
  ExtensionConfig,
  FingerprintConfig,
  LaunchedProfile,
  Profile,
  ProfileId,
  ProfileSummary,
  ProxyConfig,
  UpdateProfileInput,
} from "@mktbrowser/types";
import {
  IPC,
  IPC_EVENTS,
  type IpcEventChannel,
  type IpcInvokeChannel,
} from "../shared/ipc-exposure-policy.ts";

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

export interface SystemInfo {
  mcpHttpUrl: string | null;
  mcpAuthToken: string | null;
  appVersion: string;
  platform: NodeJS.Platform;
  compatibilityEnginePin: {
    sequence: number;
    engineKind: "cloakbrowser";
    version: string;
  } | null;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  | { kind: "closing"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

export interface MktBrowserIpcBridge {
  invoke<T>(channel: IpcInvokeChannel, ...args: unknown[]): Promise<T>;
  subscribe<T>(channel: IpcEventChannel, cb: (payload: T) => void): () => void;
}

/** Build the exact API exposed by preload; dependency injection keeps the channel mapping testable. */
export function createMktBrowserApi(bridge: MktBrowserIpcBridge) {
  return {
    profiles: {
      list: (): Promise<ProfileSummary[]> => bridge.invoke(IPC.PROFILES_LIST),
      get: (id: ProfileId): Promise<Profile | null> => bridge.invoke(IPC.PROFILES_GET, id),
      create: (input: CreateProfileInput): Promise<Profile> =>
        bridge.invoke(IPC.PROFILES_CREATE, input),
      update: (id: ProfileId, patch: UpdateProfileInput): Promise<Profile> =>
        bridge.invoke(IPC.PROFILES_UPDATE, id, patch),
      deletePermanently: (input: { profileId: ProfileId; confirmation: string }): Promise<void> =>
        bridge.invoke(IPC.PROFILES_DELETE_PERMANENTLY, input),
      launch: (id: ProfileId): Promise<LaunchedProfile> => bridge.invoke(IPC.PROFILES_LAUNCH, id),
      close: (id: ProfileId): Promise<void> => bridge.invoke(IPC.PROFILES_CLOSE, id),
      exportArchive: (
        id: ProfileId,
        passphrase: string,
      ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> =>
        bridge.invoke(IPC.PROFILES_EXPORT, id, passphrase),
      importArchive: (
        passphrase: string,
      ): Promise<
        { ok: true; id: ProfileId; disabledExtensions: number } | { ok: false; reason: string }
      > =>
        bridge.invoke(IPC.PROFILES_IMPORT, passphrase),
      onRunningChanged: (cb: (change: RunningStateChange) => void): (() => void) =>
        bridge.subscribe(IPC_EVENTS.PROFILES_RUNNING_CHANGED, cb),
      onProxyCountryUpdated: (
        cb: (update: { id: string; country: string }) => void,
      ): (() => void) => bridge.subscribe(IPC_EVENTS.PROFILES_PROXY_COUNTRY_UPDATED, cb),
    },
    settings: {
      get: (): Promise<AppSettings> => bridge.invoke(IPC.SETTINGS_GET),
      update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
        bridge.invoke(IPC.SETTINGS_UPDATE, patch),
    },
    activity: {
      recent: (): Promise<ActivityEvent[]> => bridge.invoke(IPC.ACTIVITY_RECENT),
      onEvent: (cb: (event: ActivityEvent) => void): (() => void) =>
        bridge.subscribe(IPC_EVENTS.ACTIVITY_EVENT, cb),
    },
    system: {
      info: (): Promise<SystemInfo> => bridge.invoke(IPC.SYSTEM_INFO),
      /** Opens the vendor's free-key registration page. Takes no URL: the
       *  destination is a constant in the main process, not the renderer's
       *  choice. Each operator registers their own key. */
      openLicenceSignup: (): Promise<void> => bridge.invoke(IPC.SYSTEM_OPEN_LICENCE_SIGNUP),
    },
    chromium: {
      status: (): Promise<ChromiumStatus> => bridge.invoke(IPC.CHROMIUM_STATUS),
      retry: (): Promise<ChromiumStatus> => bridge.invoke(IPC.CHROMIUM_RETRY),
      /** Pins the newest licensed build and converges on it. Rotates every
       *  profile's hardware identity — see the Settings copy. */
      activateLatest: (): Promise<ChromiumStatus> => bridge.invoke(IPC.CHROMIUM_ACTIVATE_LATEST),
      onStatus: (cb: (status: ChromiumStatus) => void): (() => void) =>
        bridge.subscribe(IPC_EVENTS.CHROMIUM_STATUS, cb),
    },
    extensions: {
      list: (profileId: string): Promise<ExtensionConfig[]> =>
        bridge.invoke(IPC.EXTENSIONS_LIST, profileId),
      addFromFile: (profileId: string): Promise<ExtensionConfig[]> =>
        bridge.invoke(IPC.EXTENSIONS_ADD_FROM_FILE, profileId),
      addFromFolder: (profileId: string): Promise<ExtensionConfig[]> =>
        bridge.invoke(IPC.EXTENSIONS_ADD_FROM_FOLDER, profileId),
      addFromWebStore: (profileId: string, urlOrId: string): Promise<ExtensionConfig[]> =>
        bridge.invoke(IPC.EXTENSIONS_ADD_FROM_WEB_STORE, profileId, urlOrId),
      remove: (profileId: string, extId: string): Promise<ExtensionConfig[]> =>
        bridge.invoke(IPC.EXTENSIONS_REMOVE, profileId, extId),
      toggle: (profileId: string, extId: string, enabled: boolean): Promise<ExtensionConfig[]> =>
        bridge.invoke(IPC.EXTENSIONS_TOGGLE, profileId, extId, enabled),
      storeEntries: (): Promise<ExtensionConfig[]> => bridge.invoke(IPC.EXTENSIONS_STORE_ENTRIES),
      prepareFromWebStore: (urlOrId: string): Promise<ExtensionConfig> =>
        bridge.invoke(IPC.EXTENSIONS_PREPARE_FROM_WEB_STORE, urlOrId),
      prepareFromFile: (): Promise<ExtensionConfig | null> =>
        bridge.invoke(IPC.EXTENSIONS_PREPARE_FROM_FILE),
      prepareFromFolder: (): Promise<ExtensionConfig | null> =>
        bridge.invoke(IPC.EXTENSIONS_PREPARE_FROM_FOLDER),
      icon: (ext: ExtensionConfig, profileId: string | null): Promise<string | null> =>
        bridge.invoke(IPC.EXTENSIONS_ICON, ext, profileId),
      onInstalled: (cb: (event: ExtensionInstalledEvent) => void): (() => void) =>
        bridge.subscribe(IPC_EVENTS.EXTENSIONS_INSTALLED, cb),
    },
    fingerprint: {
      generate: (): Promise<FingerprintConfig> => bridge.invoke(IPC.FINGERPRINT_GENERATE),
      devices: (): Promise<ReadonlyArray<DeviceCatalogEntry>> =>
        bridge.invoke(IPC.FINGERPRINT_DEVICES),
      locales: (): Promise<ReadonlyArray<LocaleCatalogEntry>> =>
        bridge.invoke(IPC.FINGERPRINT_LOCALES),
      reconcile: (
        current: FingerprintConfig,
        patch: FingerprintReconcilePatch,
      ): Promise<FingerprintConfig> => bridge.invoke(IPC.FINGERPRINT_RECONCILE, current, patch),
      localeForCountry: (country: string): Promise<string | null> =>
        bridge.invoke(IPC.FINGERPRINT_LOCALE_FOR_COUNTRY, country),
    },
    proxy: {
      detectGeo: (
        proxy: ProxyConfig,
        profileId?: string,
      ): Promise<{ ok: true; geo: ProxyGeoResult } | { ok: false; error: string }> =>
        bridge.invoke(IPC.PROXY_DETECT_GEO, proxy, profileId),
    },
  };
}

export type MktBrowserApi = ReturnType<typeof createMktBrowserApi>;
