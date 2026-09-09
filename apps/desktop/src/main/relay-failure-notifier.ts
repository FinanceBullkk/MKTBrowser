import type { MessageBoxOptions } from "electron";

interface RelayFailureNotifierOptions {
  showMessageBox: (options: MessageBoxOptions) => Promise<unknown>;
  notify: (title: string, message: string) => void;
}

/** An unanswered notice must not hold the Relay check or Electron's main loop. */
export class RelayFailureNotifier {
  private dialogPending = false;
  private readonly options: RelayFailureNotifierOptions;

  constructor(options: RelayFailureNotifierOptions) {
    this.options = options;
  }

  show(message: string, useDialog: boolean): void {
    const title = "Relay needs attention";
    if (!useDialog) {
      this.options.notify(title, message);
      return;
    }
    if (this.dialogPending) return;
    this.dialogPending = true;
    const failed = () => {
      this.dialogPending = false;
      this.options.notify(title, message);
    };
    try {
      void this.options
        .showMessageBox({
          type: "error",
          title,
          message,
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(() => {
          this.dialogPending = false;
        }, failed);
    } catch {
      failed();
    }
  }
}
