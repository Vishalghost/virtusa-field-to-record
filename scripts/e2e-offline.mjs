// End-to-end check of the built PWA in headless Chromium via the DevTools protocol:
//   1. typed dictation -> extract -> sign -> verify chain
//   2. "Prepare for offline" (loads Whisper into the cache)
//   3. cut the network, reload: app must still load from the service worker
//   4. transcribe a WAV fully offline
// Usage: npm run build && npm run preview -- --port 4173, then
//        node scripts/e2e-offline.mjs [browserPath]

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BROWSER = process.argv[2] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:4173/';
const WAV = resolve('data/synthetic/audio/syn-024.wav');
const WAV_NO_TIME = resolve('data/synthetic/audio/syn-notime.wav');
const PORT = 9333;

const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ftr-'))}`, '--no-first-run', '--use-fake-ui-for-media-stream', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, label, timeout = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expression).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${label}`);
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// DOM helpers injected into the page
const helpers = `
  window.$btn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));
  window.$type = (el, v) => { const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: APP });
  await waitFor(`navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true)`, 'service worker');
  await send('Page.reload'); // so the SW controls the page
  await waitFor(`!!navigator.serviceWorker.controller && !!document.querySelector('textarea')`, 'controlled page');
  await evaluate(helpers);

  // 1. typed dictation -> review -> sign
  await evaluate(`$type(document.querySelector('textarea'), 'Gave 0.3 mg epi IM right thigh at 14:32. Started 18g IV left AC at 14:35.'); true`);
  await evaluate(`$btn('Extract record').click(); true`);
  await waitFor(`document.querySelectorAll('tbody tr').length >= 2`, 'review table');
  const row = await evaluate(`[...document.querySelector('tbody tr').querySelectorAll('select,input')].map((e) => e.value).join('|')`);
  check('extracts epinephrine row', row.startsWith('epinephrine|0.3|mg|IM|right thigh|14:32'), row);
  await evaluate(`$type(document.querySelector('input[placeholder="Your provider ID"]'), 'EMT-0042'); true`);
  await waitFor(`!$btn('Sign & lock').disabled`, 'sign enabled');
  await evaluate(`$btn('Sign & lock').click(); true`);
  await waitFor(`document.querySelectorAll('.records li').length === 1`, 'signed record listed');
  await evaluate(`$btn('Verify audit chain').click(); true`);
  await waitFor(`document.querySelector('.ok-text')?.textContent.includes('Chain intact')`, 'chain verified');
  check('sign + verify audit chain', true);
  const signedNote = await evaluate(`document.querySelector('.records li .hint').textContent`);
  check('record is ECDSA device-signed', signedNote.includes('ECDSA device-signed'), signedNote.trim());

  // 1b. send as SMS frames, lose one in transit, then resend it
  await evaluate(`[...document.querySelectorAll('.records button')].find((b) => b.textContent === 'Send').click(); true`);
  await waitFor(`document.querySelectorAll('.frames li img').length > 0`, 'frames + QR built');
  await evaluate(`const s = document.querySelector('.send select'); s.value = 'sms'; s.dispatchEvent(new Event('change', { bubbles: true })); true`);
  await waitFor(`document.querySelectorAll('.frames li').length > 1 && [...document.querySelectorAll('.frame-text')].every((c) => c.textContent.length <= 160)`, 'SMS-sized frames');
  const nFrames = await evaluate(`document.querySelectorAll('.frames li').length`);
  await evaluate(`document.querySelectorAll('.frames li input[type=checkbox]')[1].click(); true`);
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.startsWith('Deliver ${nFrames - 1}'))`, 'deliver button');
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Deliver')).click(); true`);
  await waitFor(`document.body.textContent.includes('missing frame 2')`, 'missing frame reported');
  check('receiver reports the lost frame', true, `${nFrames} SMS frames, frame 2 dropped`);
  await evaluate(`document.querySelectorAll('.frames li input[type=checkbox]')[1].click(); true`);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Deliver')).click(); true`);
  await waitFor(`document.body.textContent.includes('Signature valid')`, 'reassembled + verified');
  const recv = await evaluate(`document.querySelector('.received tbody tr').textContent`);
  check('resend completes; signature verifies; record readable', /epinephrine/.test(recv) && /0\.3 mg/.test(recv), recv);

  // 2. prepare offline
  await evaluate(`$btn('Prepare for offline').click(); true`);
  await waitFor(`document.body.textContent.includes('Speech model ready')`, 'model ready', 180000);
  check('speech model prepared', true);

  // 3. offline reload
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.reload');
  await waitFor(`!!document.querySelector('textarea') && document.body.textContent.includes('Offline')`, 'app loads offline');
  await evaluate(helpers);
  const kept = await evaluate(`document.querySelectorAll('.records li').length`);
  check('app shell loads with network off', true);
  check('signed record persisted (IndexedDB)', kept === 1, `${kept} record(s)`);

  // 4. offline, hands-free: audio in -> transcribed -> extracted into review, no typing
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [WAV] });
  await waitFor(`!!document.querySelector('blockquote.transcript') || document.querySelector('.status')?.textContent.startsWith('Transcription failed')`, 'offline hands-free transcription', 180000);
  const transcript = await evaluate(`document.querySelector('blockquote.transcript')?.textContent ?? document.querySelector('.status').textContent`);
  const drugs = await evaluate(`[...document.querySelectorAll('tbody tr select')].filter((s, i) => i % 3 === 0).map((s) => s.value).join(',')`);
  check('offline hands-free: speech -> review, no typing', /aspirin/i.test(transcript) && drugs.includes('aspirin'), `"${transcript}" -> ${drugs}`);

  // 5. no time said: every item gets the device clock time, labelled, without typing
  await evaluate(`$btn('Discard draft').click(); true`);
  await waitFor(`!!document.querySelector('input[type=file]')`, 'capture card back');
  const before = Date.now();
  const doc2 = await send('DOM.getDocument');
  const file2 = await send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId: file2.nodeId, files: [WAV_NO_TIME] });
  await waitFor(`!!document.querySelector('blockquote.transcript')`, 'no-time dictation in review', 180000);
  const times = await evaluate(`[...document.querySelectorAll('tbody input[type=time]')].map((i) => i.value + ' ' + (i.nextElementSibling?.textContent ?? ''))`);
  const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
  const okClock = times.length >= 2 && times.every((t) => t.endsWith('auto (clock)') && t.slice(0, 5) >= hhmm(before - 60000) && t.slice(0, 5) <= hhmm(Date.now()));
  check('times filled from device clock, labelled auto', okClock, times.join(' | '));
} catch (e) {
  check('e2e run', false, e.message);
} finally {
  ws.close();
  proc.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
