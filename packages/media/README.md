# @pithy-sh/media

Store, track, and enrich media on your own Cloudflare account. Images, video, audio, documents. Config picks the backend; the package does the rest.

You pick a storage backend per media type and toggle AI enrichment. The package owns everything else: direct-upload URL minting, the record model, migrations, routes, and the enrichment Workflows. Bytes never proxy through your Worker — the client uploads straight to Cloudflare.

## Add it

```
pithy add media
```

That wires `media()` into `pithy.config.ts`, adds the manifest bindings, and runs the migrations. See the scaffold steps `pithy add media` prints.

## Provision it

```
pithy media provision --r2-access-key-id <id> --r2-secret-access-key <key>
```

One command, idempotent, safe to re-run. It creates the R2 bucket (and the `MEDIA` KV namespace when `recordStore: 'kv'`), writes two secrets for staging and prod, and deploys the media enrichment worker — the prebuilt worker hosting the four Workflows — for each environment. `--json` prints one machine-readable line, so CI and agents drive the same command a human does.

Two secrets, because two owners. `media-storage-credentials` is media's own: the API token it mints Cloudflare Images and Stream direct-upload URLs with. `media-r2-credentials` is `@pithy-sh/storage`'s R2 bundle — the key pair and that environment's bucket — read by the `ObjectStore` seam media presigns through. Media declares the name and never handles the key pair. Both are per environment, because the bucket is.

**You create both credentials.** Cloudflare has no API for minting an R2 S3 access-key pair, so make one under R2 → Manage API tokens and pass it with the flags above, or set `R2_CREDENTIALS` in `.dev.vars`. The Images + Stream token comes from `--api-token` and the token carried alongside the R2 pair from `--r2-api-token`, both defaulting to `CLOUDFLARE_API_TOKEN` — that default is your broad bootstrap token, so supply scoped ones for prod. Pithy stores and rotates them through `@pithy-sh/secrets`; it does not mint them.

`pithy secrets provision` must have run first — that is where the secrets land. Teardown is `pithy media deprovision`, which removes the workers and leaves your stored media alone unless you pass `--storage`. With `--storage` the bucket goes too, and everything in it: any in-flight multipart upload is aborted, every key drained, then the bucket deleted. R2 refuses to delete a bucket that is not empty, and emptying one is an S3-protocol operation, so `--storage` needs the same key pair `provision` did — `--r2-access-key-id` and `--r2-secret-access-key`, or `R2_CREDENTIALS`.

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

Cloudflare Images gives you variants and optimized delivery. R2 gives you raw ownership of the bytes. Cloudflare Stream gives you encoding and adaptive HLS delivery. Images and Stream URLs are minted through `@pithy-sh/cloudflare`; R2 presigned PUTs and GETs come from `@pithy-sh/storage`'s `ObjectStore`, pointed at `MEDIA_BUCKET` under media's own credential name. Reading and deleting an R2 object still goes through the bucket binding directly — no credential, no round trip.

### Who owns an asset

Every resource Pithy provisions is named `<project>-<env>-<thing>` so two projects in one Cloudflare account never adopt each other's ([`docs/NAMING.md`](../../docs/NAMING.md)). Media owns the longest of those names: `<project>-<env>-media-audio-transcribe`. A Workflow name stops at 64 characters and this capability's `<capability>-<job>` tail spends 22 of them, which is the term that makes the Workflow half of the project-name derivation come out at 33 — the looser of the two halves, so it is a feature branch rather than this Workflow that finally caps a project at 25. Cloudflare Images and Stream are the exception to the rule entirely: their stores are just as account-flat, but an asset is keyed by a **Cloudflare-minted id**, not a name you choose. There is nothing to scope.

So media stamps ownership into the metadata instead. Every image and every video it creates carries two reserved keys — the same two for both stores, so one query spans them:

| Key            | Value                             |
| -------------- | --------------------------------- |
| `pithyProject` | The root `pithy.config.ts` `name` |
| `pithyEnv`     | `dev` · `staging` · `prod`        |

