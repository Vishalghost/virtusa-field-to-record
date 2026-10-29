// Core data model for a Field-to-Record clinical note.
// Every extracted value carries the span of transcript text it came from, so a
// reviewer (or auditor) can always trace a field back to what was actually said.

export interface Span {
  start: number; // char offset into the verbatim transcript (inclusive)
  end: number; // exclusive
}

export type EntityType = 'DRUG' | 'DOSE' | 'ROUTE' | 'PROCEDURE' | 'SITE' | 'TIME' | 'CORRECTION';

export interface Entity {
  type: EntityType;
  /** Canonical value: drug name, route code, "HH:MM", procedure name, site text, dose number as string. */
  value: string;
  /** Exact transcript text the entity was read from. */
  text: string;
  span: Span;
  /** Offset into the normalized text; used internally for ordering/proximity. */
  normStart: number;
  confidence: number;
  unit?: string; // DOSE only
  code?: string; // DRUG: RxNorm CUI
  detail?: string; // PROCEDURE: e.g. "18g", "200 J"
  alternatives?: number[]; // DOSE: "2 or 5 mg" -> [2, 5], value is ''
}

export type ReviewSeverity = 'block' | 'warn';

export interface ReviewFlag {
  severity: ReviewSeverity;
  reason: string;
}

/**
 * Where an event's time came from. Only 'dictated' is a time someone stated; the clock
 * kinds record when the note was made, which can be later than the actual administration.
 *   dictated: said aloud ("at 10:30")
 *   spoken:   device clock at the moment the item was spoken (recording start + offset)
 *   entered:  device clock when a typed note was extracted
 *   edited:   set by hand during review
 */
export type TimeSource = 'dictated' | 'spoken' | 'entered' | 'edited';

export interface MedicationEvent {
  kind: 'medication';
  id: string;
  drug: string | null;
  rxnorm: string | null;
  dose: number | null;
  /** Set when two doses were said ("2 or 5 mg"); `dose` then stays null until a human picks. */
  doseAlternatives?: number[];
  unit: string | null;
  route: string | null;
  site: string | null;
  /** "HH:MM". From the dictation if stated, else stamped from the device clock (see timeSource). */
  administeredAt: string | null;
  timeSource?: TimeSource;
  confidence: number;
  sourceSpans: Span[];
  flags: ReviewFlag[];
  confirmed: boolean;
}

export interface ProcedureEvent {
  kind: 'procedure';
  id: string;
  procedure: string;
  code: string;
  detail: string | null;
  site: string | null;
  performedAt: string | null;
  timeSource?: TimeSource;
  confidence: number;
  sourceSpans: Span[];
  flags: ReviewFlag[];
  confirmed: boolean;
}

export type ClinicalEvent = MedicationEvent | ProcedureEvent;

export interface EditEntry {
  at: string; // ISO timestamp
  eventId: string;
  field: string;
  from: unknown;
  to: unknown;
}

export interface ClinicalRecord {
  id: string;
  version: number;
  /** id of the record version this one amends, if any. */
  supersedes: string | null;
  incidentId: string;
  source: 'voice' | 'text';
  /** Device clock when the note was captured (ISO). */
  recordedAt: string;
  /** Verbatim transcript; never modified after extraction. */
  transcript: string;
  /** Speech model output before mishearing repairs, if any were applied (evidence of what was heard). */
  rawTranscript?: string;
  /** Repairs applied to `rawTranscript` to produce `transcript`; spans index `transcript`. */
  speechRepairs?: { heard: string; readAs: string; start: number; end: number }[];
  medications: MedicationEvent[];
  procedures: ProcedureEvent[];
  edits: EditEntry[];
  status: 'draft' | 'signed';
  signedBy: string | null;
  signedAt: string | null;
  prevHash: string | null;
  hash: string | null;
  /** Signer device public key (base64url). Covered by `hash`. Absent on records signed before device keys existed. */
  deviceKey?: string;
  /** ECDSA signature of `hash` by `deviceKey` (base64url). Not covered by `hash`. */
  signature?: string;
}
