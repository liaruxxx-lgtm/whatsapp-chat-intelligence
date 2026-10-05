import type { DetectedEvent } from "../domain/types.js";
import { SqliteMessageStore } from "../storage/sqlite-store.js";

export interface StructuredSummary {
  shortSummary: string;
  newPoints: string[];
  decisions: string[];
  openQuestions: string[];
  tasks: Array<{ title: string; sourceMessageIds: string[]; confidence: number }>;
  appointments: Array<{
    id: string;
    title: string;
    startsAt?: string;
    status: DetectedEvent["status"];
    confidence: number;
    sourceMessageIds: string[];
  }>;
  changes: string[];
  unresolvedContradictions: string[];
  dataGaps: string[];
  sourceMessageIds: string[];
  /** Identifies the deterministic parser or an explicitly configured provider. */
  modelVersion: string;
}

export interface SummaryInput {
  readonly chatId: string;
  readonly events: readonly DetectedEvent[];
  readonly changedEvents: readonly DetectedEvent[];
}

/**
 * Provider-neutral boundary for a future local or explicitly opted-in model.
 * Implementations must return this exact structured shape; they never receive
 * credentials, media paths, or non-allowlisted chat content through this API.
 */
export interface StructuredSummaryProvider {
  readonly modelVersion: string;
  summarize(input: SummaryInput): StructuredSummary;
}

export class DeterministicSummaryProvider implements StructuredSummaryProvider {
  public readonly modelVersion = "deterministic-v1";

  public summarize(input: SummaryInput): StructuredSummary {
    const { events, changedEvents } = input;
    const appointments = events.map((event) => {
      const item: StructuredSummary["appointments"][number] = {
        id: event.id,
        title: event.title,
        status: event.status,
        confidence: event.confidence,
        sourceMessageIds: event.sourceMessageIds
      };
      if (event.startsAt) item.startsAt = event.startsAt;
      return item;
    });
    const dataGaps: string[] = [];
    if (events.some((event) => event.status === "uncertain" || event.status === "pending_resolution")) {
      dataGaps.push("Mindestens ein Termin ist noch unsicher oder widersprüchlich.");
    }
    return {
      shortSummary: events.length === 0
        ? "Noch keine quellenbelegten Ereignisse erkannt."
        : `${events.length} quellenbelegte Ereignis(se) im aktuellen Chat-Zustand.`,
      newPoints: changedEvents.map((event) => event.title),
      decisions: [],
      openQuestions: events.filter((event) => event.status === "proposed" || event.status === "uncertain")
        .map((event) => event.title),
      tasks: [],
      appointments,
      changes: changedEvents
        .filter((event) => event.status === "changed" || event.status === "cancelled")
        .map((event) => event.title),
      unresolvedContradictions: events.filter((event) => event.status === "pending_resolution").map((event) => event.title),
      dataGaps,
      sourceMessageIds: [...new Set(events.flatMap((event) => event.sourceMessageIds))],
      modelVersion: this.modelVersion
    };
  }
}

function assertSourceSubset(sourceIds: readonly string[], allowed: ReadonlySet<string>): void {
  if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== "string" || id.length === 0 || !allowed.has(id))) {
    throw new Error("summary_provider_returned_unbound_sources");
  }
}

/** Enforces the data-contract boundary before a provider output is persisted. */
function assertStructuredSummary(summary: StructuredSummary, allowedSourceIds: ReadonlySet<string>): void {
  if (!summary || typeof summary !== "object" || typeof summary.shortSummary !== "string" || typeof summary.modelVersion !== "string") {
    throw new Error("summary_provider_returned_invalid_shape");
  }
  assertSourceSubset(summary.sourceMessageIds, allowedSourceIds);
  for (const task of summary.tasks) assertSourceSubset(task.sourceMessageIds, allowedSourceIds);
  for (const appointment of summary.appointments) assertSourceSubset(appointment.sourceMessageIds, allowedSourceIds);
}

/**
 * A structured conservative baseline. A future provider can replace this via
 * the validated provider contract, but must preserve sources and uncertainty.
 */
export class DeterministicSummaryService {
  public constructor(
    private readonly store: SqliteMessageStore,
    private readonly provider: StructuredSummaryProvider = new DeterministicSummaryProvider()
  ) {}

  /**
   * Creates an incremental, source-bound snapshot. `changedEvents` is supplied
   * by the pipeline after a resolver transition, so a new-points field never
   * needs to infer changes from unreferenced free text.
   */
  public snapshot(
    chatId: string,
    changedEvents: readonly DetectedEvent[] = []
  ): { id: string; summary: StructuredSummary } {
    const events = this.store.listEvents(chatId);
    const input: SummaryInput = { chatId, events, changedEvents };
    const summary = this.provider.summarize(input);
    assertStructuredSummary(summary, new Set(events.flatMap((event) => event.sourceMessageIds)));
    const persisted: StructuredSummary = { ...summary, modelVersion: this.provider.modelVersion };
    return { id: this.store.createSummarySnapshot(chatId, persisted, persisted.sourceMessageIds, this.provider.modelVersion), summary: persisted };
  }
}
