import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Native modules and Electron itself cannot be bundled — they must be
 * marked external. Pure-JS workspace deps (@mktbrowser/*) get bundled so
 * we can ship .ts source files without a separate build step in dev.
 */
const NATIVE_EXTERNALS = [
  "electron",
  /^node:/,
  "better-sqlite3",
  "chrome-remote-interface",
  "ws",
  "https-proxy-agent",
  "socks-proxy-agent",
  "proxy-chain",
  "extract-zip",
  "@modelcontextprotocol/sdk",
  "uuid",
  "zod",
];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: [
          "@mktbrowser/cdp-driver",
          "@mktbrowser/mcp-server",
          "@mktbrowser/profile-manager",
          "@mktbrowser/settings-store",
          "@mktbrowser/types",
        ],
      },
      rollupOptions: {
        external: NATIVE_EXTERNALS,
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: ["electron"],
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    // file:// URLs in packaged Electron need relative asset paths.
    // Default base "/" resolves /logo.png to filesystem root and 404s
    // the bundled image. Switching to "./" produces ./logo.png which
    // Vite + Electron resolve correctly in both dev and production.
    base: "./",
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
      },
    },
  },
});
