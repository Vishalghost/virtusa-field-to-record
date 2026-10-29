// Standalone, printable HTML patient-care-report section generated from the record JSON.

import type { ClinicalRecord } from '../record/schema';
import { MED_HEAD, PROC_HEAD, medRow, procRow } from './format';

/** Every dictated/typed value is escaped: the file is opened outside the app. */
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const table = (head: string[], rows: string[][]) =>
  rows.length
    ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : '<p class="none">None recorded.</p>';

export function renderHtml(r: ClinicalRecord): string {
  const signed = r.status === 'signed';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field Record ${esc(r.incidentId)} v${r.version}</title>
<style>
  body{font:14px/1.45 system-ui,sans-serif;color:#111;max-width:860px;margin:24px auto;padding:0 16px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 6px;border-bottom:2px solid #111;padding-bottom:2px}
  .meta{color:#444;font-size:12px} .status{display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px}
  .signed{background:#dcfce7;color:#14532d} .draft{background:#fef3c7;color:#78350f}
  table{border-collapse:collapse;width:100%;font-size:13px} th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}
  th{background:#f1f5f9} .none{color:#666;font-style:italic}
  blockquote{margin:0;padding:8px 12px;background:#f8fafc;border-left:3px solid #94a3b8;white-space:pre-wrap}
  code{font-size:11px;word-break:break-all} footer{margin-top:24px;font-size:11px;color:#666}
</style></head><body>
<h1>Field Record — Medications &amp; Procedures</h1>
<div class="meta">Incident <b>${esc(r.incidentId)}</b> · Version ${r.version}${r.supersedes ? ` (amends ${esc(r.supersedes)})` : ''} ·
Captured ${esc(new Date(r.recordedAt).toLocaleString())} via ${esc(r.source)}
<span class="status ${signed ? 'signed' : 'draft'}">${signed ? 'SIGNED' : 'DRAFT — NOT SIGNED'}</span></div>

<h2>Medications administered</h2>
${table(MED_HEAD, r.medications.map((m) => medRow(r, m)))}

<h2>Procedures performed</h2>
${table(PROC_HEAD, r.procedures.map((p) => procRow(r, p)))}

<h2>Verbatim dictation</h2>
<blockquote>${esc(r.transcript)}</blockquote>

<h2>Review log (${r.edits.length})</h2>
${table(['When', 'Event', 'Field', 'From', 'To'], r.edits.map((e) => [new Date(e.at).toLocaleTimeString(), e.eventId, e.field, typeof e.from === 'object' && e.from ? '(event)' : String(e.from), String(e.to)]))}

<h2>Audit</h2>
${signed
  ? `<p>Signed by <b>${esc(r.signedBy)}</b> at ${esc(new Date(r.signedAt!).toLocaleString())}</p>
<p>SHA-256: <code>${esc(r.hash)}</code><br>Previous: <code>${esc(r.prevHash)}</code></p>`
  : '<p class="none">Not signed — this document is not part of the audit chain.</p>'}
<footer>Generated offline by Field-to-Record. Times marked "(capture)" were not dictated; the device capture time is shown instead.
Synthetic data only — not for clinical use.</footer>
</body></html>`;
}
