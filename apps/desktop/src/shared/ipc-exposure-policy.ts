export const IPC_INVOKE_EXPOSURE = {
  "profiles:list": "profile-read",
  "profiles:get": "profile-read",
  "profiles:create": "profile-write",
  "profiles:update": "profile-write",
  "profiles:delete-permanently": "profile-destructive",
  "profiles:launch": "profile-lifecycle",
  "profiles:close": "profile-lifecycle",
  "profiles:export": "profile-archive",
  "profiles:import": "profile-archive",
  "settings:get": "settings-read",
  "settings:update": "settings-write",
  "activity:recent": "activity-read",
  "chromium:status": "engine-read",
  "chromium:retry": "engine-write",
  "chromium:switch-to-cft": "engine-write",
  "chromium:activate-latest": "engine-write",
  "extensions:list": "extension-read",
  "extensions:addFromFile": "extension-write",
  "extensions:addFromFolder": "extension-write",
  "extensions:addFromWebStore": "extension-write",
  "extensions:remove": "extension-write",
  "extensions:toggle": "extension-write",
  "extensions:storeEntries": "extension-read",
  "extensions:icon": "extension-read",
  "extensions:prepareFromWebStore": "extension-write",
  "extensions:prepareFromFile": "extension-write",
  "extensions:prepareFromFolder": "extension-write",
  "fingerprint:generate": "fingerprint-write",
  "fingerprint:devices": "fingerprint-read",
  "fingerprint:locales": "fingerprint-read",
  "fingerprint:localeForCountry": "fingerprint-read",
  "fingerprint:reconcile": "fingerprint-write",
  "proxy:detectGeo": "network-probe",
  "system:info": "system-read",
  // Opens one compile-time constant URL in the operating system's browser and takes no
  // argument, so the renderer cannot choose a destination. See cloakbrowser-signup-url.ts.
  "system:open-licence-signup": "external-link-fixed",
} as const;

export const IPC_EVENT_EXPOSURE = {
  "profiles:running-changed": "profile-read",
  "profiles:proxy-country-updated": "profile-read",
  "activity:event": "activity-read",
  "chromium:status": "engine-read",
  "extensions:installed": "extension-read",
} as const;

export type IpcInvokeChannel = keyof typeof IPC_INVOKE_EXPOSURE;
export type IpcEventChannel = keyof typeof IPC_EVENT_EXPOSURE;

export const IPC = {
  PROFILES_LIST: "profiles:list",
  PROFILES_GET: "profiles:get",
  PROFILES_CREATE: "profiles:create",
  PROFILES_UPDATE: "profiles:update",
  PROFILES_DELETE_PERMANENTLY: "profiles:delete-permanently",
  PROFILES_LAUNCH: "profiles:launch",
  PROFILES_CLOSE: "profiles:close",
  PROFILES_EXPORT: "profiles:export",
  PROFILES_IMPORT: "profiles:import",
  SETTINGS_GET: "settings:get",
  SETTINGS_UPDATE: "settings:update",
  ACTIVITY_RECENT: "activity:recent",
  CHROMIUM_STATUS: "chromium:status",
  CHROMIUM_RETRY: "chromium:retry",
  CHROMIUM_SWITCH_TO_CFT: "chromium:switch-to-cft",
  CHROMIUM_ACTIVATE_LATEST: "chromium:activate-latest",
  EXTENSIONS_LIST: "extensions:list",
  EXTENSIONS_ADD_FROM_FILE: "extensions:addFromFile",
  EXTENSIONS_ADD_FROM_FOLDER: "extensions:addFromFolder",
  EXTENSIONS_ADD_FROM_WEB_STORE: "extensions:addFromWebStore",
  EXTENSIONS_REMOVE: "extensions:remove",
  EXTENSIONS_TOGGLE: "extensions:toggle",
  EXTENSIONS_STORE_ENTRIES: "extensions:storeEntries",
  EXTENSIONS_ICON: "extensions:icon",
  EXTENSIONS_PREPARE_FROM_WEB_STORE: "extensions:prepareFromWebStore",
  EXTENSIONS_PREPARE_FROM_FILE: "extensions:prepareFromFile",
  EXTENSIONS_PREPARE_FROM_FOLDER: "extensions:prepareFromFolder",
  FINGERPRINT_GENERATE: "fingerprint:generate",
  FINGERPRINT_DEVICES: "fingerprint:devices",
  FINGERPRINT_LOCALES: "fingerprint:locales",
  FINGERPRINT_LOCALE_FOR_COUNTRY: "fingerprint:localeForCountry",
  FINGERPRINT_RECONCILE: "fingerprint:reconcile",
  PROXY_DETECT_GEO: "proxy:detectGeo",
  SYSTEM_INFO: "system:info",
  SYSTEM_OPEN_LICENCE_SIGNUP: "system:open-licence-signup",
} as const satisfies Record<string, IpcInvokeChannel>;

export const IPC_EVENTS = {
  PROFILES_RUNNING_CHANGED: "profiles:running-changed",
  PROFILES_PROXY_COUNTRY_UPDATED: "profiles:proxy-country-updated",
  ACTIVITY_EVENT: "activity:event",
  CHROMIUM_STATUS: "chromium:status",
  EXTENSIONS_INSTALLED: "extensions:installed",
} as const satisfies Record<string, IpcEventChannel>;

export function isIpcInvokeChannel(channel: string): channel is IpcInvokeChannel {
  return Object.hasOwn(IPC_INVOKE_EXPOSURE, channel);
}

export function isIpcEventChannel(channel: string): channel is IpcEventChannel {
  return Object.hasOwn(IPC_EVENT_EXPOSURE, channel);
}
