// Evaluates the extraction pipeline against the gold-labelled synthetic dictations
// (scoring rules: see score.ts).
//
// Usage: npm run eval [-- --verbose] [-- path/to/dictations.json]

import { readFileSync } from 'node:fs';
import { score, type Item } from './score';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? new URL('../data/synthetic/dictations.json', import.meta.url);
const items: Item[] = JSON.parse(readFileSync(file, 'utf8'));
score(items, 'Field-to-Record eval', args.includes('--verbose'));
