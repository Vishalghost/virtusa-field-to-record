// Printable PDF version of the same report (jsPDF runs fully client-side, offline).

import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import type { ClinicalRecord } from '../record/schema';
import { MED_HEAD, PROC_HEAD, medRow, procRow } from './format';

export function renderPdf(r: ClinicalRecord): Blob {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  let y = margin;

  const heading = (text: string) => {
    y += 18;
    if (y > doc.internal.pageSize.getHeight() - 80) { doc.addPage(); y = margin; }
    doc.setFont('helvetica', 'bold').setFontSize(12).text(text, margin, y);
    y += 6;
  };
  const para = (text: string, size = 9) => {
    doc.setFont('helvetica', 'normal').setFontSize(size);
    const lines = doc.splitTextToSize(text, width);
    doc.text(lines, margin, y + 10);
    y += 10 + lines.length * size * 1.25;
  };
  const table = (head: string[], body: string[][]) => {
    if (!body.length) return para('None recorded.');
    autoTable(doc, { head: [head], body, startY: y + 4, margin: { left: margin, right: margin }, styles: { fontSize: 8.5, cellPadding: 3 }, headStyles: { fillColor: [30, 41, 59] } });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  };

  doc.setFont('helvetica', 'bold').setFontSize(16).text('Field Record — Medications & Procedures', margin, y);
  y += 6;
  para(`Incident ${r.incidentId} · Version ${r.version}${r.supersedes ? ` (amends ${r.supersedes})` : ''} · Captured ${new Date(r.recordedAt).toLocaleString()} via ${r.source} · ${r.status === 'signed' ? 'SIGNED' : 'DRAFT — NOT SIGNED'}`);

  heading('Medications administered');
  table(MED_HEAD, r.medications.map((m) => medRow(r, m)));
  heading('Procedures performed');
  table(PROC_HEAD, r.procedures.map((p) => procRow(r, p)));
  heading('Verbatim dictation');
  para(r.transcript, 9.5);
  heading(`Review log (${r.edits.length})`);
  table(['When', 'Event', 'Field', 'From', 'To'], r.edits.map((e) => [new Date(e.at).toLocaleTimeString(), e.eventId, e.field, typeof e.from === 'object' && e.from ? '(event)' : String(e.from), String(e.to)]));
  heading('Audit');
  if (r.status === 'signed') {
    para(`Signed by ${r.signedBy} at ${new Date(r.signedAt!).toLocaleString()}`);
    para(`SHA-256: ${r.hash}`, 7.5);
    para(`Previous: ${r.prevHash}`, 7.5);
  } else {
    para('Not signed — this document is not part of the audit chain.');
  }
  para('Times marked "(capture)" were not dictated; the device capture time is shown. Synthetic data only — not for clinical use.', 7.5);
  return doc.output('blob');
}
