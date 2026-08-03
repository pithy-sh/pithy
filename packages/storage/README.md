# @pithy-sh/storage

General file storage in your own R2 bucket, with an owner, a quota, and a link you can take back.

Uploads never proxy through your Worker — the client PUTs straight to a presigned URL, and anything past 100 MiB becomes resumable parts. Downloads deliberately do stream through it, because that is the only way a read can be authorized per request.

It takes no position on what the bytes are. No transcoding, no thumbnails, no AI. That is `@pithy-sh/media`.

## Add it

```
pithy add storage
```

That wires `storage()` into `pithy.config.ts`, adds the manifest bindings, and runs the migrations — creating `pithy_storage_objects` and `pithy_storage_shares`. It touches no Cloudflare account, so it works offline and in CI.

Standing up what those bindings point at is a separate, explicit step:

```
pithy storage provision --r2-access-key-id <id> --r2-secret-access-key <key>
```

`@pithy-sh/secrets` is required — the R2 credentials are read through it, so storage will not compose without it. `@pithy-sh/auth` is optional but strongly implied: ownership scoping reads the caller from the core `AuthContext` seam, and with no auth capability composed `c.var.auth` is null and every owner-scoped route denies. That is the right default and not a useful one.

## Configure

```ts
storage({
  quota: { bytesPerOwner: 5 * 1024 * 1024 * 1024 }, // null (the default) is unlimited
  multipartThresholdBytes: 100 * 1024 * 1024,       // above this, split into parts
  partSizeBytes: 64 * 1024 * 1024,                  // 10,000 parts max, so ~625 GiB per object
  defaultVisibility: "private",
  pendingTtlSeconds: 24 * 60 * 60,
})
```

Every field has a default and a rationale (`.describe()`), surfaced by the CLI. `basePath` (`/storage`) and `sharePath` (`/s`) move the mounts.

Keys are server-derived and opaque. A client supplies a *logical path* — `invoices/2026/q3.pdf` — which is stored, indexed, and listable by prefix, and never becomes an R2 key. The key is `obj/<uuid>`, minted by the server, so a `../` cannot escape a prefix, two clients cannot collide on a name, no client-controlled text is ever interpolated into a key, and a leaked key is not a directory listing. It also sidesteps R2's one-write-per-second-per-key limit by construction: every object gets its own key, so no two writes ever contend for one. The key never appears in a response body either — it is the only thing a presigned URL addresses.

## The ObjectStore seam

`ObjectStore` is the reusable piece, and the constraint that makes it reusable is what it does *not* import: no D1, no routes, no storage config. It is constructed over an injected bucket binding and a *named* credential secret, and it moves bytes.

```ts
import { objectStore } from "@pithy-sh/storage/src/object/store";

const store = objectStore({ bucket: env.MEDIA_BUCKET, env, secretName: "media-r2-credentials" });
```

`@pithy-sh/media` is the consumer it was built for, and it uses it: media's presign paths run through this seam, pointed at `MEDIA_BUCKET` under `media-r2-credentials`, so media builds no `CloudflareR2Manager` and holds no R2 key pair. Its reads and deletes stay on the `R2Bucket` binding directly — the seam is not in that path and does not need to be, since a binding read costs no credential and no round trip. Adding `@pithy-sh/storage` to a project must not mount storage's routes or create `pithy_storage_objects`, and keeping this module free of those imports is what guarantees it: media depends on the package and inherits none of that.

Bindings inside the Worker, S3 outside it. Reads, head, list, and delete go through the `R2Bucket` binding — no credentials, no round trip, a body that streams. Presigned URLs, the multipart lifecycle, and server-side copy have no binding equivalent that keeps bytes out of the Worker, so they go over the S3 protocol. The seam hides which is which.

A second bucket needs its own credential name, and that name must be *declared* — `sharedSecretsStore` refuses a name no capability registered. Use the factory, so every declaration of a name agrees on every axis:

```ts
import { r2CredentialsRegistry } from "@pithy-sh/storage/src/secret/registry";

defineCapability({ secretRegistry: r2CredentialsRegistry("media-r2-credentials"), /* … */ });
```

Key *policy* is not part of the seam. Storage derives `obj/<uuid>`; another capability passes whatever scheme it likes. Neither knows the other's.

## Multipart uploads

A single presigned PUT is capped at 5 GiB and is not resumable — a dropped connection at 4 GiB starts over. So `POST /storage` splits anything above `multipartThresholdBytes` into parts and returns one presigned PUT per part. A lost client re-sends the parts it is missing, not the file. The server holds no transfer state beyond the pending row.

