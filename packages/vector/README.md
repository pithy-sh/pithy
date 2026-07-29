# @pithy-sh/vector

Semantic search over your own content, in your own Cloudflare account. Workers AI embeds, Vectorize indexes, D1 keeps the text.

The interesting part of this package is not the search. It is the metadata, which Vectorize makes a provisioning-time decision wearing the costume of a query-time one — and gives you no error when you get it wrong.

## Add it

```
pithy add vector                     # installs, writes the config and the bindings, runs the migration
pithy vector provision --env dev     # creates the index, its metadata indexes, and the reprocess worker
```

`add` touches no Cloudflare account: it installs the package, writes the `vector({ ... })` block into `pithy.config.ts`, wires the `AI` and `DB` bindings into `wrangler.jsonc`, and runs the migration that creates `pithy_vector_documents`. `provision` is the step that needs credentials. They are separate on purpose — adding a capability should work offline and in CI.

The `VECTORIZE` and `VECTOR_REPROCESS` bindings arrive with `provision`, not with `add`, and that is deliberate. Wrangler requires an `index_name` on every `vectorize` entry and a `name` plus `class_name` on every `workflows` entry; both values are provisioning outputs (`pithy-vector-<index>-<env>`, `pithy-vector-reprocess-<env>`). An entry short of either field does not degrade — wrangler refuses to load the config at all. So `add` writes neither, and `provision` writes each complete, per environment.

Every other environment is `pithy migrate --env <env>` then `pithy vector provision --env <env>`.

Both the Vectorize and Workers AI bindings are written `remote: true`, because Cloudflare ships no local emulation for either. `dev` is a real remote index here, not a Miniflare one.

Add `@pithy-sh/auth` too. Every route is auth-gated, and `dependsOn` is empty on purpose: without an auth capability composed, the routes deny rather than open.

## Configure

```ts
import { filterable, vector } from "@pithy-sh/vector";
import { z } from "zod";

const DocMeta = z.object({
  tenantId: filterable(z.string().describe("The tenant this document belongs to.")),
  published: filterable(z.boolean().describe("Whether the document is visible to readers.")),
  title: z.string().describe("The document title, carried for hydration — not filterable."),
});

export default {
  capabilities: [
    vector({
      defaultTopK: 10,
      indexes: {
        docs: {
          model: "@cf/baai/bge-base-en-v1.5", // pinned; used for writes and queries alike
          dimensions: 768,                    // must match the model's output; fixed at creation
          metric: "cosine",                   // fixed at creation
          metadata: DocMeta,
        },
      },
    }),
  ],
};
```

`dimensions` and `metric` are fixed when Vectorize creates the index and cannot be changed afterwards, so they are validated at config parse — where the fix is an edit rather than a rebuild.

One Vectorize binding addresses exactly one index. A project with two indexes gives the second its own `binding`; leaving both on the default `VECTORIZE` would land every write to one index in the other's vectors, with nothing to indicate it. Two indexes naming the same binding is a config-parse error.

## Metadata indexes

Cloudflare states it verbatim: *"Vectors upserted before a metadata index was created won't have their metadata contained in that index."*

Filtering on a field you indexed late does not error. It returns a short, plausible result set, because every vector written before the index existed simply fails to match. Nothing in the response says so. The bug surfaces weeks later as "search feels wrong", and the only repair is to re-embed the corpus, because Cloudflare offers no backfill.

Now add the second half: ten metadata indexes per index, hard. So which fields are filterable is a decision you make before you ingest, and it is expensive to revisit. A thin wrapper over the binding cannot remove that footgun. A schema can.

So an index declares its metadata in Zod, with the filterable fields marked. That one declaration drives five things that cannot then disagree:

- the metadata indexes `pithy vector provision` creates,
- the type of the filter builder,
- the runtime guard that refuses a filter on an unmarked field,
- the reconciliation `provision` runs against the live index, which reports a mis-typed index as fatal and names any live index the config does not declare (it still costs a slot),
- the check the Worker runs at boot, which refuses to serve when the config declares a filterable field that provisioning never created.

