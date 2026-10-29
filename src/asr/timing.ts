// When was each word spoken? Whisper returns segments with start times (seconds into
// the audio); adding the recording's start clock gives the wall-clock time a drug or
// procedure was named. Segments are phrase-level, so this is accurate to a phrase,
// not a word.

export interface AsrSegment {
  text: string;
  /** Seconds from the start of the audio. */
  start: number;
  end: number | null;
}

/** Seconds into the audio at which the text at `rawOffset` (in the raw transcript) was spoken. */
export function secondsAt(rawOffset: number, rawTranscript: string, segments: AsrSegment[]): number {
  let cursor = 0;
  let seconds = segments[0]?.start ?? 0;
  for (const s of segments) {
    const t = s.text.trim();
    const i = t ? rawTranscript.indexOf(t, cursor) : -1;
    const at = i === -1 ? cursor : i;
    if (at > rawOffset) break;
    seconds = s.start;
    if (i !== -1) cursor = i + t.length;
  }
  return seconds;
}
