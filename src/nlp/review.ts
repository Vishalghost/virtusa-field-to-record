// Review policy: which extracted events a medic must look at before signing.
// 'block' flags prevent "Sign & lock" until the medic confirms or edits the event;
// 'warn' flags are shown but do not block.

import type { MedicationEvent, ProcedureEvent, ReviewFlag } from '../record/schema';
import { drugByName } from './lexicon';

/** Fuzzy (speech-recognition-repaired) drug matches score below this. */
export const LOW_CONFIDENCE = 0.85;

export function medicationFlags(ev: MedicationEvent): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const block = (reason: string) => flags.push({ severity: 'block', reason });
  const warn = (reason: string) => flags.push({ severity: 'warn', reason });

  if (!ev.drug) block('Dose recorded but no drug identified');
  else if (ev.confidence < LOW_CONFIDENCE) block('Drug name was matched approximately — confirm it');
  if (ev.dose === null && ev.doseAlternatives) {
    block(`Dose unclear: said ${ev.doseAlternatives.join(' or ')}${ev.unit ? ` ${ev.unit}` : ''}; enter the dose given`);
  } else if (ev.dose === null) block('No dose stated');
  else if (!ev.unit) block('Dose has no unit');
  if (!ev.route) block('No route stated');
  if (!ev.administeredAt) warn('No administration time stated (capture time will be used)');

  const entry = ev.drug ? drugByName(ev.drug) : null;
  if (entry && ev.route && !entry.routes.includes(ev.route)) warn(`Unusual route ${ev.route} for ${ev.drug}`);
  return flags;
}

export function procedureFlags(ev: ProcedureEvent): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  if (!ev.performedAt) flags.push({ severity: 'warn', reason: 'No time stated (capture time will be used)' });
  return flags;
}

export const isBlocked = (ev: { flags: ReviewFlag[]; confirmed: boolean }) =>
  !ev.confirmed && ev.flags.some((f) => f.severity === 'block');
