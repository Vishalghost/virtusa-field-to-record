// Dev-time check: confirm each RxNorm code in the drug lexicon resolves to the
// expected ingredient name via NLM's public RxNav API. Sends drug codes only (no PHI).
import { readFileSync } from 'node:fs';

const drugs = JSON.parse(readFileSync(new URL('../src/nlp/lexicon/drugs.json', import.meta.url), 'utf8'));
let bad = 0;
for (const d of drugs) {
  if (!d.rxnorm) continue;
  const res = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${d.rxnorm}/properties.json`);
  const name = (await res.json())?.properties?.name ?? '(none)';
  const ok = [d.name, ...d.synonyms].some((n) => name.toLowerCase().includes(n.split(' ')[0].toLowerCase()));
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${d.rxnorm.padEnd(6)} ${d.name.padEnd(20)} -> ${name}`);
}
process.exit(bad ? 1 : 0);
