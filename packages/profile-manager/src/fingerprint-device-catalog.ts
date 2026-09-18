/**
 * The device catalogue: real models with the specs a real one reports.
 *
 * Split out of `fingerprint.ts` on 18 September 2026 without changing a value. It is data, and it
 * was four hundred and fifty lines of data sitting in the middle of the logic that reads it - the
 * generator, the coherence rules and the override handling all had to be scrolled past it.
 *
 * Adding a device here is a data change. Keep every field plausible for the model named: the point
 * of the catalogue is that the surfaces agree with each other, not that they are unusual.
 */
import type { DeviceFamily } from "@mktbrowser/types";

// ─────────────────────────────────────────────────────────────────────────
// Device profiles — real models, real specs.
// ─────────────────────────────────────────────────────────────────────────

export interface WebGlPair {
  vendor: string;
  renderer: string;
}

export interface DeviceSpec {
  family: DeviceFamily;
  /** Human-readable label for UI dropdowns */
  label: string;

  /** UA platform token (legacy User-Agent) */
  uaPlatformToken: string;
  /** navigator.platform value */
  navigatorPlatform: "MacIntel" | "Win32" | "Linux x86_64";
  /** Sec-CH-UA-Platform value */
  secChUaPlatform: string;
  /** Sec-CH-UA-Platform-Version value (current OS major) */
  secChUaPlatformVersion: string;
  secChUaArch: "arm" | "x86";
  secChUaBitness: "64" | "32";

  /** Real screen sizes for this device (logical = CSS pixels, not retina) */
  screens: ReadonlyArray<{ width: number; height: number; label: string }>;
  /** Device pixel ratio — 2 for Mac Retina, 1 for most Win/Linux */
  dpr: number;

  /** WebGL UNMASKED_* pairs typical of this device family (one picked per generate) */
  webgl: ReadonlyArray<WebGlPair>;

  /** Plausible CPU core counts for this family */
  hardwareConcurrency: ReadonlyArray<number>;
  /** Plausible device memory in GB */
  deviceMemory: ReadonlyArray<number>;
}

/** Common desktop logical sizes callers pass (doc §3.2) — attached to Win/Linux devices. */
export const COMMON_DESKTOP_SCREENS: ReadonlyArray<{ width: number; height: number; label: string }> = [
  { width: 1920, height: 1080, label: "1920 × 1080 (FHD)" },
  { width: 1536, height: 864, label: "1536 × 864" },
  { width: 1366, height: 768, label: "1366 × 768 (HD)" },
  { width: 1440, height: 900, label: "1440 × 900" },
  { width: 1600, height: 900, label: "1600 × 900" },
  { width: 1280, height: 720, label: "1280 × 720 (HD)" },
  { width: 2560, height: 1440, label: "2560 × 1440 (QHD)" },
  { width: 1680, height: 1050, label: "1680 × 1050" },
];

export const WIN_DESKTOP_SCREENS: ReadonlyArray<{ width: number; height: number; label: string }> = [
  ...COMMON_DESKTOP_SCREENS,
  { width: 3840, height: 2160, label: "3840 × 2160 (4K)" },
];

export const ALLOWED_HWC_BASE = new Set([4, 6, 8, 12, 16]);
export const ALLOWED_MEM_BASE = new Set([4, 8, 16]);

