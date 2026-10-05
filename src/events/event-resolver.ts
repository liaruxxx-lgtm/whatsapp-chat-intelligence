import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { DetectedEvent, EventCandidate, IncomingMessage, MessageSource } from "../domain/types.js";
import type { ParsedEvent } from "./time-parser.js";
import { SqliteMessageStore } from "../storage/sqlite-store.js";

export type ResolutionEffect = "new" | "changed" | "cancelled" | "none";

export interface Resolution {
  event?: DetectedEvent;
  effect: ResolutionEffect;
}

function nowIso(): string {
  return new Date().toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function notificationEligible(candidate: EventCandidate): boolean {
  return (candidate.status === "confirmed" || candidate.status === "changed")
    && Boolean(candidate.time.startsAt)
    && candidate.time.confidence >= 0.75;
}

function appendSources(event: DetectedEvent, candidate: EventCandidate): string[] {
  return unique([...event.sourceMessageIds, ...candidate.sourceMessageIds]);
}

const topicStopWords = new Set([
  "aber", "auf", "das", "dem", "den", "der", "die", "doch", "ein", "eine", "einen", "es", "ist", "the", "was", "is", "to", "at",
  "treffen", "termin", "meeting", "appointment", "verschoben", "verlegt", "geändert", "geandert", "rescheduled", "moved", "postponed",
  "abgesagt", "absage", "cancelled", "canceled", "fällt", "faellt", "aus", "statt", "findet", "nicht", "heute", "morgen", "today", "tomorrow"
]);

/** Conservative subject terms for disambiguating several active chat events. */
function topicTerms(title: string): Set<string> {
  const words = title.normalize("NFKC").toLocaleLowerCase("de-DE").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(words.filter((word) => !topicStopWords.has(word)));
}

function topicScore(left: string, right: string): number {
  const leftTerms = topicTerms(left);
  const rightTerms = topicTerms(right);
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  let shared = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) shared += 1;
  return shared;
}

export class EventResolver {
  public constructor(private readonly store: SqliteMessageStore) {}

  public resolve(parsed: ParsedEvent, message: Pick<IncomingMessage, "chatId" | "source">): Resolution {
    if (parsed.isPast && parsed.action === "create") {
      const uncertain = this.newEvent(parsed.candidate, message.chatId, "uncertain", false);
      uncertain.resolutionRationale = `${parsed.candidate.time.rationale}; Zeitpunkt liegt bereits in der Vergangenheit.`;
      this.store.saveEvent(uncertain);
      return { event: uncertain, effect: "none" };
    }

    if (parsed.action === "change") return this.applyChange(parsed.candidate, parsed, message.chatId, message.source);
    if (parsed.action === "cancel") return this.applyCancellation(parsed.candidate, message.chatId, message.source);
    return this.applyCreate(parsed.candidate, message.chatId, message.source);
  }

  private applyCreate(candidate: EventCandidate, chatId: string, source: MessageSource): Resolution {
    const previous = this.store.getLatestResolvableEventByTopic(chatId, candidate.type, candidate.title);
    if (previous && previous.startsAt === candidate.time.startsAt && previous.status === candidate.status) {
      const consolidated: DetectedEvent = {
        ...previous,
        sourceMessageIds: appendSources(previous, candidate),
        updatedAt: nowIso(),
        resolutionRationale: "Wiederholung desselben bestätigten Terminstands; keine neue Benachrichtigung."
      };
      this.store.saveEvent(consolidated);
      return { event: consolidated, effect: "none" };
    }

    // An explicit new confirmation of the exact same topic after cancellation
    // reactivates its logical event instead of leaving two active histories.
    const cancelled = previous ?? this.store.getLatestEventByTopic(chatId, candidate.type, candidate.title);
    if (cancelled?.status === "cancelled") {
      const reactivated: DetectedEvent = {
        ...cancelled,
        status: candidate.status,
        timezone: candidate.time.timezone,
        confidence: candidate.time.confidence,
        sourceMessageIds: appendSources(cancelled, candidate),
        updatedAt: nowIso(),
        version: cancelled.version + 1,
        notificationEligible: notificationEligible(candidate),
        resolutionRationale: `${candidate.time.rationale}; reactivated after explicit cancellation.`
      };
      if (candidate.time.startsAt !== undefined) reactivated.startsAt = candidate.time.startsAt;
      this.store.saveEvent(reactivated);
      return { event: reactivated, effect: source === "history_sync" || source === "chat_export" ? "none" : "new" };
    }

    const event = this.newEvent(candidate, chatId, candidate.status, notificationEligible(candidate));
    this.store.saveEvent(event);
    return { event, effect: source === "history_sync" || source === "chat_export" ? "none" : "new" };
  }