`GET /storage/:id/parts` is the resume. It answers with the parts R2 already holds — number, ETag, size — and a **freshly presigned URL for every part still missing**. That is a route rather than a longer TTL because a presigned URL cannot be revoked: the URLs `POST /storage` handed out are short-lived on purpose, and a client that stalled past their hour asks for new ones. It works only while the row is `pending`; a `stored` upload has nothing left to resume and a `failed` one had its parts discarded.

`POST /storage/:id/complete` takes the part numbers and ETags back, sorts and de-duplicates them (S3 rejects an out-of-order list), refuses a gap before R2 ever sees it, and confirms the stored byte count against R2 before the row is marked `stored`.

**The practical object ceiling is `partSizeBytes × 10,000`** — about 625 GiB at the default 64 MiB. R2 caps a multipart upload at 10,000 parts, so part size is what fixes it. R2's own object cap is 4.995 TiB; raise `partSizeBytes` to reach it. The cost of raising it is that every retry re-sends a bigger part, which is why the default is tuned for the sizes people actually store.

A 40 GiB upload therefore costs your Worker one request and zero bytes of transfer. It presigns 640 part URLs in that one call; not one of them carries a byte through your Worker.

## Serving objects

`GET /storage/:id` is a real request the Worker answers, and that is on purpose. A presigned GET is bearer-equivalent the moment it leaves your process: it cannot be revoked, it cannot be re-checked against a visibility that changed a second ago, and it cannot carry a `Content-Disposition` you chose.

So the serve path handles the HTTP properly:

- **`Range`** → 206 with an exact `Content-Range`. Every form is supported, including the `bytes=-500` suffix. Ranges resolve against the row's recorded size rather than R2's echo, so an unsatisfiable range is a **416** that costs no read.
- **`ETag`** on every response, quoted.
- **`If-None-Match`** → 304 with no body.
- **`Content-Disposition`** with both an ASCII fallback and an RFC 5987 `filename*`, so a UTF-8 filename survives. The server derives it from the logical path; a disposition the uploader stored is never replayed.
- **`Cache-Control`** that differs by visibility — a private object is never cached by a shared cache.

`HEAD /storage/:id` returns the same headers with no body.

### Untrusted bytes, your origin

The bytes are your users'; the origin is yours. A file uploaded by one user is served from the same origin as every other Pithy route and as your own app, and you pick the mount point, so there is no sandbox domain to hide it on. Two things follow, and neither is configurable.

**Every object response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.** Nothing a browser makes of these bytes can load anything, reach anything, or claim your origin.

**An active type is neutralised.** `text/html`, anything ending `+xml` (that is where `image/svg+xml` lives), and script types are served as `application/octet-stream` with `Content-Disposition: attachment` — whatever type was stored, and whatever `?download=` said. SVG is why `attachment` and not CSP alone: an SVG is meant to render inline, and this response's CSP does not travel with it when another page loads it as an `<img>`.

The cost is real and deliberate: this route will not host your own HTML or JavaScript. Workers Assets or a bucket on its own domain is where first-party markup belongs.

A declared `contentType` is a hint, not a constraint. A presigned PUT **cannot sign a content type** — the S3 presigner marks `content-type` unsignable, so a client may send whatever it likes to the URL it was given. `POST /storage/:id/complete` therefore reads the type back from R2 and writes *that* onto the row. Only a completed row is authoritative.

If you would rather have raw throughput than per-request control, `GET /storage/:id/url` hands back a presigned direct URL valid for 300 seconds. Offered, not the default.

## Quotas

`quota.bytesPerOwner` is unlimited by default, and the field is present from day one so turning it on is not a breaking change.

When it is set, the check runs when an upload *starts*, and the sum counts `pending` rows alongside `stored` ones. Counting only completed uploads would make the quota meaningless under concurrency: ten clients each declaring 1 GiB against a 1 GiB limit all read a used total of zero, all pass, and all upload. The `pending` row reserves its bytes the moment it is written, so the second request sees the first's reservation. An upload landing exactly on the limit is allowed — a quota is a ceiling you may reach.

**The sum and the reservation are one statement.** A `SELECT sum(size)` followed by a separate `INSERT` reproduces exactly the race it was meant to close, one round trip later. D1 has no interactive transactions, so the pending row is written with a conditional `INSERT … SELECT … WHERE (SELECT sum(size) …) <= limit - declared`: SQLite evaluates the total while it holds the write lock, and a row that would breach the limit simply does not appear. Ten concurrent inits are serialized by the database, and the tenth sees the other nine.

**The declared size buys a reservation, not a limit.** A part URL carries no signed `Content-Length` — the final part's length differs from every other, so pinning one at mint time would need the total up front and would still leave the last part free. So a client can declare 100 MiB and PUT considerably more across its part URLs. `POST /storage/:id/complete` measures what actually landed and re-asserts the overshoot against the quota; if it does not fit, the assembled object is deleted and the row goes `failed`. Bytes an owner was never granted are not kept.

