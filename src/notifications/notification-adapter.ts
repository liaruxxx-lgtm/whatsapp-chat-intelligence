import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NotificationPayload } from "../domain/types.js";

const execFileAsync = promisify(execFile);

export interface NotificationAdapter {
  readonly channel: string;
  send(payload: NotificationPayload): Promise<void>;
}

export class NotificationAdapterError extends Error {
  public constructor(public readonly code: "macos_notification_unavailable" | "macos_notification_delivery_failed") {
    super(code);
    this.name = "NotificationAdapterError";
  }
}

export class MemoryNotificationAdapter implements NotificationAdapter {
  public readonly channel = "memory";
  public readonly notifications: NotificationPayload[] = [];

  public async send(payload: NotificationPayload): Promise<void> {
    this.notifications.push({ ...payload });
  }
}

function appleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

/** Uses macOS Notification Center and deliberately has no WhatsApp transport. */
export class MacOSNotificationAdapter implements NotificationAdapter {
  public readonly channel = "macos-notification-center";

  public async send(payload: NotificationPayload): Promise<void> {
    if (process.platform !== "darwin") {
      throw new NotificationAdapterError("macos_notification_unavailable");
    }
    const script = `display notification "${appleScriptString(payload.body)}" with title "${appleScriptString(payload.title)}"`;
    try {
      await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 10_000 });
    } catch {
      // macOS reports a denied Notification Center permission through osascript;
      // expose a stable local status without retaining its potentially verbose output.
      throw new NotificationAdapterError("macos_notification_delivery_failed");
    }
  }
}
