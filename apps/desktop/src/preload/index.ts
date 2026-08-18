import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  createMktBrowserApi,
  type MktBrowserApi,
  type MktBrowserIpcBridge,
} from "./create-mkt-browser-api.ts";

const bridge: MktBrowserIpcBridge = {
  invoke: <T>(channel: Parameters<MktBrowserIpcBridge["invoke"]>[0], ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>,
  subscribe: <T>(
    channel: Parameters<MktBrowserIpcBridge["subscribe"]>[0],
    cb: (payload: T) => void,
  ): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
};

const api = createMktBrowserApi(bridge);
contextBridge.exposeInMainWorld("mktBrowser", api);

export type { MktBrowserApi };
