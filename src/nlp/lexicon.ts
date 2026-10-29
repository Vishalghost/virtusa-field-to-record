import drugsJson from './lexicon/drugs.json';
import proceduresJson from './lexicon/procedures.json';

export interface DrugEntry {
  name: string;
  rxnorm: string | null;
  synonyms: string[];
  /** Routes this drug is normally given by; anything else raises a review warning. */
  routes: string[];
}

export interface ProcedureEntry {
  name: string;
  code: string;
  patterns: string[];
}

export const DRUGS: DrugEntry[] = drugsJson;
export const PROCEDURES: ProcedureEntry[] = proceduresJson;

/** lowercase surface form (hyphens -> spaces, matching the normalizer) -> canonical drug */
export const DRUG_TERMS = new Map<string, DrugEntry>();
for (const d of DRUGS) {
  for (const term of [d.name, ...d.synonyms]) {
    DRUG_TERMS.set(term.toLowerCase().replace(/-/g, ' '), d);
  }
}

export const drugByName = (name: string) => DRUGS.find((d) => d.name === name) ?? null;
