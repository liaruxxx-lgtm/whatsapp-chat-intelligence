import { Temporal } from "@js-temporal/polyfill";

import type { EventCandidate, EventStatus, IncomingMessage, TimeResolution } from "../domain/types.js";

/** The product default. Callers may supply a configured IANA time zone instead. */
export const DEFAULT_EVENT_TIMEZONE = "Europe/Berlin";

type ParserLanguage = TimeResolution["language"];

type DateKind = "today" | "tomorrow" | "next_weekday" | "absolute";

interface DateMatch {
  date: Temporal.PlainDate;
  expression: string;
  kind: DateKind;
  index: number;
}

interface ClockTime {
  hour: number;
  minute: number;
  expression: string;
  index: number;
  end: number;
}

interface LocalDateTimeResolution {
  startsAt?: string;
  isPast: boolean;
  dstState: "normal" | "overlap" | "gap" | "invalid_timezone";
}

export interface TimeParserInput {
  /** Message body to inspect. */
  text: string;
  /** An ISO-8601 instant from the source message, including an offset or `Z`. */
  messageTimestamp: string;
  /** IANA time zone used for relative expressions. Defaults to Europe/Berlin. */
  timeZone?: string;
}

/**
 * A deterministic parse of the temporal information in one message.
 *
 * `localDate` and `timeOfDay` deliberately remain separate. In particular,
 * a phrase such as "auf 16 Uhr verschoben" has a useful clock time but no
 * stated date, so it never receives an invented `startsAt` value.
 */
export interface ParsedTimeExpression {
  timezone: string;
  language: ParserLanguage;
  confidence: number;
  rationale: string;
  localDate?: string;
  timeOfDay?: string;
  startsAt?: string;
  isPast: boolean;
  dateKind?: DateKind;
  dateExpression?: string;
  timeExpression?: string;
  ambiguousDate: boolean;
  ambiguousTime: boolean;
}

export interface EventParserOptions {
  timeZone?: string;
}

/**
 * Metadata retained alongside the domain candidate for an event resolver.
 * `action` lets a resolver distinguish an actual date/time change from a new
 * event while still keeping this module free of chat history and storage.
 */
export interface ParsedEvent {
  candidate: EventCandidate;
  time: ParsedTimeExpression;
  action: "create" | "change" | "cancel";
  isPast: boolean;
}

const weekdays: Record<string, number> = {
  montag: 1,
  monday: 1,
  dienstag: 2,
  tuesday: 2,
  mittwoch: 3,
  wednesday: 3,
  donnerstag: 4,
  thursday: 4,
  freitag: 5,
  friday: 5,
  samstag: 6,
  saturday: 6,
  sonntag: 7,
  sunday: 7
};

const germanWeekdayPattern = "montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag";
const englishWeekdayPattern = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";

const germanNextWeekday = new RegExp(
  `\\b(?:(?:n(?:ä|ae)chst(?:e|en|er|es)?)|kommenden)\\s+(${germanWeekdayPattern})\\b`,
  "giu"
);
const englishNextWeekday = new RegExp(`\\bnext\\s+(${englishWeekdayPattern})\\b`, "giu");
const todayPattern = /\b(?:heute|today)\b/giu;
const tomorrowPattern = /\b(?:morgen|tomorrow)\b/giu;
const isoDatePattern = /\b(\d{4})-(\d{2})-(\d{2})\b/gu;
const germanAbsoluteDatePattern = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/gu;

// The final guard prevents the `15.03` part of a German numeric date from
// being misread as 15:03. A bare 24-hour value may be followed by normal
// sentence punctuation, whitespace, or end-of-input.
const clockWithMinutesPattern =
  /\b([01]?\d|2[0-3])\s*[:.]\s*([0-5]\d)(?:\s*(?:uhr|h)\b|(?!\s*\.\s*\d)(?=\s|$|[.,;:!?…)\]}–—-]))/giu;
const clockWithUnitPattern = /\b([01]?\d|2[0-3])\s*(?:uhr|h)\b/giu;
const contextualHourPattern = /\b(?:um|gegen|ab|at|around)\s+([01]?\d|2[0-3])(?!\s*[:.]\s*\d)\b/giu;

