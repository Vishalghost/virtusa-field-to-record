// Turns a flat entity list into clinical events: which dose, route, site and time
// belong to which drug or procedure.
//
// Segmentation: the dictation is cut into segments at sentence ends and at
// sequencing words ("then", "after that", "followed by"). Attributes are only
// linked to drugs/procedures in the same segment, so "epi IM. Then zofran 4 mg IV"
// can never give zofran's route to epinephrine.
//
// Corrections: "scratch that" / "correction" discards everything dictated in the
// segment before it (or the whole previous segment if it starts a segment).

import type { Entity, MedicationEvent, ProcedureEvent } from '../record/schema';
import type { Normalized } from './normalize';

const BOUNDARY_RE = /(?:^|\s)(?:[.;!?]|then|after\s+that|followed\s+by|next)(?=\s|$)/g;

export interface Segment {
  entities: Entity[];
}

export function segment(entities: Entity[], n: Normalized): Segment[] {
  const cuts = [...n.text.matchAll(BOUNDARY_RE)].map((m) => m.index!);
  const segments: Segment[] = [{ entities: [] }];
  let c = 0;
  for (const e of entities) {
    let opened = false;
    while (c < cuts.length && cuts[c] <= e.normStart) {
      c++;
      opened = true;
    }
    if (opened && segments[segments.length - 1].entities.length) segments.push({ entities: [] });
    if (e.type === 'CORRECTION') {
      const cur = segments[segments.length - 1];
      if (cur.entities.length) cur.entities = [];
      else if (segments.length > 1) segments[segments.length - 2].entities = [];
      continue;
    }
    segments[segments.length - 1].entities.push(e);
  }
  return segments.filter((s) => s.entities.length);
}

/**
 * Decide which drug mention(s) in this segment a DOSE or ROUTE entity describes.
 *
 * `drugs` are the DRUG entities of the segment in dictation order; compare
 * positions with `normStart` (offset in normalized text, which `text` holds).
 * Return [] when no drug should own it. A DOSE should go to at most one drug;
 * a ROUTE may be shared ("albuterol 2.5 mg and ipratropium 0.5 mg via neb").
 *
 * Phrasings to keep in mind (all in data/synthetic/dictations.json):
 *   "gave 0.3 mg epi IM"                        dose BEFORE its drug
 *   "epi 0.3 mg IM"                             dose AFTER its drug
 *   "4 mg of zofran and 25 mg of benadryl IV"   "of" glues a dose to the NEXT drug; route shared
 *   "324 mg aspirin PO and 0.4 mg nitro SL"     dose-before-drug, route after, per drug
 *   "albuterol 2.5 mg and ipratropium 0.5 mg via neb"   one trailing route for the whole list
 *
 * TODO(you): replace this placeholder (nearest preceding drug, else first
 * following) with your linking rule, then run `npm run eval -- --verbose`.
 */
export function chooseDrugsFor(attr: Entity, drugs: Entity[], text: string): Entity[] {
  void text;
  const before = drugs.filter((d) => d.normStart < attr.normStart);
  if (before.length) return [before[before.length - 1]];
  return drugs.length ? [drugs[0]] : [];
}

let nextId = 0;
const newId = (prefix: string) => `${prefix}-${++nextId}`;
export const resetIds = () => {
  nextId = 0;
};

function newMed(drug: Entity | null): MedicationEvent {
  return {
    kind: 'medication',
    id: newId('med'),
    drug: drug?.value ?? null,
    rxnorm: drug?.code ?? null,
    dose: null,
    unit: null,
    route: null,
    site: null,
    administeredAt: null,
    confidence: drug?.confidence ?? 0.5,
    sourceSpans: drug ? [drug.span] : [],
    flags: [],
    confirmed: false,
  };
}

function newProc(p: Entity): ProcedureEvent {
  return {
    kind: 'procedure',
    id: newId('proc'),
    procedure: p.value,
    code: p.code ?? '',
    detail: p.detail ?? null,
    site: null,
    performedAt: null,
    confidence: p.confidence,
    sourceSpans: [p.span],
    flags: [],
    confirmed: false,
  };
}

