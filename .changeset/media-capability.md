---
"@pithy-sh/media": minor
---

New package: `@pithy-sh/media` — store, track, and enrich media on the adopter's own Cloudflare account. Images (R2 or Cloudflare Images), video (R2 or Cloudflare Stream), audio and documents (R2). Config picks the backend per type; the package owns direct-upload URL minting, the record model, migrations, routes, and the enrichment Workflows. Bytes never proxy through the Worker. Opt-in AI enrichment writes alt text and captions (LLaVA), transcriptions (Whisper, with HLS batching for video), and extracted document text (toMarkdown) — each model a config parameter. Records live in D1 by default (derived text is queryable) or KV. A media record is adopter-extensible: one Zod `extend` schema becomes real D1 columns or a validated KV value. Duplicate detection via `sha256` and perceptual hash. Every route declares a verification strategy and is auth-gated; runtime throws `media/*` errors.
