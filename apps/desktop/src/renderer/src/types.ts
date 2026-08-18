import type { ActivityEvent } from "@mktbrowser/mcp-server";
import type { AppSettings } from "@mktbrowser/settings-store";
import type {
  ChromiumStatus,
  DeviceFamily,
  ExtensionConfig,
  FingerprintConfig,
  LaunchedProfile,
  Profile,
  ProfileSummary,
  ProxyConfig,
  UpdateProfileInput,
} from "@mktbrowser/types";
import type {
  DeviceCatalogEntry,
  ExtensionInstalledEvent,
  FingerprintReconcilePatch,
  LocaleCatalogEntry,
  MktBrowserApi,
  ProxyGeoResult,
  RunningStateChange,
  SystemInfo,
} from "../../preload/create-mkt-browser-api.ts";

declare global {
  interface Window {
    mktBrowser: MktBrowserApi;
  }
}

export type {
  ActivityEvent,
  AppSettings,
  ChromiumStatus,
  DeviceCatalogEntry,
  DeviceFamily,
  ExtensionConfig,
  ExtensionInstalledEvent,
  FingerprintConfig,
  FingerprintReconcilePatch,
  LaunchedProfile,
  LocaleCatalogEntry,
  MktBrowserApi,
  Profile,
  ProfileSummary,
  ProxyConfig,
  ProxyGeoResult,
  RunningStateChange,
  SystemInfo,
  UpdateProfileInput,
};
