# Field-to-Record

Converts a first responder's spoken or typed on-scene notes into a **structured, timestamped record of medications and procedures**, the first link in an audit chain. It runs **entirely in the browser, offline**, as an installable PWA.

```
"Gave 0.3 mg epi IM right thigh at 14:32. Started 18g IV left AC."
        │  Whisper (on-device)      │  rule NER + linking      │  medic review      │  SHA-256 chain
        ▼                           ▼                          ▼                    ▼
   transcript  ──►  DRUG/DOSE/ROUTE/SITE/TIME/PROCEDURE  ──►  events + flags  ──►  signed record
                                                                                    ├─ JSON
                                                                                    ├─ FHIR-lite Bundle
                                                                                    ├─ HTML report
                                                                                    └─ PDF report
```

> Synthetic data only. Contains no real PHI. Not a medical device and not for clinical use.

## Quick start

```bash
npm install
npm run fetch-models          # one-time: Whisper tiny.en (~45 MB) + ONNX runtime into public/  (add "-- base" for base.en)
npm run dev                   # http://localhost:5173
```

Production / offline check:

```bash
npm run build && npm run preview -- --port 4173
npm run e2e                   # headless Chrome: sign, send as SMS frames with one lost + resent, go offline, reload, transcribe a WAV offline
```

In the app: **Prepare for offline** once (loads the model into the cache). After that, airplane mode works.

| Command | What it does |
|---|---|
| `npm test` | Unit tests (normalizer, extractor, Tanglish, linker, audit chain incl. tamper detection, device signatures, framing/loss/CRC, FHIR, HTML/PDF) |
| `npm run eval -- --verbose` | Event-level precision/recall/F1 + per-field accuracy on the gold-labelled synthetic set |
| `npm run asr:node -- data/synthetic/audio/*.wav` | Transcribe WAVs with the same local Whisper files, in Node |
| `npm run eval:asr [-- --verbose]` | Real-speech accuracy: Whisper → speech repairs → extraction on `data/real/<id>.wav`, scored raw vs repaired against `data/real/script.json` |
| `npm run verify-rxnorm` | Check every RxNorm code in the drug lexicon against NLM RxNav (needs network, sends codes only) |

## How it works

| Stage | File | Notes |
|---|---|---|
| Capture | `src/capture/recorder.ts` | MediaRecorder → 16 kHz mono Float32 |
| Hands-free | `src/ui/CaptureCard.tsx` | On by default: Stop → transcribe → speech repairs → extract → spoken read-back that names the items needing checks. No typing. |
| Speech repairs | `src/asr/repair.ts` | Fixes predictable English-model mishearings of Tanglish ("Nala Leader" → "naalu litre", "4 line" → "IV line"). Raw ASR text is kept on the record; any event built from a repaired word is blocked until confirmed. |
| Speech-to-text | `src/asr/asr.worker.ts` | transformers.js + Whisper (q8 ONNX, WASM) in a Web Worker. Model **and** ONNX runtime are self-hosted (`/models`, `/ort`); remote loading is disabled. The browser's Web Speech API is deliberately not used because Chrome sends that audio to a server. |
| Normalize | `src/nlp/normalize.ts` | "three twenty four milligrams" → `324 mg`, unit aliases; keeps a char map back to the verbatim transcript |
| Extract | `src/nlp/extract.ts` | Rule NER in priority order (corrections, procedures, times, doses, drugs, routes, sites), fuzzy/phonetic drug recovery for ASR errors ("on dance a tron" → ondansetron), NegEx-lite negation ("no IV access", "allergic to morphine") |
| Link | `src/nlp/link.ts` | Segments at sentence ends / "then"; attaches dose/route/site/time to events; "scratch that" discards the preceding segment |
| Review policy | `src/nlp/review.ts` | Blocking flags (missing dose/unit/route, unidentified or approximately-matched drug) vs. warnings (no stated time, unusual route) |
| Record + audit | `src/record/*.ts` | Every human edit is logged. Signing hashes the canonical JSON together with the previous record's hash, then signs the hash with a per-device ECDSA P-256 key (non-extractable, kept in IndexedDB). Signed records are read-only; corrections become linked amendments. |
| Offline send | `src/transport/*.ts`, `src/ui/SendPanel.tsx` | Signed record → compact short-key JSON → deflate → ECDSA-signed message → frames of ≤180 B (LoRa/BLE/QR) or ≤110 B (one SMS each). Each frame carries message id, seq n/N and CRC-32. Shown as text + QR codes, copyable or opened in the SMS app. |
| Receive | `src/ui/ReceiveCard.tsx` | Frames in any order; lists missing frames to resend, drops CRC failures, verifies the signature **before** decompressing, shows the device key fingerprint. |
| Read-back | `src/ui/readback.ts` | Speaks the record before signing using an on-device voice only (`localService`); network voices are never used. |
| Tanglish | `src/nlp/normalize.ts`, `extract.ts` | Romanized Tamil numbers (*rendu*, *naalu*), verbs (*kuduthen*, *potten*), routes (*vaai vazhiya*), post-verb negation (*kudukala*, *podala*). "2 ya 5 mg" becomes an unresolved dose that blocks signing. |
| Outputs | `src/record/fhir.ts`, `src/render/*` | FHIR R4-shaped Bundle (MedicationAdministration, Procedure, Provenance), HTML, PDF |
| Storage | `src/store/db.ts` | IndexedDB; drafts auto-save and survive reloads |