**The settlement is a conditional `UPDATE`, for the same reason the reservation is a conditional `INSERT`.** Only the overshoot is billed — the row is still `pending`, so the sum already counts what it reserved — and the sum is evaluated inside the update: `UPDATE … SET status = 'stored', size = ? WHERE id = ? AND (SELECT sum(size) …) <= limit - overshoot`. Two completions racing on one owner would otherwise both read a total neither had yet contributed to and both pass, which is the init race reproduced at the other end of the lifecycle. An upload that turns out *smaller* than it declared claims nothing further and is written unconditionally, so lowering a quota under an in-flight upload cannot turn a completion into a deletion.

The reservation is not free: an abandoned upload holds bytes it never stored. That is what `pendingTtlSeconds` and the sweep are for. Over-counting briefly and reclaiming is the right way round; under-counting has no recovery.

## The orphan sweep

A file is two writes — a row in D1 and an object in R2 — and no transaction spans them. Every interruption leaves one behind, in one of two directions. A **row with no object** is an upload that started and never finished, holding a quota reservation forever. An **object no row bills for** is a delete that removed the row and then failed on R2, or an abandoned upload whose presigned URL was used anyway: bytes that are unreachable, billed to nobody, and paid for monthly.

**A row claims a key only while it bills for it.** The sweep's membership test filters on exactly the statuses the quota sums — `pending` and `stored` — so a `failed` row reserves nothing *and* shields nothing. The row survives as the owner's record that an upload was attempted and abandoned; its claim on the bytes does not. Aborting an upload cannot revoke the presigned URL it handed out, so a client may still PUT to it afterwards, and the object that lands is collected as an orphan rather than sheltered forever by a row that counts toward no quota.

A daily Workflow walks both. Two guards keep it away from live data: it only ever considers keys carrying storage's own `obj/` prefix, so a bucket shared with another tool is left alone, and it only touches things older than the TTL, so an object written seconds ago whose row this run has not yet read is a wait rather than a casualty.

It is a cron **and** a dispatch target, because a sweep nobody can run on demand cannot be tested in staging — which is exactly when you want to know what it does:

```ts
await c.var.workflows.trigger("storage/sweep", { dryRun: true, olderThanSeconds: 60 });
```

The Workflow binding is `STORAGE_SWEEP` and it is **optional**: an unprovisioned project still serves every upload and download route.

`pithy add storage` does not write that binding into `wrangler.jsonc`; `pithy storage provision` does. Wrangler requires a `name` and a `class_name` on every `workflows` entry, and the deployed Workflow name is per project and per environment (`<project>-<env>-storage-sweep`) — a value `add` cannot know, and an entry missing it stops wrangler loading the config at all. So the binding lands once the sweep worker exists, complete, in each environment's stanza.

## Share links

A presigned URL cannot be revoked, only expired. "Share this file, and let me take it back" is impossible to build on presigning alone.

So a share is a row. `POST /storage/:id/shares` mints a 256-bit token, `GET /s/<token>` looks it up on every fetch, and `DELETE /storage/shares/<token>` is a write that takes effect on the next request. A withdrawn link answers `storage/share_revoked`; one that simply aged out answers `storage/share_expired`. Two codes, because one is worth asking about and the other is worth re-requesting. Revocation is checked first — a link that was taken back should say so even after it would also have expired.

Shares are read-only, and a share TTL is capped at a year.

## Commands

```
pithy storage provision [--api-token <token>] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--json]
pithy storage deprovision [--storage] [--r2-access-key-id <id>] [--r2-secret-access-key <key>] [--json]
```

`provision` is idempotent and safe to re-run. For staging and prod it creates the R2 bucket (`<project>-<env>-storage`), writes the `storage-r2-credentials` secret, deploys the prebuilt sweep worker (`<project>-<env>-storage`) with its cron, and writes the `STORAGE_SWEEP` binding into that environment's `wrangler.jsonc` stanza. Buckets come first across both environments, then credentials, then workers — a sweep worker must never boot before the secret it reads. `pithy secrets provision` must have run first: that is where the secret lands.

`<project>` is the `name` in your root `pithy.config.ts`. R2's namespace is flat and account-wide, and provisioning finds a bucket by name and reuses it, so without that segment a second project in the same account would adopt this one's bucket — two apps writing objects into one place, and either teardown deleting both. See [`docs/NAMING.md`](../../docs/NAMING.md).

**You supply the R2 S3 access-key pair.** Cloudflare exposes no API for minting one, so nothing here can create it for you. Make the pair under **R2 → Manage API tokens**, then pass the flags above or set `R2_CREDENTIALS` in `.dev.vars`:

```
R2_CREDENTIALS={"accessKeyId":"…","secretAccessKey":"…"}
```

