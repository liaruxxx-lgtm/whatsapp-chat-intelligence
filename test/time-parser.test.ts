import { describe, expect, it } from "vitest";

import { parseEventMessage, parseTimeExpression } from "../src/events/time-parser.js";

function parse(text: string, timestamp = "2026-01-15T10:00:00Z") {
  const result = parseEventMessage({ messageId: "message-1", timestamp, text });
  expect(result).toBeDefined();
  return result!;
}

describe("event time parser", () => {
  it("anchors German today expressions to the source message timestamp in Europe/Berlin", () => {
    const result = parse("Heute um 15 Uhr treffen wir uns.");

    expect(result.candidate.status).toBe("confirmed");
    expect(result.candidate.time).toMatchObject({
      startsAt: "2026-01-15T14:00:00Z",
      timezone: "Europe/Berlin",
      language: "de"
    });
    expect(result.time).toMatchObject({ localDate: "2026-01-15", timeOfDay: "15:00", isPast: false });
    expect(result.candidate.sourceMessageIds).toEqual(["message-1"]);
  });

  it("recognizes English tomorrow expressions", () => {
    const result = parse("The meeting is tomorrow at 09:30.", "2026-07-01T20:00:00Z");

    expect(result.candidate.status).toBe("confirmed");
    expect(result.candidate.time).toMatchObject({
      startsAt: "2026-07-02T07:30:00Z",
      timezone: "Europe/Berlin",
      language: "en"
    });
    expect(result.time).toMatchObject({ localDate: "2026-07-02", timeOfDay: "09:30" });
  });

  it("resolves next weekdays strictly after the message date", () => {
    const result = parse("Nächsten Freitag um 16:00 Uhr Meeting.", "2026-06-01T10:00:00Z");

    expect(result.candidate.status).toBe("confirmed");
    expect(result.time).toMatchObject({
      localDate: "2026-06-05",
      timeOfDay: "16:00",
      startsAt: "2026-06-05T14:00:00Z"
    });
  });

  it("does not misread the numeric part of a German date as a clock time", () => {
    const result = parse("Treffen am 15.03.2026 um 16:30 Uhr", "2026-01-01T10:00:00Z");

    expect(result.time).toMatchObject({
      localDate: "2026-03-15",
      timeOfDay: "16:30",
      startsAt: "2026-03-15T15:30:00Z"
    });
  });

  it("uses the Berlin DST offset on both sides of the transition", () => {
    const summer = parse("Morgen um 09:00 Uhr", "2026-03-28T12:00:00Z");
    const winter = parse("Morgen um 09:00 Uhr", "2026-10-24T12:00:00Z");

    expect(summer.candidate.time.startsAt).toBe("2026-03-29T07:00:00Z");
    expect(winter.candidate.time.startsAt).toBe("2026-10-25T08:00:00Z");
  });

  it("does not silently alter a local time in the spring DST gap", () => {
    const result = parse("Treffen am 2026-03-29 um 02:30 Uhr", "2026-03-01T12:00:00Z");

    expect(result.candidate.status).toBe("uncertain");
    expect(result.candidate.time.startsAt).toBeUndefined();
    expect(result.time.rationale).toContain("DST transition");
  });

  it("uses the earlier occurrence deterministically in the autumn DST overlap", () => {
    const result = parse("Treffen am 2026-10-25 um 02:30 Uhr", "2026-10-01T12:00:00Z");

    expect(result.candidate.status).toBe("confirmed");
    expect(result.candidate.time.startsAt).toBe("2026-10-25T00:30:00Z");
    expect(result.time.rationale).toContain("earlier occurrence");
  });

  it("marks questions and hedged plans as non-confirmed", () => {
    const question = parse("Wollen wir uns morgen um 15 Uhr treffen?");
    const tentative = parse("Vielleicht treffen wir uns morgen um 15 Uhr.");

    expect(question.candidate.status).toBe("proposed");
    expect(tentative.candidate.status).toBe("tentative");
  });

  it("keeps a clock-only change unresolved instead of inventing its date", () => {
    const german = parse("Das Treffen ist auf 16 Uhr verschoben.");
    const english = parse("The meeting was moved to 16:30.");

    expect(german).toMatchObject({ action: "change", candidate: { status: "changed" } });
    expect(german.time).toMatchObject({ timeOfDay: "16:00" });
    expect(german.candidate.time.startsAt).toBeUndefined();
    expect(german.time.localDate).toBeUndefined();

    expect(english).toMatchObject({ action: "change", candidate: { status: "changed" } });
    expect(english.time).toMatchObject({ timeOfDay: "16:30" });
    expect(english.candidate.time.startsAt).toBeUndefined();
  });

  it("detects explicit cancellations without fabricating an appointment time", () => {
    const german = parse("Das Treffen fällt aus.");
    const english = parse("The meeting is cancelled.");

    expect(german).toMatchObject({ action: "cancel", candidate: { status: "cancelled" } });
    expect(english).toMatchObject({ action: "cancel", candidate: { status: "cancelled" } });
    expect(german.candidate.time.startsAt).toBeUndefined();
    expect(english.candidate.time.startsAt).toBeUndefined();
  });

  it("does not mistake an explicitly negated cancellation or change for an action", () => {
    const notCancelled = parse("Das Treffen ist nicht abgesagt, sondern heute um 15 Uhr.");
    const notMoved = parse("The meeting was not moved; it is today at 15:00.");

    expect(notCancelled).toMatchObject({ action: "create", candidate: { status: "confirmed" } });
    expect(notMoved).toMatchObject({ action: "create", candidate: { status: "confirmed" } });
  });

  it("keeps multiple possible dates or times unresolved", () => {
    const result = parseTimeExpression({
      text: "Heute um 15 Uhr oder morgen um 16 Uhr",
      messageTimestamp: "2026-06-01T10:00:00Z"
    });

    expect(result).toMatchObject({ ambiguousDate: true, ambiguousTime: true });
    expect(result.startsAt).toBeUndefined();
    expect(result.localDate).toBeUndefined();
    expect(result.timeOfDay).toBeUndefined();
  });

  it("preserves a past explicit instant so downstream notifications can skip it", () => {
    const result = parse("Heute um 15 Uhr", "2026-06-01T13:30:00Z");

    expect(result.candidate.status).toBe("confirmed");
    expect(result.candidate.time.startsAt).toBe("2026-06-01T13:00:00Z");
    expect(result.isPast).toBe(true);
  });
});