const appointmentCuePattern =
  /\b(?:treffen|termin|meeting|besprechung|verabredung|verabreden|vereinbaren|zusammenkommen|arzttermin|call|anruf|meet|appointment|catch\s+up)\b/iu;
const deadlineCuePattern = /\b(?:deadline|frist|fällig|faellig|due)\b/iu;
const taskCuePattern = /\b(?:aufgabe|todo|to-do|task|erledigen)\b/iu;
const reminderCuePattern = /\b(?:erinnerung|erinnere|reminder|remind)\b/iu;

const cancellationPattern =
  /\b(?:(?:fällt|faellt)\s+aus|abgesagt|absagen|storniert|annulliert|(?:entfällt|entfaellt)|findet\s+nicht\s+statt|(?:doch|aber)\s+nicht|cancelled|canceled|cancel|called\s+off|won['’]t\s+happen|will\s+not\s+happen|not\s+happening)\b/iu;
const negatedCancellationPattern =
  /\b(?:(?:nicht|not)\s+(?:abgesagt|absagen|storniert|annulliert|cancelled|canceled|cancel)|(?:fällt|faellt)\s+nicht\s+aus|(?:is|was)\s+not\s+(?:cancelled|canceled)|not\s+called\s+off)\b/iu;
const changeWordPattern = /\b(?:verschoben|verlegt|geändert|geandert|umgelegt|rescheduled|moved|postponed|shifted|changed)\b/iu;
const negatedChangePattern =
  /\b(?:nicht|not)\s+(?:verschoben|verlegt|geändert|geandert|umgelegt|rescheduled|moved|postponed|shifted|changed)\b/iu;
const questionPattern =
  /[?？]|\b(?:wollen\s+wir|können\s+wir|koennen\s+wir|sollen\s+wir|kann(?:st)?\s+du|can\s+we|could\s+we|should\s+we|would\s+you|when\s+(?:can|should)|is\s+.+\?)\b/iu;
const tentativePattern =
  /\b(?:vielleicht|eventuell|evtl\.?|möglicherweise|moeglicherweise|wenn\s+es\s+passt|falls|maybe|perhaps|possibly|might|if\s+that\s+works)\b/iu;

const germanSignalPattern =
  /\b(?:heute|morgen|uhr|nächste(?:n|r|s)?|naechste(?:n|r|s)?|treffen|termin|verschoben|abgesagt|fällt|faellt)\b/iu;
const englishSignalPattern =
  /\b(?:today|tomorrow|next|at|meet|meeting|appointment|rescheduled|cancelled|canceled)\b/iu;
const germanTemporalSignalPattern =
  /\b(?:heute|morgen|uhr|nächste(?:n|r|s)?|naechste(?:n|r|s)?|kommenden)\b/iu;
const englishTemporalSignalPattern = /\b(?:today|tomorrow|next|around)\b/iu;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeText(value: string): string {
  return normalizeWhitespace(value.normalize("NFKC"));
}

/** Global regular expressions are shared constants, so do not carry `lastIndex`
 * from one message into the next. */
function allMatches(expression: RegExp, text: string): IterableIterator<RegExpMatchArray> {
  expression.lastIndex = 0;
  return text.matchAll(expression);
}

function hasMatch(expression: RegExp, text: string): boolean {
  expression.lastIndex = 0;
  const found = expression.test(text);
  expression.lastIndex = 0;
  return found;
}

function languageFor(text: string): ParserLanguage {
  // A borrowed noun such as the German "Meeting" must not turn an otherwise
  // German date expression into an unknown language. Prefer temporal markers
  // over generic event vocabulary.
  const germanTemporal = germanTemporalSignalPattern.test(text);
  const englishTemporal = englishTemporalSignalPattern.test(text);
  if (germanTemporal && !englishTemporal) return "de";
  if (englishTemporal && !germanTemporal) return "en";

  const german = germanSignalPattern.test(text);
  const english = englishSignalPattern.test(text);

  if (german && !english) return "de";
  if (english && !german) return "en";
  return "unknown";
}

function referenceInstant(timestamp: string): Temporal.Instant | undefined {
  try {
    return Temporal.Instant.from(timestamp);
  } catch {
    return undefined;
  }
}

function referenceDate(timestamp: string, timeZone: string): Temporal.PlainDate | undefined {
  const instant = referenceInstant(timestamp);
  if (!instant) return undefined;

  try {
    return instant.toZonedDateTimeISO(timeZone).toPlainDate();
  } catch {
    return undefined;
  }
}

function nextWeekday(reference: Temporal.PlainDate, weekday: number): Temporal.PlainDate {
  let days = (weekday - reference.dayOfWeek + 7) % 7;
  // "next Friday" is always strictly after the message date, even on a Friday.
  if (days === 0) days = 7;
  return reference.add({ days });
}

function addRelativeDateMatches(text: string, reference: Temporal.PlainDate, matches: DateMatch[]): void {
  for (const match of allMatches(germanNextWeekday, text)) {
    const weekdayName = match[1]?.toLocaleLowerCase("de-DE");
    const weekday = weekdayName ? weekdays[weekdayName] : undefined;
    const index = match.index;
    if (weekday === undefined || index === undefined) continue;
    matches.push({
      date: nextWeekday(reference, weekday),
      expression: match[0],
      kind: "next_weekday",
      index
    });
  }

  for (const match of allMatches(englishNextWeekday, text)) {
    const weekdayName = match[1]?.toLocaleLowerCase("en-US");
    const weekday = weekdayName ? weekdays[weekdayName] : undefined;
    const index = match.index;
    if (weekday === undefined || index === undefined) continue;
    matches.push({
      date: nextWeekday(reference, weekday),
      expression: match[0],
      kind: "next_weekday",
      index
    });
  }

  for (const match of allMatches(todayPattern, text)) {
    const index = match.index;
    if (index === undefined) continue;
    matches.push({ date: reference, expression: match[0], kind: "today", index });
  }

  for (const match of allMatches(tomorrowPattern, text)) {
    const index = match.index;
    if (index === undefined) continue;
    matches.push({ date: reference.add({ days: 1 }), expression: match[0], kind: "tomorrow", index });
  }
}

function parseExplicitDate(year: string, month: string, day: string): Temporal.PlainDate | undefined {
  try {
    return Temporal.PlainDate.from(
      { year: Number(year), month: Number(month), day: Number(day) },
      { overflow: "reject" }
    );
  } catch {
    return undefined;
  }
}

function addAbsoluteDateMatches(text: string, matches: DateMatch[]): void {
  for (const match of allMatches(isoDatePattern, text)) {
    const [year, month, day] = [match[1], match[2], match[3]];
    const index = match.index;
    if (!year || !month || !day || index === undefined) continue;
    const date = parseExplicitDate(year, month, day);
    if (!date) continue;
    matches.push({ date, expression: match[0], kind: "absolute", index });
  }

  for (const match of allMatches(germanAbsoluteDatePattern, text)) {
    const [day, month, year] = [match[1], match[2], match[3]];
    const index = match.index;
    if (!year || !month || !day || index === undefined) continue;
    const date = parseExplicitDate(year, month, day);
    if (!date) continue;
    matches.push({ date, expression: match[0], kind: "absolute", index });
  }
}

function uniqueDateMatch(matches: DateMatch[]): { match?: DateMatch; ambiguous: boolean } {
  const byDate = new Map<string, DateMatch>();
  for (const match of matches) {
    const key = match.date.toString();
    const existing = byDate.get(key);
    if (!existing || match.index < existing.index) byDate.set(key, match);
  }

  if (byDate.size !== 1) return { ambiguous: byDate.size > 1 };
  const match = [...byDate.values()][0];
  return match ? { match, ambiguous: false } : { ambiguous: false };
}

function collectDateMatch(text: string, timestamp: string, timeZone: string): {
  match?: DateMatch;
  ambiguous: boolean;
  hadDateExpression: boolean;
} {
  const matches: DateMatch[] = [];
  addAbsoluteDateMatches(text, matches);

  const reference = referenceDate(timestamp, timeZone);
  if (reference) addRelativeDateMatches(text, reference, matches);

  const hadDateExpression =
    matches.length > 0 ||
    hasMatch(germanNextWeekday, text) ||
    hasMatch(englishNextWeekday, text) ||
    hasMatch(todayPattern, text) ||
    hasMatch(tomorrowPattern, text) ||
    hasMatch(isoDatePattern, text) ||
    hasMatch(germanAbsoluteDatePattern, text);
  const selected = uniqueDateMatch(matches);

  return { ...selected, hadDateExpression };
}

function intervalsOverlap(first: ClockTime, second: ClockTime): boolean {
  return first.index < second.end && second.index < first.end;
}

function collectClockTimes(text: string): { time?: ClockTime; ambiguous: boolean; hadTimeExpression: boolean } {
  const matches: ClockTime[] = [];

  const add = (hourText: string | undefined, minuteText: string | undefined, expression: string, index: number): void => {
    if (!hourText) return;
    const hour = Number(hourText);
    const minute = minuteText ? Number(minuteText) : 0;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return;
    const candidate: ClockTime = { hour, minute, expression, index, end: index + expression.length };
    if (matches.some((existing) => intervalsOverlap(existing, candidate))) return;
    matches.push(candidate);
  };

  for (const match of allMatches(clockWithMinutesPattern, text)) {
    if (match.index === undefined) continue;
    add(match[1], match[2], match[0], match.index);
  }

  for (const match of allMatches(clockWithUnitPattern, text)) {
    if (match.index === undefined) continue;
    add(match[1], undefined, match[0], match.index);
  }

  for (const match of allMatches(contextualHourPattern, text)) {
    if (match.index === undefined) continue;
    add(match[1], undefined, match[0], match.index);
  }

  const byClock = new Map<string, ClockTime>();
  for (const match of matches) {
    const key = `${String(match.hour).padStart(2, "0")}:${String(match.minute).padStart(2, "0")}`;
    const existing = byClock.get(key);
    if (!existing || match.index < existing.index) byClock.set(key, match);
  }

  if (byClock.size !== 1) {
    return { ambiguous: byClock.size > 1, hadTimeExpression: matches.length > 0 };
  }

  const time = [...byClock.values()][0];
  return time
    ? { time, ambiguous: false, hadTimeExpression: true }
    : { ambiguous: false, hadTimeExpression: false };
}

function samePlainDateTime(
  plain: Temporal.PlainDateTime,
  zoned: Temporal.ZonedDateTime
): boolean {
  const resolved = zoned.toPlainDateTime();
  return (
    resolved.year === plain.year &&
    resolved.month === plain.month &&
    resolved.day === plain.day &&
    resolved.hour === plain.hour &&
    resolved.minute === plain.minute
  );
}

function resolveLocalDateTime(
  date: Temporal.PlainDate,
  time: ClockTime,
  timeZone: string,
  timestamp: string
): LocalDateTimeResolution {
  try {
    const plain = date.toPlainDateTime({ hour: time.hour, minute: time.minute });
    const earlier = plain.toZonedDateTime(timeZone, { disambiguation: "earlier" });
    const later = plain.toZonedDateTime(timeZone, { disambiguation: "later" });
    const earlierMatches = samePlainDateTime(plain, earlier);
    const laterMatches = samePlainDateTime(plain, later);

    // The local wall-clock value never occurs during a spring-forward gap.
    if (!earlierMatches && !laterMatches) {
      return { isPast: false, dstState: "gap" };
    }

    // During a fall-back overlap we choose the earlier occurrence explicitly.
    // That choice is deterministic and is surfaced in the rationale below.
    const overlap = earlier.epochNanoseconds !== later.epochNanoseconds;
    const eventInstant = earlier.toInstant();
    const receivedAt = referenceInstant(timestamp);
    return {
      startsAt: eventInstant.toString(),
      isPast: receivedAt ? Temporal.Instant.compare(eventInstant, receivedAt) <= 0 : false,
      dstState: overlap ? "overlap" : "normal"
    };
  } catch {
    return { isPast: false, dstState: "invalid_timezone" };
  }
}

function confidenceFor(
  date: DateMatch | undefined,
  time: ClockTime | undefined,
  ambiguousDate: boolean,
  ambiguousTime: boolean,
  resolution: LocalDateTimeResolution | undefined
): number {
  if (ambiguousDate || ambiguousTime) return 0.25;
  if (resolution?.dstState === "gap" || resolution?.dstState === "invalid_timezone") return 0.2;
  if (resolution?.dstState === "overlap") return 0.8;
  if (resolution?.startsAt) return 0.95;
  if (date && time) return 0.7;
  if (date || time) return 0.55;
  return 0.2;
}

function temporalRationale(
  date: DateMatch | undefined,
  time: ClockTime | undefined,
  ambiguousDate: boolean,
  ambiguousTime: boolean,
  hadDateExpression: boolean,
  resolution: LocalDateTimeResolution | undefined,
  timeZone: string
): string {
  const parts: string[] = [];
  if (ambiguousDate) {
    parts.push("multiple different date expressions were found; no date was selected");
  } else if (date) {
    parts.push(`${date.kind.replace("_", " ")} date \"${date.expression}\" resolved to ${date.date.toString()}`);
  } else if (hadDateExpression) {
    parts.push("a date expression was present but the message timestamp could not resolve it");
  } else {
    parts.push("no explicit date was found");
  }

  if (ambiguousTime) {
    parts.push("multiple different clock times were found; no time was selected");
  } else if (time) {
    parts.push(`clock time \"${time.expression}\" parsed as ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`);
  } else {
    parts.push("no explicit 24-hour clock time was found");
  }

  if (resolution?.startsAt) {
    parts.push(`normalized in ${timeZone}`);
    if (resolution.dstState === "overlap") {
      parts.push("DST overlap resolved to the earlier occurrence");
    }
    if (resolution.isPast) parts.push("the resolved time is not after the source message timestamp");
  } else if (resolution?.dstState === "gap") {
    parts.push(`the local time does not exist in ${timeZone} because of a DST transition`);
  } else if (resolution?.dstState === "invalid_timezone") {
    parts.push(`the supplied time zone \"${timeZone}\" could not be resolved`);
  } else if (date || time) {
    parts.push("a complete date and time are required before an instant is emitted");
  }

  return parts.join("; ");
}

/**
 * Parse only temporal language. This function never consults the current clock;
 * all relative expressions are anchored to `messageTimestamp`.
 */
export function parseTimeExpression(input: TimeParserInput): ParsedTimeExpression {
  const text = normalizeText(input.text);
  const timeZone = input.timeZone ?? DEFAULT_EVENT_TIMEZONE;
  const language = languageFor(text);
  const dateResult = collectDateMatch(text, input.messageTimestamp, timeZone);
  const timeResult = collectClockTimes(text);
  const resolution =
    dateResult.match && timeResult.time && !dateResult.ambiguous && !timeResult.ambiguous
      ? resolveLocalDateTime(dateResult.match.date, timeResult.time, timeZone, input.messageTimestamp)
      : undefined;

  const parsed: ParsedTimeExpression = {
    timezone: timeZone,
    language,
    confidence: confidenceFor(
      dateResult.match,
      timeResult.time,
      dateResult.ambiguous,
      timeResult.ambiguous,
      resolution
    ),
    rationale: temporalRationale(
      dateResult.match,
      timeResult.time,
      dateResult.ambiguous,
      timeResult.ambiguous,
      dateResult.hadDateExpression,
      resolution,
      timeZone
    ),
    isPast: resolution?.isPast ?? false,
    ambiguousDate: dateResult.ambiguous,
    ambiguousTime: timeResult.ambiguous
  };

  if (dateResult.match) {
    parsed.localDate = dateResult.match.date.toString();
    parsed.dateKind = dateResult.match.kind;
    parsed.dateExpression = dateResult.match.expression;
  }
  if (timeResult.time) {
    parsed.timeOfDay = `${String(timeResult.time.hour).padStart(2, "0")}:${String(timeResult.time.minute).padStart(2, "0")}`;
    parsed.timeExpression = timeResult.time.expression;
  }
  if (resolution?.startsAt) parsed.startsAt = resolution.startsAt;

  return parsed;
}

function classifyEventType(text: string): EventCandidate["type"] {
  if (deadlineCuePattern.test(text)) return "deadline";
  if (taskCuePattern.test(text)) return "task";
  if (reminderCuePattern.test(text)) return "reminder";
  return "appointment";
}

function deriveTitle(text: string): string {
  const withoutTemporalPhrases = text
    .replace(germanNextWeekday, " ")
    .replace(englishNextWeekday, " ")
    .replace(todayPattern, " ")
    .replace(tomorrowPattern, " ")
    .replace(isoDatePattern, " ")
    .replace(germanAbsoluteDatePattern, " ")
    .replace(clockWithMinutesPattern, " ")
    .replace(clockWithUnitPattern, " ")
    .replace(contextualHourPattern, " ")
    .replace(/\b(?:um|gegen|ab|at|around|am|on)\b/giu, " ");
  const title = normalizeWhitespace(withoutTemporalPhrases)
    .replace(/^[,;:–—\-\s]+/u, "")
    .replace(/[.?!,;:–—\-\s]+$/u, "");

  // Never synthesize a title: keep a bounded excerpt of the source if removing
  // temporal language would leave no user-provided words behind.
  return (title || text).slice(0, 160);
}

function statusFor(
  action: ParsedEvent["action"],
  question: boolean,
  tentative: boolean,
  time: ParsedTimeExpression
): EventStatus {
  if (question) return "proposed";
  if (tentative) return "tentative";
  if (action === "cancel") return "cancelled";
  if (action === "change") return "changed";
  if (time.startsAt && !time.ambiguousDate && !time.ambiguousTime) return "confirmed";
  return "uncertain";
}

/**
 * Detect one possible event from a text message. It is intentionally pure: it
 * does not look up previous events. A resolver can use `action`, `timeOfDay`,
 * and the source message ID to apply changes/cancellations to an existing
 * logical event.
 */
export function parseEventMessage(
  message: Pick<IncomingMessage, "messageId" | "timestamp" | "text">,
  options: EventParserOptions = {}
): ParsedEvent | undefined {
  const text = message.text ? normalizeText(message.text) : "";
  if (!text || !message.messageId) return undefined;

  const timeInput: TimeParserInput = { text, messageTimestamp: message.timestamp };
  if (options.timeZone !== undefined) timeInput.timeZone = options.timeZone;
  const time = parseTimeExpression(timeInput);
  const hasAppointmentCue = appointmentCuePattern.test(text);
  const type = classifyEventType(text);
  const hasCancellation = cancellationPattern.test(text) && !negatedCancellationPattern.test(text);
  const hasChangeWord = changeWordPattern.test(text) && !negatedChangePattern.test(text);
  const hasTemporalPair = Boolean(time.localDate && time.timeOfDay);
  const hasActionContext = hasAppointmentCue || hasTemporalPair || time.timeOfDay !== undefined || time.localDate !== undefined;
  const action: ParsedEvent["action"] = hasCancellation
    ? "cancel"
    : hasChangeWord && hasActionContext
      ? "change"
      : "create";
  const isQuestion = questionPattern.test(text);
  const isTentative = tentativePattern.test(text);

  // A temporal pair is enough for the documented vertical slice ("Heute um
  // 15 Uhr"). A lone date or time requires an event cue, preventing ordinary
  // conversational fragments from becoming candidates.
  const isEventLike =
    action !== "create" ||
    hasAppointmentCue ||
    type !== "appointment" ||
    hasTemporalPair;
  if (!isEventLike) return undefined;

  const status = statusFor(action, isQuestion, isTentative, time);
  const candidateTime: TimeResolution = {
    timezone: time.timezone,
    confidence: time.confidence,
    rationale: time.rationale,
    language: time.language
  };
  if (time.startsAt) candidateTime.startsAt = time.startsAt;

  return {
    candidate: {
      type,
      title: deriveTitle(text),
      status,
      time: candidateTime,
      sourceMessageIds: [message.messageId]
    },
    time,
    action,
    isPast: time.isPast
  };
}

/** A convenience API for callers that only need the domain candidate. */
export function parseEventCandidate(
  message: Pick<IncomingMessage, "messageId" | "timestamp" | "text">,
  options: EventParserOptions = {}
): EventCandidate | undefined {
  return parseEventMessage(message, options)?.candidate;
}
