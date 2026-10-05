import { randomUUID } from "node:crypto";
import type { DetectedEvent, NotificationPayload, ReminderRecord } from "../domain/types.js";
import type { MessageSource } from "../domain/types.js";
import type { SafeLogger } from "../security/logger.js";
import { SqliteMessageStore } from "../storage/sqlite-store.js";
import { NotificationAdapterError, type NotificationAdapter } from "./notification-adapter.js";

export type EventNotificationEffect = "new" | "changed" | "cancelled" | "none";

function nowIso(): string {
  return new Date().toISOString();
}

function deliveryErrorCode(error: unknown): string {
  return error instanceof NotificationAdapterError ? error.code : "notification_delivery_failed";
}

function formatEventTime(startsAt: string | undefined, timezone: string): string {
  if (!startsAt) return "Zeit noch offen";
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone
  }).format(new Date(startsAt));
}

function reminderFor(
  event: DetectedEvent,
  kind: ReminderRecord["kind"],
  dueAt: string
): ReminderRecord {
  const deliveryKey = `${event.id}:v${event.version}:${kind}:${dueAt}`;
  return {
    id: randomUUID(),
    eventId: event.id,
    eventVersion: event.version,
    dueAt,
    kind,
    status: "scheduled",
    deliveryKey,
    createdAt: nowIso()
  };
}

export class ReminderService {
  private deliveryInProgress = false;

  public constructor(
    private readonly store: SqliteMessageStore,
    private readonly adapter: NotificationAdapter,
    private readonly reminderLeadMinutes: number,
    private readonly logger: SafeLogger,
    private readonly onDeliveryError?: (code: string) => void
  ) {}

  public scheduleFromEvent(event: DetectedEvent, effect: EventNotificationEffect, source: MessageSource, observedAt = nowIso()): void {
    if (source === "history_sync" || source === "chat_export" || effect === "none") return;

    if (effect === "cancelled") {
      this.store.cancelRemindersForEvent(event.id);
      this.store.scheduleReminder(reminderFor(event, "event_cancelled", observedAt));
      return;
    }

    if (!event.notificationEligible || !event.startsAt || new Date(event.startsAt).getTime() <= new Date(observedAt).getTime()) return;

    this.store.cancelRemindersForEvent(event.id, event.version);
    const dueAt = new Date(new Date(event.startsAt).getTime() - this.reminderLeadMinutes * 60_000).toISOString();
    this.store.scheduleReminder(reminderFor(event, "event_due", dueAt));
    if (effect === "changed") {
      this.store.scheduleReminder(reminderFor(event, "event_changed", observedAt));
    }
  }

  public async deliverDue(now = nowIso()): Promise<number> {
    return this.runDeliveryExclusively(0, async () => {
      // If the worker stopped between a local claim and osascript, make the
      // notification eligible again before inspecting due records.
      this.store.requeueInFlightReminderClaims();
      let delivered = 0;
      for (const reminder of this.store.listDueReminders(now)) {
        const event = this.store.getEvent(reminder.eventId);
        if (!event || event.version !== reminder.eventVersion || event.status === "cancelled" || event.status === "completed") {
          this.store.markReminderSkipped(reminder.id);
          continue;
        }
        if (!this.store.claimReminderForDelivery(reminder.id)) continue;
        try {
          await this.adapter.send(this.payloadFor(event, reminder));
          if (this.store.markReminderDelivered(reminder, this.adapter.channel)) delivered += 1;
        } catch (error) {
          this.store.releaseReminderDeliveryClaim(reminder.id);
          this.onDeliveryError?.(deliveryErrorCode(error));
          this.logger.write({
            level: "error",
            event: "notification_delivery_failed",
            metadata: { code: error instanceof Error ? error.name : "unknown", eventId: event.id }
          });
        }
      }
      return delivered;
    });
  }

  /**
   * Wake-up recovery intentionally emits at most one current notification, not
   * one per missed message/reminder. Stale scheduled reminders are skipped.
   */
  public async recoverAfterWake(now = nowIso()): Promise<number> {
    return this.runDeliveryExclusively(0, async () => {
      this.store.requeueInFlightReminderClaims();
      const candidates = this.store.listDueReminders(now);
      const relevant = candidates
        .map((reminder) => ({ reminder, event: this.store.getEvent(reminder.eventId) }))
        .filter((candidate): candidate is { reminder: ReminderRecord; event: DetectedEvent } => Boolean(
          candidate.event
          && candidate.event.version === candidate.reminder.eventVersion
          && candidate.event.status !== "cancelled"
          && candidate.event.status !== "completed"
        ));
      if (relevant.length === 0) return 0;

      const chosen = relevant.sort((a, b) => b.event.updatedAt.localeCompare(a.event.updatedAt))[0];
      if (!chosen) return 0;
      const other = relevant.filter((candidate) => candidate !== chosen);
      for (const skipped of other) this.store.markReminderSkipped(skipped.reminder.id);
      if (!this.store.claimReminderForDelivery(chosen.reminder.id)) return 0;
      try {
        await this.adapter.send({
          ...this.payloadFor(chosen.event, chosen.reminder),
          kind: "recovery",
          title: "Aktueller Terminstatus nach Wiederaufnahme",
          body: `${chosen.event.title}: ${formatEventTime(chosen.event.startsAt, chosen.event.timezone)}`
        });
        return this.store.markReminderDelivered(chosen.reminder, this.adapter.channel, "wake_recovery") ? 1 : 0;
      } catch (error) {
        this.store.releaseReminderDeliveryClaim(chosen.reminder.id);
        this.onDeliveryError?.(deliveryErrorCode(error));
        this.logger.write({
          level: "error",
          event: "notification_recovery_delivery_failed",
          metadata: { code: error instanceof Error ? error.name : "unknown", eventId: chosen.event.id }
        });
        return 0;
      }
    });
  }

  private async runDeliveryExclusively<T>(fallback: T, work: () => Promise<T>): Promise<T> {
    if (this.deliveryInProgress) return fallback;
    this.deliveryInProgress = true;
    try {
      return await work();
    } finally {
      this.deliveryInProgress = false;
    }
  }

  private payloadFor(event: DetectedEvent, reminder: ReminderRecord): NotificationPayload {
    const time = formatEventTime(event.startsAt, event.timezone);
    const text = `${event.title}: ${time}`;
    const titles: Record<ReminderRecord["kind"], string> = {
      event_created: "Neuer möglicher Termin",
      event_changed: "Termin geändert",
      event_cancelled: "Termin abgesagt",
      event_due: "Terminerinnerung",
      recovery: "Aktueller Terminstatus"
    };
    return {
      title: titles[reminder.kind],
      body: text,
      eventId: event.id,
      eventVersion: event.version,
      kind: reminder.kind,
      deliveryKey: reminder.deliveryKey
    };
  }
}
