import { describe, expect, it } from 'vitest';
import { signRecord } from '../src/record/audit';
import { createDraft } from '../src/record/record';
import { renderHtml } from '../src/render/html';
import { renderPdf } from '../src/render/pdf';

const NOW = new Date('2026-10-28T14:40:00Z');

describe('document generation', () => {
  it('escapes dictated text in the HTML report', () => {
    const r = createDraft('Gave <script>alert(1)</script> epi 0.3 mg IM', 'text', 'INC-<b>', NOW);
    const html = renderHtml(r);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('DRAFT — NOT SIGNED');
  });

  it('shows hash and signer once signed, and labels clock-stamped times', async () => {
    const r = await signRecord(createDraft('Morphine 4 mg IV', 'text', 'INC-9', NOW), 'EMT-7', null, NOW);
    const html = renderHtml(r);
    expect(html).toContain(r.hash!);
    expect(html).toContain('EMT-7');
    expect(html).toMatch(/\d\d:\d\d \(at entry\)/);
  });

  it('produces a PDF', async () => {
    const blob = renderPdf(createDraft('Aspirin 324 mg PO at 09:10. 12 lead acquired.', 'text', 'INC-10', NOW));
    const head = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()).slice(0, 5));
    expect(head).toBe('%PDF-');
  });
});