`--api-token` is the Cloudflare API token stored alongside the pair, defaulting to `CLOUDFLARE_API_TOKEN` from `.dev.vars` — that default is your broad bootstrap token, so supply an R2-scoped one for prod.

`deprovision` removes the sweep workers and leaves your files alone. `--storage` also deletes the buckets, and every stored file with them: it aborts any multipart upload still in flight, drains every key, then deletes the bucket. R2 refuses to delete a bucket that is not empty, and emptying one is an S3-protocol operation, so `--storage` needs the same key pair `provision` did — the flags above, or `R2_CREDENTIALS`. It is resolved before anything is deleted, so a missing pair costs you nothing.

Both take `--json`, prompt for nothing, and are fully flag-driveable — an agent and a human drive the same command.

## Routes

| Route | Purpose | Verification |
| --- | --- | --- |
| `POST /storage` | Start an upload; returns one PUT URL or the part URLs | bearer · session |
| `GET /storage` | List your files by path prefix, cursor-paginated | bearer · session, owner |
| `DELETE /storage/shares/:token` | Revoke a share | bearer · session, owner |
| `POST /storage/:id/complete` | Finalize, confirming the bytes against R2 | bearer · session, owner |
| `POST /storage/:id/abort` | Abandon an upload and drop its parts | bearer · session, owner |
| `GET /storage/:id/parts` | Resume: stored parts, plus a fresh URL per missing one | bearer · session, owner |
| `POST /storage/:id/copy` | Server-side copy | bearer · session, owner |
| `POST /storage/:id/shares` | Mint a revocable share link | bearer · session, owner |
| `GET /storage/:id/url` | A presigned direct URL, valid 300 s | bearer · session, owner or public |
| `GET /storage/:id` | Stream the bytes | public when `visibility: 'public'`, else bearer · session + owner |
| `HEAD /storage/:id` | Metadata only | bearer · session, owner |
| `PATCH /storage/:id` | Rename, or change visibility | bearer · session, owner |
| `DELETE /storage/:id` | Delete the file and its row | bearer · session, owner |
| `GET /s/:token` | Fetch via a share link | public — the token is the credential |

`GET /storage/:id` is the one route with two strategies, so it is deliberately not wrapped in the auth guard: the guard would deny before the handler could see that the object is public. Authorization happens inside the handler against `c.var.auth`, which is null with no auth capability composed — so a private object is denied by default and only an explicitly public one is served.

A private file you do not own reads as **missing**, not as forbidden. A 403 would confirm the id exists, which is the oracle an enumeration attack wants. A *public* file you do not own is honestly forbidden, since its existence is already public.

A copy is always private, even when the source was public. Republishing is a decision.

## Errors

Runtime code throws `PithyError` with `storage/*` codes. Internal detail never reaches a client.

| Code | Status | Meaning |
| --- | --- | --- |
| `storage/not_found` | 404 | No such object, or one you may not see. |
| `storage/forbidden` | 403 | A public object you do not own. |
| `storage/quota_exceeded` | 413 | The upload would put the owner over their byte limit. |
| `storage/upload_incomplete` | 409 | The object is still `pending` — the upload never finished. |
| `storage/multipart_failed` | 500 | The part plan or the reported part list cannot be completed. |
| `storage/share_expired` | 410 | The share token is past its expiry. |
| `storage/share_revoked` | 410 | The share token was withdrawn. |

## Testing

Storage is tested in three places, and the split is not arbitrary — each one can prove something the other two cannot.

`bun run test` runs both default projects. The **node** project covers the pure logic: part plans, key policy, cursors, config. The **workers** project runs under Miniflare with a real D1 and a real R2 *binding*, which is where the migration's `up`/`down`, the CHECK constraints, the quota's conditional insert, and every binding-backed read are proved.

`bun run test:integration` runs against a **live** Cloudflare account. It exists because Miniflare emulates the R2 binding and serves no S3 endpoint — so a *presigned* URL has nothing to address there, and the transfer path the whole design rests on (bytes going client-to-R2, never through the Worker) is untested until it runs for real. The live suite creates a throwaway bucket per test, PUTs real bytes to real presigned URLs, moves a genuine ≥ 5 MiB multipart upload, and reconciles the orphan sweep against a real bucket and a real D1. The inverse of the emulator's blind spot is its own: an `R2Bucket` only exists inside workerd, so the live suite serves `head`/`list`/`delete` over S3 and leaves `get` throwing. Neither suite can quietly take the other's path and pass.

```sh
bun run vars:local        # symlink ../../.dev.vars -> .dev.vars (git-ignored)
bun run test:integration  # creates and deletes real R2 buckets and D1 databases
```

It needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and the R2 S3 key pair as `R2_CREDENTIALS={"accessKeyId":"…","secretAccessKey":"…"}`; it skips cleanly without them. Point it at a dedicated test account.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