export const DEVICES: ReadonlyArray<DeviceSpec> = [
  {
    family: "macbook-pro-14-m3",
    label: "MacBook Pro 14″ (M3)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1512, height: 982, label: "1512 × 982 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3" },
      { vendor: "Apple Inc.", renderer: "Apple M3 (8-core GPU)" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "macbook-pro-14-m3-pro",
    label: "MacBook Pro 14″ (M3 Pro)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1512, height: 982, label: "1512 × 982 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3 Pro" },
      { vendor: "Apple Inc.", renderer: "Apple M3 Pro (14-core GPU)" },
    ],
    hardwareConcurrency: [11, 12],
    deviceMemory: [18, 36],
  },
  {
    family: "macbook-pro-16-m3-pro",
    label: "MacBook Pro 16″ (M3 Pro)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1728, height: 1117, label: "1728 × 1117 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3 Pro" },
      { vendor: "Apple Inc.", renderer: "Apple M3 Max" },
    ],
    hardwareConcurrency: [11, 12, 16],
    deviceMemory: [18, 36],
  },
  {
    family: "macbook-air-13-m3",
    label: "MacBook Air 13″ (M3)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1440, height: 900, label: "1440 × 900 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3" },
      { vendor: "Apple Inc.", renderer: "Apple M2" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "macbook-air-15-m3",
    label: "MacBook Air 15″ (M3)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1680, height: 1050, label: "1680 × 1050 (default)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (external)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (external)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3" },
      { vendor: "Apple Inc.", renderer: "Apple M3 (10-core GPU)" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "imac-24-m3",
    label: "iMac 24″ (M3)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 2240, height: 1260, label: "2240 × 1260 (4.5K)" },
      { width: 1920, height: 1080, label: "1920 × 1080 (scaled)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M3" },
      { vendor: "Apple Inc.", renderer: "Apple M3 (10-core GPU)" },
    ],
    hardwareConcurrency: [8],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "mac-mini-m2",
    label: "Mac mini (M2)",
    uaPlatformToken: "Macintosh; Intel Mac OS X 10_15_7",
    navigatorPlatform: "MacIntel",
    secChUaPlatform: "macOS",
    secChUaPlatformVersion: "14.6.0",
    secChUaArch: "arm",
    secChUaBitness: "64",
    screens: [
      { width: 1920, height: 1080, label: "1920 × 1080 (FHD)" },
      { width: 2560, height: 1440, label: "2560 × 1440 (QHD)" },
      { width: 3840, height: 2160, label: "3840 × 2160 (4K)" },
    ],
    dpr: 2,
    webgl: [
      { vendor: "Apple Inc.", renderer: "Apple M2" },
      { vendor: "Apple Inc.", renderer: "Apple M2 Pro" },
    ],
    hardwareConcurrency: [8, 12],
    deviceMemory: [8, 16, 24],
  },
  {
    family: "windows-laptop-intel",
    label: "Windows laptop (Intel Iris Xe)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (Intel)",
        renderer:
          "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [4, 8, 12],
    deviceMemory: [8, 16],
  },
  {
    family: "windows-laptop-intel-uhd",
    label: "Windows laptop (Intel UHD)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [4, 6, 8],
    deviceMemory: [4, 8, 16],
  },
  {
    family: "windows-laptop-amd",
    label: "Windows laptop (AMD Radeon)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (AMD)",
        renderer: "ANGLE (AMD, AMD Radeon RX 7600M XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (AMD)",
        renderer: "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [6, 8, 12],
    deviceMemory: [8, 16],
  },
  {
    family: "windows-laptop-nvidia",
    label: "Windows laptop (NVIDIA RTX 4060)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [8, 12, 16],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "windows-laptop-nvidia-4050",
    label: "Windows laptop (NVIDIA RTX 4050)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028E1) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU (0x000025A2) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [6, 8, 12],
    deviceMemory: [8, 16],
  },
  {
    family: "windows-desktop-nvidia",
    label: "Windows desktop (NVIDIA RTX 4070)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: WIN_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [8, 12, 16, 24, 32],
    deviceMemory: [16, 32, 64],
  },
  {
    family: "windows-desktop-nvidia-4080",
    label: "Windows desktop (NVIDIA RTX 4080)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: WIN_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti (0x00002782) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [12, 16, 24, 32],
    deviceMemory: [32, 64],
  },
  {
    family: "windows-desktop-amd",
    label: "Windows desktop (AMD Radeon)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: WIN_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (AMD)",
        renderer: "ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (AMD)",
        renderer: "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [8, 12, 16],
    deviceMemory: [16, 32],
  },
  {
    family: "windows-desktop-intel",
    label: "Windows desktop (Intel UHD/Arc)",
    uaPlatformToken: "Windows NT 10.0; Win64; x64",
    navigatorPlatform: "Win32",
    secChUaPlatform: "Windows",
    secChUaPlatformVersion: "15.0.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: WIN_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    ],
    hardwareConcurrency: [6, 8, 12, 16],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "linux-desktop-intel",
    label: "Linux desktop (Intel UHD)",
    uaPlatformToken: "X11; Linux x86_64",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: "Linux",
    secChUaPlatformVersion: "6.6.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      { vendor: "Mesa", renderer: "Mesa Intel(R) UHD Graphics 770 (RPL-S)" },
      { vendor: "Mesa", renderer: "Mesa Intel(R) Graphics (ADL GT2)" },
    ],
    hardwareConcurrency: [4, 8, 16],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "linux-desktop-amd",
    label: "Linux desktop (AMD Radeon)",
    uaPlatformToken: "X11; Linux x86_64",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: "Linux",
    secChUaPlatformVersion: "6.6.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      {
        vendor: "Mesa",
        renderer: "AMD Radeon RX 7800 XT (radeonsi, navi32, LLVM 17.0.6, DRM 3.57, 6.6.0)",
      },
      {
        vendor: "Mesa",
        renderer: "AMD Radeon Graphics (radeonsi, renoir, LLVM 17.0.6, DRM 3.57, 6.6.0)",
      },
    ],
    hardwareConcurrency: [6, 8, 12, 16],
    deviceMemory: [8, 16, 32],
  },
  {
    family: "linux-desktop-nvidia",
    label: "Linux desktop (NVIDIA)",
    uaPlatformToken: "X11; Linux x86_64",
    navigatorPlatform: "Linux x86_64",
    secChUaPlatform: "Linux",
    secChUaPlatformVersion: "6.6.0",
    secChUaArch: "x86",
    secChUaBitness: "64",
    screens: COMMON_DESKTOP_SCREENS,
    dpr: 1,
    webgl: [
      { vendor: "Mesa", renderer: "NVIDIA GeForce RTX 4070/PCIe/SSE2" },
      { vendor: "Mesa", renderer: "NV137" },
    ],
    hardwareConcurrency: [8, 12, 16, 24],
    deviceMemory: [16, 32, 64],
  },
];