**Design rules**
- **Never invent values.** Each field carries the span of transcript text it came from. Missing data stays `null` and gets flagged, never guessed.
- **Two clocks.** `recordedAt` is the device capture time. `administeredAt` is only set from a time the medic actually said. If none was said, outputs fall back to capture time and label it (`timeSource: capture`).
- **Human in the loop.** Nothing is signed until blocking flags are resolved by a person.

## Data

- `data/synthetic/dictations.json`: 32 hand-written EMS dictations with gold labels. They cover number words, dose-before-drug phrasing, multi-drug clauses, corrections, negation, repeat doses and ASR misspellings.
- `data/synthetic/audio/*.wav`: synthetic dictations made with offline OS text-to-speech.
- n2c2 2018 Track 2 and MIMIC-III need credentialed (DUA) access and are not included. `scripts/eval.ts` accepts any file in the same JSON shape.
- Drug lexicon: 45 common EMS drugs. 44 RxNorm codes are verified against RxNav. Lactated Ringer's has no single ingredient code and is left `null`. Procedure and route codes are a local code system, not SNOMED CT.

## Current results

On the synthetic set, **medication events F1 0.975** and **procedure events F1 1.0**, with 90.6% of records fully correct. The remaining errors are all in the dose/route-to-drug linking rule (`chooseDrugsFor` in `src/nlp/link.ts`).

These numbers are optimistic. The rules and the test set were written by the same person, so expect lower scores on real de-identified text.

## Known limitations

- whisper-tiny makes real errors on drug names (heard "epi IM" as "APIM"). The fuzzy matcher recovers some, and the rest surface as blocking review flags. `base.en` is more accurate at about twice the size.
- Rule-based NER only. The plan's phase 2 (a small fine-tuned NER model exported to ONNX and merged with the rules) is not built.
- Device signatures prove **which key** signed, not which person: there is no device enrolment yet, so the receiver shows the key fingerprint for a human to check. Clearing site data creates a new key. The chain is local to one device.
- Tamil support is **romanized text** (typed, or English ASR output). Tamil-script speech recognition is not built. On synthetic Tanglish speech, whisper-tiny.en gets 3/10 test lines fully right (4/10 after repairs); it often hears "IV" as "4". Real-voice numbers: record the test lines in the app ("Record test lines") and run `npm run eval:asr`. Recordings are git-ignored.
- No radio driver: frames are sized for LoRa/SMS, but browsers can't drive a LoRa radio. Hand-off today is copy/paste, the SMS app, or QR.
- iOS Safari may evict cached models after long inactivity. The app shows model readiness.
- `dist/assets` contains a duplicate copy of the ONNX runtime `.wasm` that Vite bundles. The worker loads the `/ort/` copy.