  private applyChange(candidate: EventCandidate, parsed: ParsedEvent, chatId: string, source: MessageSource): Resolution {
    const match = this.findTarget(candidate, chatId);
    const previous = match.event;
    if (!previous) {
      const unresolved = this.newEvent(candidate, chatId, "pending_resolution", false);
      unresolved.resolutionRationale = match.ambiguous
        ? "Änderung bezieht sich auf mehrere aktive Termine; keine Erinnerung geplant."
        : "Änderung ohne zuvor auflösbaren Termin; keine Erinnerung geplant.";
      this.store.saveEvent(unresolved);
      return { event: unresolved, effect: "none" };
    }

    let startsAt = candidate.time.startsAt;
    if (!startsAt && parsed.time.timeOfDay && previous.startsAt) {
      startsAt = this.replaceTimeOfDay(previous.startsAt, parsed.time.timeOfDay, previous.timezone);
    }
    if (!startsAt) {
      const unresolved: DetectedEvent = {
        ...previous,
        status: "pending_resolution",
        sourceMessageIds: appendSources(previous, candidate),
        updatedAt: nowIso(),
        version: previous.version + 1,
        notificationEligible: false,
        resolutionRationale: "Änderung erkannt, aber neue Zeit ist nicht eindeutig; alte Erinnerung wird vorsorglich nicht ersetzt."
      };
      this.store.saveEvent(unresolved);
      return { event: unresolved, effect: "none" };
    }

    // A clear clock-only correction inherits its date from the prior confirmed
    // logical event. The parser correctly refuses to emit a standalone instant
    // in that situation, but the resolver has the missing, source-bound context.
    const resolvedConfidence = Math.min(1, Math.max(previous.confidence, candidate.time.confidence));
    const event: DetectedEvent = {
      ...previous,
      status: "changed",
      startsAt,
      timezone: candidate.time.timezone,
      confidence: resolvedConfidence,
      sourceMessageIds: appendSources(previous, candidate),
      updatedAt: nowIso(),
      version: previous.version + 1,
      notificationEligible: resolvedConfidence >= 0.75,
      resolutionRationale: candidate.time.rationale
    };
    this.store.saveEvent(event);
    return { event, effect: source === "history_sync" || source === "chat_export" ? "none" : "changed" };
  }

  private applyCancellation(candidate: EventCandidate, chatId: string, source: MessageSource): Resolution {
    const match = this.findTarget(candidate, chatId);
    const previous = match.event;
    if (!previous) {
      const unresolved = this.newEvent(candidate, chatId, "uncertain", false);
      unresolved.resolutionRationale = match.ambiguous
        ? "Absage bezieht sich auf mehrere aktive Termine; keine Erinnerung geplant."
        : "Absage ohne zuvor bestätigten Termin; keine Benachrichtigung.";
      this.store.saveEvent(unresolved);
      return { event: unresolved, effect: "none" };
    }
    const event: DetectedEvent = {
      ...previous,
      status: "cancelled",
      sourceMessageIds: appendSources(previous, candidate),
      updatedAt: nowIso(),
      version: previous.version + 1,
      notificationEligible: false,
      resolutionRationale: candidate.time.rationale
    };
    this.store.saveEvent(event);
    return { event, effect: source === "history_sync" || source === "chat_export" ? "none" : "cancelled" };
  }

  private newEvent(candidate: EventCandidate, chatId: string, status: DetectedEvent["status"], eligible: boolean): DetectedEvent {
    const at = nowIso();
    const event: DetectedEvent = {
      id: randomUUID(),
      chatId,
      type: candidate.type,
      title: candidate.title,
      timezone: candidate.time.timezone,
      status,
      confidence: candidate.time.confidence,
      sourceMessageIds: candidate.sourceMessageIds,
      createdAt: at,
      updatedAt: at,
      version: 1,
      notificationEligible: eligible,
      resolutionRationale: candidate.time.rationale
    };
    if (candidate.time.startsAt) event.startsAt = candidate.time.startsAt;
    if (candidate.participants) event.participants = candidate.participants;
    if (candidate.location) event.location = candidate.location;
    if (candidate.sourceTranscriptSegmentIds) event.sourceTranscriptSegmentIds = candidate.sourceTranscriptSegmentIds;
    return event;
  }

  /**
   * Recency alone is not a valid subject resolver. With several active events,
   * mutate only a uniquely matching subject; otherwise retain a visible
   * pending/uncertain record and leave existing reminders untouched.
   */
  private findTarget(candidate: EventCandidate, chatId: string): { event?: DetectedEvent; ambiguous: boolean } {
    const events = this.store.listResolvableEvents(chatId, candidate.type);
    if (events.length === 0) return { ambiguous: false };
    if (events.length === 1) {
      const only = events[0];
      if (!only) return { ambiguous: false };
      // Generic phrases such as "der Termin" can resolve the only active
      // event. A specific but different subject must remain unresolved rather
      // than silently rewrite that event.
      const candidateHasSubject = topicTerms(candidate.title).size > 0;
      const matchesSubject = topicScore(candidate.title, only.title) > 0;
      return !candidateHasSubject || matchesSubject
        ? { event: only, ambiguous: false }
        : { ambiguous: false };
    }

    const scored = events
      .map((event) => ({ event, score: topicScore(candidate.title, event.title) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    const best = scored[0];
    if (!best) return { ambiguous: true };
    const tied = scored.filter((entry) => entry.score === best.score);
    return tied.length === 1 ? { event: best.event, ambiguous: false } : { ambiguous: true };
  }

  /** Replace a local Europe/Berlin clock time while preserving the original date. */
  private replaceTimeOfDay(previousUtc: string, timeOfDay: string, timezone: string): string {
    const clock = /^(\d{1,2}):(\d{2})$/u.exec(timeOfDay);
    if (!clock) return previousUtc;
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return previousUtc;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(previousUtc));
    const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "01";
    return Temporal.ZonedDateTime.from({
      timeZone: timezone,
      year: Number(get("year")),
      month: Number(get("month")),
      day: Number(get("day")),
      hour,
      minute,
      second: 0
    }).toInstant().toString();
  }
}
