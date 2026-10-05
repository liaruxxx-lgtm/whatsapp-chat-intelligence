import type { IncomingMedia, TranscriptSegment } from "../domain/types.js";

export type TranscriptionResult =
  | {
      status: "completed" | "uncertain";
      text: string;
      language: "de" | "en" | "unknown";
      confidence: number;
      segments: TranscriptSegment[];
    }
  | {
      status: "failed" | "unavailable";
      errorCode: "media_unavailable" | "local_runner_unavailable" | "invalid_audio_fixture";
    };

export interface LocalTranscriber {
  transcribe(media: IncomingMedia): Promise<TranscriptionResult>;
}

/**
 * The only built-in transcriber deliberately accepts controlled fixtures. A real
 * local runner can implement the same interface after it has been selected and
 * tested on the operator's hardware. There is no cloud fallback.
 */
export class FixtureLocalTranscriber implements LocalTranscriber {
  public async transcribe(media: IncomingMedia): Promise<TranscriptionResult> {
    if (media.unavailable) return { status: "unavailable", errorCode: "media_unavailable" };
    const fixture = media.fixtureTranscript;
    if (!fixture) return { status: "failed", errorCode: "local_runner_unavailable" };
    if (!fixture.text.trim() || fixture.segments.length === 0) {
      return { status: "failed", errorCode: "invalid_audio_fixture" };
    }
    return {
      status: fixture.confidence >= 0.7 ? "completed" : "uncertain",
      text: fixture.text,
      language: fixture.language,
      confidence: fixture.confidence,
      segments: fixture.segments.map((segment, index) => ({
        ...segment,
        id: segment.id ?? `fixture-segment-${index + 1}`
      }))
    };
  }
}
