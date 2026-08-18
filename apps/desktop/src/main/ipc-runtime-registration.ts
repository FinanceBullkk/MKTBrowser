import { IPC, isIpcInvokeChannel, type IpcInvokeChannel } from "../shared/ipc-exposure-policy.ts";

// Concrete main handlers need typed positional arguments, so this seam intentionally accepts any[].
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcRuntimeHandler<TEvent> = (event: TEvent, ...args: any[]) => unknown;

interface IpcRuntimeRegistrationDeps<TEvent> {
  register: (channel: IpcInvokeChannel, handler: IpcRuntimeHandler<TEvent>) => void;
  isTrustedSender: (event: TEvent) => boolean;
}

/** Record real registrations and fail startup if main and the classified IPC inventory drift. */
export function createIpcRuntimeRegistration<TEvent>(deps: IpcRuntimeRegistrationDeps<TEvent>) {
  const registered = new Set<IpcInvokeChannel>();

  return {
    handle(channel: IpcInvokeChannel, handler: IpcRuntimeHandler<TEvent>): void {
      if (!isIpcInvokeChannel(channel)) throw new Error(`Unclassified IPC channel: ${channel}`);
      if (registered.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`);
      registered.add(channel);
      deps.register(channel, (event, ...args) => {
        if (!deps.isTrustedSender(event)) throw new Error(`Rejected IPC sender for ${channel}.`);
        return handler(event, ...args);
      });
    },

    assertComplete(): void {
      const missing = Object.values(IPC).filter((channel) => !registered.has(channel));
      if (missing.length > 0) throw new Error(`Missing IPC handlers: ${missing.join(", ")}`);
    },
  };
}
