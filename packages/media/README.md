# @pithy-sh/media

Store, track, and enrich media on your own Cloudflare account. Images, video, audio, documents. Config picks the backend; the package does the rest.

You pick a storage backend per media type and toggle AI enrichment. The package owns everything else: direct-upload URL minting, the record model, migrations, routes, and the enrichment Workflows. Bytes never proxy through your Worker — the client uploads straight to Cloudflare.

## Add it

```
pithy add media
```

That wires `media()` into `pithy.config.ts`, adds the manifest bindings, and runs the migrations. Then run `pithy media provision` to mint the scoped credentials, create the bucket, and deploy the enrichment worker. See the scaffold steps `pithy add media` prints.

## Configure it

```ts
media({
  // Where records live. `d1` (default) keeps transcriptions and extracted text queryable.
  // `kv` is a key-lookup-only opt-in for KV-only projects — see "KV record store" below.
  recordStore: "d1",
  images: { store: "cf-images", imageToText: true },   // or store: "r2"
  video: { store: "cf-stream", transcribe: true },      // or store: "r2"
  audio: { transcribe: true },                          // always R2
  documents: { extractText: true },                     // always R2
})
```

Every field has a default and a rationale (`.describe()`), surfaced by the CLI. Each AI feature is independently opt-in and a no-op — no dispatch, no cost — when off.

## Storage backends

Chosen per type, in config.

| Type      | Backends            | Default      | Upload mechanism                    |
| --------- | ------------------- | ------------ | ----------------------------------- |
| Image     | R2 · Cloudflare Images | `cf-images` | Images direct-upload URL, or R2 presigned PUT |
| Video     | R2 · Cloudflare Stream | `cf-stream` | Stream direct-upload URL, or R2 presigned PUT |
| Audio     | R2                  | `r2`         | R2 presigned PUT                    |
| Document  | R2                  | `r2`         | R2 presigned PUT                    |

Cloudflare Images gives you variants and optimized delivery. R2 gives you raw ownership of the bytes. Cloudflare Stream gives you encoding and adaptive HLS delivery. Every direct-upload URL is minted through `@pithy-sh/cloudflare`.

## AI enrichment

Opt in per type. Each runs as a Cloudflare Workflow with retries, triggered on finalize, and writes its result back to the record. Every model is a config parameter with a default — override it to swap models with no code change.

| Feature          | Types         | Default model                          | Writes to                          |
| ---------------- | ------------- | -------------------------------------- | ---------------------------------- |
| Image → text     | image         | `@cf/llava-hf/llava-1.5-7b-hf`         | `altText`, `caption`               |
| Speech → text    | audio, video  | `@cf/openai/whisper-large-v3-turbo`    | `transcription`, `hasTranscription` |
| Document → text  | document      | `env.AI.toMarkdown` (pdf/doc/docx)     | `extractedText`, `hasExtractedText` |

Audio is transcribed in one call. Video is transcribed from its Cloudflare Stream HLS audio rendition, batched into ~30-second overlapping groups (whisper has a per-call input limit) and stitched back with overlap-dedup.

## The record

One `pithy_media_assets` table (or one KV value per record) holds every media type, discriminated by `type`. Base fields are guaranteed; per-type derived fields are filled by enrichment.

Duplicate detection is built in: `sha256` (exact, all types) and a perceptual hash (`phash`, near-duplicate images). Both are computed client-side and supplied on upload — the bytes never reach your Worker. `POST /media/duplicates` returns exact and near matches.

## Extending a record

Add your own fields — an owning `userId`, a tenant id, tags — by passing a Zod object:

```ts
media({
  extend: z.object({
    userId: z.string().describe("The owning user."),
    tags: sqliteJson(z.array(z.string())).describe("Free-form tags."),
  }),
})
```

From that one schema the mapping layer does the rest. In D1 the fields become real columns (a generated migration adds them) and are queryable. In KV they become part of the validated value. Either way they round-trip through create, get, and list with no backend-specific work. Base fields are never redefined.

## Routes

Every route declares a verification strategy and is gated by auth — there is no public media surface. Add `@pithy-sh/auth` so `c.var.auth` is populated; without it every route is denied.

| Route                       | Verification    | Purpose                                  |
| --------------------------- | --------------- | ---------------------------------------- |
| `POST /media`               | bearer · session | Upload-init: mint a URL, create a record |
| `POST /media/:id/finalize`  | bearer · session | Mark stored, dispatch enrichment         |
| `GET /media/:id`            | bearer · session | Fetch one record                         |
| `GET /media`                | bearer · session | List records                             |
| `DELETE /media/:id`         | bearer · session | Delete a record and its object           |
| `POST /media/duplicates`    | bearer · session | Find exact and near duplicates           |

Ownership scoping — filtering to the caller's own media — is an adopter concern. Add a `userId` extension field and filter your queries by it.

## KV record store

`recordStore: 'kv'` is an opt-in for KV-only projects. It works, with one caveat: KV is a key-value store, not a query engine. `get`, `patch`, and `delete` are direct key lookups, but `list`, `findBySha256`, and `listImagePhashes` scan the namespace. That is fine for modest media sets. Text search over transcriptions and extracted text effectively requires D1 — which is why D1 is the default.

## Errors

Runtime code throws `PithyError` with `media/*` codes: `media/not_found` (404), `media/unsupported` (400), `media/storage_failed` (502), `media/enrichment_failed` (500). Internal detail never reaches a client.