`filterable(...)` sets `.meta({ filterable: true })` — the marker provisioning and the filter builder both read — and brands the field's type. A bare `.meta({ filterable: true })` still provisions and still filters; only the compile-time narrowing is lost. An eleventh filterable field, or one whose type Vectorize cannot index, fails at config parse rather than at provisioning time, where the first ten indexes would already exist and the eleventh would be silently absent from every filter naming it.

### The boot check

Mark a field filterable, deploy, forget to re-run `provision`, and every query filtering on it returns a short result set for the rest of the corpus's life. That is the failure this package exists to prevent, and config parse cannot see it — the config is perfectly valid, it is Cloudflare that is behind.

So the Worker checks. Not by calling Cloudflare: reading an index's metadata indexes is a control-plane call authorized only by an account API token, and putting one on the request path of every search is a worse trade than the bug it catches. Instead `pithy vector provision` — which already holds the token and already does the live comparison — **writes down what it observed** into the app's `wrangler.jsonc` as a `VECTOR_PROVISIONED` var, per environment. The Worker compares its declarations against that record, offline, and throws `vector/metadata_index_drift` naming the field and the command.

Be precise about what that proves. It proves the config declares nothing provisioning did not see **the last time it ran**. It is not a live reading: delete a metadata index from the dashboard and the record goes stale and the check stays quiet. What it catches is the case that actually happens, because the record only ever changes when `provision` runs.

Three details, each deliberate:

- **No record at all fails, but only if something is declared filterable.** Nothing filterable means nothing can drift, so a project that added vector and has not provisioned yet still boots and serves its other routes. Declaring filterable fields with no record means provisioning has provably never run, so the index does not exist either and every filtered search is already wrong — booting it would serve exactly the silently-partial results the check is for.
- **A provisioned index the config does not declare is not fatal.** It may predate the config or belong to another consumer of the same index. It costs one of the ten slots, and `provision` reports it; refusing to boot over a leftover would be hostile.
- **It runs on the first request, not at module load.** In Workers there is no `env` until a request arrives, so a var cannot be read any earlier — the same reason core validates bindings there. `GET /health` answers before it, so an orchestrator's probe still gets a response and the failure lands on real traffic, where a human is reading the error.

## Typed filters

```ts
import { vectorFilter } from "@pithy-sh/vector";

vectorFilter(DocMeta, { tenantId: "acme", published: true });          // fine
vectorFilter(DocMeta, { tenantId: { $in: ["acme", "globex"] } });      // fine
vectorFilter(DocMeta, { title: "anything" });                          // compile error
```

The operators are Vectorize's own: `$eq`, `$ne`, `$in`, `$nin`, `$lt`, `$lte`, `$gt`, `$gte`. A bare value is `$eq`.

The runtime guard behind the type is `vector/unfilterable_field`, for callers arriving through an untyped boundary — an HTTP body, a job payload, JavaScript. It is a refusal, not a warning: a filter that quietly runs without the field it names is the exact failure this package exists to prevent.

Filter size is checked before the call too. Vectorize caps a filter's compact JSON at under 2,048 bytes and rejects a larger one with an error that names neither the limit nor the filter.

## Embedding

The embedding model is pinned per index, in config, and applied to **writes and queries alike**.

That is the one rule worth stating twice, because breaking it does not fail. An index built with one model and queried with another returns neighbours from a space the query vector does not live in — real scores, ranked confidently, quietly wrong. There is no error to catch and no metric that moves. So the model is not a per-call parameter here; it is a property of the index, and both paths read the same one.

A model whose output does not match the index's `dimensions` fails on the first write or query with `vector/dimension_mismatch`, naming both numbers.

Batches are embedded 100 texts at a time. That is a deliberate chunk size, not a published limit: one call carrying a thousand documents is a large, slow, all-or-nothing request where a single timeout discards every embedding in it. Chunking costs a few round trips and makes a failure lose a hundred documents instead of a thousand.

