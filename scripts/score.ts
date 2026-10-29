// Event-level scoring shared by eval.ts (typed text) and eval-asr.ts (real speech).
//
//   - medication events are matched to gold by drug name (in order), procedures by name
//   - precision / recall / F1 over matched events
//   - per-field accuracy (dose, unit, route, site, time) over matched medication events
//   - "exact record" = every event and every field correct for that dictation

import { processTranscript } from '../src/nlp/pipeline';

export interface GoldMed { drug: string; dose: number | null; unit: string | null; route: string | null; site: string | null; time: string | null }
export interface GoldProc { procedure: string; detail: string | null; site: string | null; time: string | null }
export interface Item { id: string; tags?: string[]; text: string; gold: { medications: GoldMed[]; procedures: GoldProc[] } }

const MED_FIELDS = ['dose', 'unit', 'route', 'site', 'time'] as const;

/** Greedy in-order matching by key; returns matched pairs plus unmatched leftovers. */
function match<P, G>(pred: P[], gold: G[], key: (x: P | G) => string | null) {
  const left = [...pred];
  const pairs: [P, G][] = [];
  const missed: G[] = [];
  for (const g of gold) {
    const i = left.findIndex((p) => key(p) === key(g));
    if (i === -1) missed.push(g);
    else pairs.push([left.splice(i, 1)[0], g]);
  }
  return { pairs, missed, extra: left };
}

export function score(items: Item[], title: string, verbose: boolean): number {
  const tally = {
    med: { tp: 0, fp: 0, fn: 0 },
    proc: { tp: 0, fp: 0, fn: 0 },
    field: Object.fromEntries(MED_FIELDS.map((f) => [f, { ok: 0, n: 0 }])) as Record<(typeof MED_FIELDS)[number], { ok: number; n: number }>,
    exact: 0,
  };
  const failures: string[] = [];

  for (const item of items) {
    const out = processTranscript(item.text);
    const preds = out.medications.map((m) => ({ drug: m.drug, dose: m.dose, unit: m.unit, route: m.route, site: m.site, time: m.administeredAt }));
    const procs = out.procedures.map((p) => ({ procedure: p.procedure, detail: p.detail, site: p.site, time: p.performedAt }));

    const meds = match(preds, item.gold.medications, (x) => x.drug);
    const pr = match(procs, item.gold.procedures, (x) => x.procedure);

    tally.med.tp += meds.pairs.length; tally.med.fp += meds.extra.length; tally.med.fn += meds.missed.length;
    tally.proc.tp += pr.pairs.length; tally.proc.fp += pr.extra.length; tally.proc.fn += pr.missed.length;

    const problems: string[] = [];
    for (const [p, g] of meds.pairs) {
      for (const f of MED_FIELDS) {
        tally.field[f].n++;
        if (p[f] === g[f]) tally.field[f].ok++;
        else problems.push(`${g.drug}.${f}: got ${JSON.stringify(p[f])}, want ${JSON.stringify(g[f])}`);
      }
    }
    for (const [p, g] of pr.pairs) {
      for (const f of ['detail', 'site', 'time'] as const) {
        if (p[f] !== g[f]) problems.push(`${g.procedure}.${f}: got ${JSON.stringify(p[f])}, want ${JSON.stringify(g[f])}`);
      }
    }
    meds.missed.forEach((g) => problems.push(`missed medication ${g.drug}`));
    meds.extra.forEach((p) => problems.push(`extra medication ${p.drug ?? '(no drug)'} ${p.dose ?? ''}${p.unit ?? ''}`));
    pr.missed.forEach((g) => problems.push(`missed procedure ${g.procedure}`));
    pr.extra.forEach((p) => problems.push(`extra procedure ${p.procedure}`));

    if (!problems.length) tally.exact++;
    else failures.push(`${item.id} [${(item.tags ?? []).join(', ')}]\n  "${item.text}"\n  - ${problems.join('\n  - ')}`);
  }

  const prf = ({ tp, fp, fn }: { tp: number; fp: number; fn: number }) => {
    const p = tp / (tp + fp || 1);
    const r = tp / (tp + fn || 1);
    const f = (2 * p * r) / (p + r || 1);
    return `P ${p.toFixed(3)}  R ${r.toFixed(3)}  F1 ${f.toFixed(3)}  (tp ${tp}, fp ${fp}, fn ${fn})`;
  };
  const pct = (ok: number, n: number) => `${((100 * ok) / (n || 1)).toFixed(1)}% (${ok}/${n})`;

  console.log(`${title} — ${items.length} dictations\n`);
  console.log(`Medication events   ${prf(tally.med)}`);
  console.log(`Procedure events    ${prf(tally.proc)}`);
  console.log('\nMedication field accuracy (on matched events):');
  for (const f of MED_FIELDS) console.log(`  ${f.padEnd(6)} ${pct(tally.field[f].ok, tally.field[f].n)}`);
  console.log(`\nFully correct records: ${pct(tally.exact, items.length)}`);
  if (failures.length) {
    console.log(`\n${failures.length} dictation(s) with errors${verbose ? ':' : ' (run with --verbose for details)'}`);
    if (verbose) console.log('\n' + failures.join('\n\n'));
  }
  return tally.exact;
}
