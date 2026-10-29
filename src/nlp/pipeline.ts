import type { Entity, MedicationEvent, ProcedureEvent } from '../record/schema';
import { extract } from './extract';
import { link } from './link';
import { medicationFlags, procedureFlags } from './review';

export interface PipelineResult {
  entities: Entity[];
  medications: MedicationEvent[];
  procedures: ProcedureEvent[];
}

/** transcript -> entities -> linked events -> review flags */
export function processTranscript(transcript: string): PipelineResult {
  const { entities, normalized } = extract(transcript);
  const { medications, procedures } = link(entities, normalized);
  for (const m of medications) m.flags = medicationFlags(m);
  for (const p of procedures) p.flags = procedureFlags(p);
  return { entities, medications, procedures };
}