Changed the model? Edit config, then run `pithy vector reprocess`. It re-embeds exactly the rows whose stored `model` differs from the configured one.

## Commands

```
pithy vector provision  --env <env> [--json]
pithy vector reprocess  --env <env> [--index <name>] [--all] [--filter '<json>'] [--json]
pithy vector reset      --env <env> --confirm-reset "yes, i really want to reset <env>" [--json]
```

Every command defaults to `--env dev`, takes no required argument, prompts for nothing under `--json`, and prints one JSON line to stdout when it is set. All three are idempotent and safe to re-run.

### provision

```
pithy vector provision --env staging --json
```

Creates each configured index, then every metadata index its schema declares, then deploys the prebuilt reprocess worker — in that order, and never out of it. A vector written between the first two steps is permanently invisible to a filter on that field.

It waits for each accepted metadata index to become visible before returning. Vectorize applies them asynchronously, so "accepted" is not "live", and returning early would put the very next step — deploying the worker that writes vectors — inside that window.

An existing index with different `dimensions` or `metric` is refused, because that shape is fixed at creation. A metadata index that exists with a different type is refused for the same reason. A live metadata index the config does not declare is reported, not deleted: it may predate the config or belong to another consumer, and it still spends one of the ten slots.

On success it writes what it observed into `wrangler.jsonc` as the `VECTOR_PROVISIONED` var for that environment — the record the Worker's boot check reads. That write happens last and only on success, so the record never claims more than provisioning got done. Commit it: it is the evidence a deploy is allowed to serve filtered searches. `pithy vector reset` rewrites it too, since a rebuild makes the old record stale by definition.

### reprocess

```
pithy vector reprocess --env production --index docs --json
pithy vector reprocess --env production --all --json
pithy vector reprocess --env production --filter '{"tenantId":"acme"}' --json
```

Re-embeds an index's documents through a Cloudflare Workflow, so it survives a corpus of any size. By default it re-embeds only the rows whose stored `model` differs from the configured one — which includes rows never embedded at all. `--all` forces a full pass. `--filter` narrows the run to documents whose metadata matches, using the same operators a query filter does.

With no `--index` it runs every configured index in turn, because "the model changed" is usually a project-wide event.

Paging is by keyset (`id > cursor`), not `LIMIT/OFFSET`, and that is the correctness argument rather than a performance one: the default pass rewrites the very rows it selects, so each page shrinks the result set and offset paging would skip half the corpus. Each page is one journalled Workflow step, capped at the Workers upsert ceiling of 1,000, so an interrupted run resumes at the page it reached and no document is embedded twice.

### reset

```
pithy vector reset --env staging --confirm-reset "yes, i really want to reset staging" --json
```

Destructive. Deletes each index, rebuilds it, re-provisions its metadata indexes, and re-embeds the whole corpus from D1. It is the only repair for a metadata index added after the vectors were written.

The gate is `docs/CLI.md` §7.5, the same one `pithy seed --redo` uses, imported rather than reimplemented. `dev` is free. Every other environment needs the exact phrase, lowercase, naming its own environment:

```
yes, i really want to reset <env>
```

So resetting `staging` needs `"yes, i really want to reset staging"` and nothing else. Interactively you type it at a prompt; headlessly you pass it to `--confirm-reset`, which is authoritative wherever it appears. `--yes` does **not** unlock a reset and is not an argument of this command: `--yes` was designed to authorize additive writes, and a reset deletes every vector in an index.

A non-`dev` reset is recorded through `@pithy-sh/audit` at `critical` severity, with the outcome it actually had — a failed reset is audited as a failure, before the error is re-thrown. On `dev` nothing is audited, because a dev reset changes nothing shared.

## Limits

Verified against Cloudflare's published limits on 2026-07-27. Every ceiling is checked before the call, because Vectorize's own rejections name neither the limit nor the offending vector.