That is what lets you list one app's assets, sweep them at teardown, and tell whose is whose in a shared account. Your own metadata on `POST /media` rides along untouched — but the two reserved keys are merged last, so a client cannot claim another project's assets by sending them.

The value comes from the `PROJECT` var, stamped into the Worker at provision beside `ENVIRONMENT`. A Worker without it **refuses to mint** rather than writing an asset nobody can attribute. Images and Stream have no local emulation, so this holds in `pithy dev` too: a local upload lands in the same account-wide store prod shares.

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

## Duplicate detection always uses D1

`sha256` (exact, all types) and a perceptual hash (`phash`, near-duplicate images) are computed client-side and supplied on upload — the bytes never reach your Worker. `POST /media/duplicates` returns exact and near matches, written on finalize.

Dedup is a query workload — an exact `sha256` lookup and a bounded near-`phash` scan — that KV cannot serve. So the hashes always live in a dedicated D1 table, `pithy_media_hashes`, independent of where records live. **This means the `DB` binding is required even when `recordStore: 'kv'`** — a KV-only project still gets a small D1 database for the hash table. It is the only way `phash` near-duplicate detection can work.

## Document text extraction

Extraction runs only for the file types Workers AI `toMarkdown` supports — **pdf, doc, docx**. A `.txt`, image, or unknown extension is never enqueued (no wasted Workflow, no cost). Enable it with `documents.extractText`.

## Consumer URLs

Turn a stored record into a URL your clients load. The URL differs by backend, so the package exposes builders (`@pithy-sh/media/src/deliver/url`) plus a `mediaUrl(record, delivery)` dispatcher. Set the public identifiers in the `delivery` config:

```ts
media({
  delivery: {
    imagesAccountHash: "<your Cloudflare Images account hash>",   // imagedelivery.net URLs
    streamCustomerCode: "<your Cloudflare Stream customer code>", // customer-<code>.cloudflarestream.com
    r2PublicBaseUrl: "https://cdn.example.com",                   // optional, if the bucket is public
  },
})
```

- **Cloudflare Images** → `buildImageUrl(imageId, hash, variant)` (variants like `public`, `thumbnail`).
- **Cloudflare Stream** → `buildStreamHlsUrl` / `buildStreamDashUrl` / `buildStreamThumbnailUrl` / `buildStreamIframeUrl`.
- **R2** → a public base-URL join when `r2PublicBaseUrl` is set, otherwise `storage.presignedDownloadUrl(record)` for a private, time-limited GET.

## Resumable uploads

Video uploads to Cloudflare Stream are resumable — the direct-upload URL is a TUS endpoint, so a TUS client picks up where a dropped connection left off. Cloudflare Images has no resumable protocol (it is a single one-time direct-upload POST); R2 presigned PUTs are likewise a single request. So resumability applies to large video, which is where it matters.

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

`recordStore: 'kv'` keeps records in KV. `get`, `patch`, and `delete` are direct key lookups. `list` is made scalable by **KV metadata**: the fields you name in `kvMetadata` are stored as each entry's metadata, which rides free on a KV `list` — so `list` filters by type, sorts by recency, and paginates from metadata alone, then reads only the returned page's values (bounded by the page size, not the corpus).

```ts
media({
  recordStore: "kv",
  // Fields your list views need, rendered from metadata with no per-value read.
  // `type` and `createdAt` are always included; keep the set small (KV caps metadata at 1024 bytes).
  kvMetadata: ["status", "hasTranscription", "hasExtractedText", "userId"],
})
```

Put an owning `userId` (or a tenant id, tags) here to render owner-scoped list views cheaply. Two caveats remain: text search over transcriptions and extracted text effectively requires D1, and **duplicate detection always uses D1** (see above) — so a KV project still needs the `DB` binding. That is why D1 is the default record store.

## Errors

Runtime code throws `PithyError` with `media/*` codes: `media/not_found` (404), `media/unsupported` (400), `media/storage_failed` (502), `media/enrichment_failed` (500). Internal detail never reaches a client.