export function link(entities: Entity[], n: Normalized): { medications: MedicationEvent[]; procedures: ProcedureEvent[] } {
  const medications: MedicationEvent[] = [];
  const procedures: ProcedureEvent[] = [];

  for (const seg of segment(entities, n)) {
    const drugs = seg.entities.filter((e) => e.type === 'DRUG');
    // One event per drug mention; owner entity -> event(s) for that mention.
    const eventsFor = new Map<Entity, MedicationEvent[]>(drugs.map((d) => [d, [newMed(d)]]));
    const procEvents = seg.entities.filter((e) => e.type === 'PROCEDURE').map((p) => ({ entity: p, event: newProc(p) }));
    const orphans: MedicationEvent[] = [];

    for (const attr of seg.entities) {
      if (attr.type === 'DOSE' && attr.alternatives) {
        // "2 or 5 mg": attach the doubt to the drug and leave the dose for a human to pick.
        const owner = chooseDrugsFor(attr, drugs, n.text)[0];
        if (!owner) continue; // two numbers with no drug nearby is not a medication
        const list = eventsFor.get(owner)!;
        const ev = list[list.length - 1];
        if (ev.dose !== null || ev.doseAlternatives) continue;
        ev.doseAlternatives = attr.alternatives;
        ev.unit = attr.unit ?? null;
        ev.sourceSpans.push(attr.span);
      } else if (attr.type === 'DOSE') {
        const owner = chooseDrugsFor(attr, drugs, n.text)[0];
        if (!owner) {
          const ev = newMed(null);
          ev.dose = Number(attr.value);
          ev.unit = attr.unit ?? null;
          ev.sourceSpans.push(attr.span);
          orphans.push(ev);
          continue;
        }
        const list = eventsFor.get(owner)!;
        let ev = list[list.length - 1];
        if (ev.dose !== null) {
          // Second dose for the same mention ("epi 0.3 mg, repeated 0.3 mg") = another administration.
          ev = { ...newMed(owner), route: ev.route, site: ev.site };
          list.push(ev);
        }
        ev.dose = Number(attr.value);
        ev.unit = attr.unit ?? null;
        ev.sourceSpans.push(attr.span);
      } else if (attr.type === 'ROUTE') {
        for (const owner of chooseDrugsFor(attr, drugs, n.text)) {
          for (const ev of eventsFor.get(owner)!) {
            if (ev.route === null) {
              ev.route = attr.value;
              ev.sourceSpans.push(attr.span);
            }
          }
        }
      }
    }

    const allMeds = [...[...eventsFor.values()].flat(), ...orphans];

    // Sites go to the nearest drug or procedure mention ("IV left AC", "epi IM right thigh").
    for (const site of seg.entities.filter((e) => e.type === 'SITE')) {
      const candidates: { pos: number; set: () => void }[] = [
        ...drugs.map((d) => ({ pos: d.normStart, set: () => eventsFor.get(d)!.forEach((ev) => { ev.site ??= site.value; ev.sourceSpans.push(site.span); }) })),
        ...procEvents.map((p) => ({ pos: p.entity.normStart, set: () => { p.event.site ??= site.value; p.event.sourceSpans.push(site.span); } })),
      ];
      candidates.sort((a, b) => Math.abs(a.pos - site.normStart) - Math.abs(b.pos - site.normStart));
      candidates[0]?.set();
    }

    // A time stated in the segment applies to every event in it. No time -> stays null.
    const time = seg.entities.find((e) => e.type === 'TIME');
    if (time) {
      for (const ev of allMeds) { ev.administeredAt = time.value; ev.sourceSpans.push(time.span); }
      for (const { event } of procEvents) { event.performedAt = time.value; event.sourceSpans.push(time.span); }
    }

    medications.push(...allMeds);
    procedures.push(...procEvents.map((p) => p.event));
  }
  return { medications, procedures };
}