| Limit | Value | What happens |
|---|---|---|
| Dimensions per vector | 1,536 | `vector/dimension_mismatch` |
| Vector id | 64 bytes | `validation/invalid_input` |
| Index and namespace name | 64 bytes | fails at config parse |
| Metadata per vector | under 10 KiB | `vector/metadata_too_large` |
| Filter, compact JSON | under 2,048 bytes | `vector/filter_too_large` |
| Filter key | 512 characters, no dot, no leading `$` | `validation/invalid_input` |
| topK with values or metadata | 50 | `vector/topk_exceeded` |
| topK without either | 100 | `vector/topk_exceeded` |
| Metadata indexes per index | 10 | fails at config parse |
| Upsert batch, Workers binding | 1,000 | `validation/invalid_input` |

## Routes

| Route | Purpose | Verification |
|---|---|---|
| `POST /vector/:index/documents` | Write one document or a batch | bearer \| session |
| `POST /vector/:index/query` | Search, with an optional metadata filter | bearer \| session |
| `GET /vector/:index/documents/:id` | Fetch one hydrated document | bearer \| session |
| `DELETE /vector/:index/documents/:id` | Delete from the index and the corpus | bearer \| session |

There is no public vector surface. A corpus is content the adopter owns, and an unauthenticated search endpoint is an exfiltration endpoint. `requireAuth()` is copied into this package rather than imported from `@pithy-sh/auth`, so a project with no auth capability composed denies every route instead of serving them open.

A write takes `text` (embedded with the index's pinned model) or `values` (a precomputed embedding), never both and never neither. A query takes the same pair. `:index` names an index in `pithy.config.ts`, so an unknown one is a 404 from config alone, before any binding is touched.

A query returns hydrated matches — `{ id, score, document }` — not bare ids. Neither values nor metadata is requested from Vectorize: the content is authoritative in D1, and asking for no payload is also what keeps the topK ceiling at 100 instead of 50.

Two orderings are load-bearing, and both are asserted in tests. A write lands in D1 first and stamps the row's `model` only once Vectorize accepts the vector, so a half-failed write leaves a row the next `pithy vector reprocess` picks up by default. A delete leaves the index first, so a failure never leaves a vector that matches a query but cannot be hydrated.

## The document table

`pithy_vector_documents` earns its place three times over. Vectorize returns ids and scores, not content, so results hydrate from it. Long source text exceeds the 10 KiB metadata ceiling and cannot live in Vectorize at all. And re-embedding — after a model change, or a metadata index added too late — needs a durable corpus to read from.

The primary key is `(index_name, id)`, not `id`. A Vectorize id is unique within an index and says nothing across them, so `docs` and `faqs` may each hold a document called `intro` — and they are different documents. Keying on `id` alone would let the second write silently replace the first, leaving the `docs` corpus one document short and a later `docs` search hydrating the wrong content.

Chunking stays yours. One row is one vector; how you split a document into rows is a decision this package does not make for you.

## Errors

Every throw is a `PithyError` carrying one of these codes. The HTTP codec strips `detail`, so the offending value never reaches a client.

| Code | Status | When |
|---|---|---|
| `vector/index_not_found` | 404 | The `:index` segment names no index in config |
| `vector/unfilterable_field` | 400 | A filter names a field the schema does not mark filterable |
| `vector/filter_too_large` | 400 | The filter's compact JSON reaches 2,048 bytes |
| `vector/dimension_mismatch` | 400 | A vector's length is not the index's `dimensions` |
| `vector/topk_exceeded` | 400 | `topK` is above the ceiling for the requested payload |
| `vector/metadata_too_large` | 400 | A vector's metadata reaches 10 KiB |
| `vector/metadata_index_drift` | 500 | A declared metadata index is missing or mis-typed — at boot, against what `provision` last observed; in the CLI, against the live index |

## Seams, not hard dependencies

Cloudflare ships no local emulation for Vectorize or Workers AI, so every index and embedding call goes through an injectable structural seam — the binding is the first parameter, model ids trail. That is the only way any of it can be unit-tested, and the tests run with no network at all.

Auth is a seam too. `dependsOn` is empty, `auth` is an `optionalCapabilities` entry, and without it every route denies.
