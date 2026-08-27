# pithy vector

_The site renders this for readers: [pithy.sh/docs/cli/commands/vector](https://pithy.sh/docs/cli/commands/vector). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Stand up an environment's search indexes, rebuild them from the corpus, and re-embed what they hold.

## Synopsis

```
pithy vector provision [--env <environment>] [--json]
pithy vector reset [--env <environment>] [--confirm-reset <phrase>] [--json]
pithy vector reprocess [--env <environment>] [--index <name>] [--all] [--filter <json>] [--json]
```

**All three subcommands need a Cloudflare account, `--env dev` included.** Cloudflare ships no local emulation for Vectorize, so a dev search reaches a real remote index — which is also why the capability's bindings are declared `remote`. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are checked before anything is created.

## Flags

| Flag | Applies to | Default | Purpose |
|---|---|---|---|
| `--env <environment>` | all three | `dev` | The environment to act on: `dev`, `staging`, `prod`, or a custom one. `dev` is a real remote index here, not a local store |
| `--confirm-reset <phrase>` | `reset` | — | Unlock a non-`dev` reset non-interactively. The exact, environment-named phrase: `yes, i really want to reset <env>` |
| `--index <name>` | `reprocess` | every configured index | The index to re-embed, as named in `pithy.config.ts` |
| `--all` | `reprocess` | `false` | Re-embed every document, not only the ones whose model differs from config |
| `--filter <json>` | `reprocess` | — | Narrow the run to matching documents, as a JSON metadata object: `'{"ownerId":"ada"}'`. Parsed here, so a malformed filter fails in this terminal rather than inside a running Workflow |
| `--json` | all three | `false` | One line of machine-readable output |

**There is no `--yes` on `reset`, deliberately.** `--yes` elsewhere means "yes, this is not dev", and it was designed to authorize additive writes. A reset deletes every vector in an index, so it carries the stricter gate of `docs/CLI.md` §8.5 — the same one `pithy seed --redo` uses, imported rather than re-implemented. `dev` is free; every other environment needs the exact phrase, and a headless run without `--confirm-reset` is refused.

## What it does

`provision` creates each index the config declares, or reuses one that already exists, and creates every metadata index the index's schema marks filterable. It returns only once each declared metadata index is actually live — waiting out Cloudflare's asynchronous apply — because the very next step deploys the Worker that writes vectors, and a write landing before an index exists is permanently unfilterable. Then it deploys the prebuilt reprocess Worker for that environment and writes two things into the app's `wrangler.jsonc`: the `VECTOR_PROVISIONED` var recording what it observed, and this environment's `vectorize` and `workflows` bindings. `pithy add vector` cannot write those bindings — wrangler requires an `index_name` on one and a `name` plus `class_name` on the other, and all three are provisioning outputs.

The `VECTOR_PROVISIONED` var is what the Worker compares its declarations against at boot, refusing to serve on drift. That check is the only way an adopter who edits a metadata schema and deploys without re-provisioning hears about it, because Vectorize answers such a filter with partial results and no error. The var is written last, and only on success, so it never claims more than provisioning got done.

`reset` is the repair for the one failure Vectorize cannot repair in place: a metadata index added after vectors were written covers none of them, and there is no backfill. It deletes every configured index, rebuilds each through the ordinary provision path, and re-embeds the corpus from D1 with `all` set, since the rebuilt index holds nothing. **Destructive by definition** — only the D1 corpus survives, and only what it holds comes back. A non-`dev` reset is audited at `critical` severity, truthfully: recorded as `failure` when it dies partway, and the command still fails. A `dev` reset is not audited at all, because it changes nothing shared. The `VECTOR_PROVISIONED` record is rewritten afterwards, since a reset makes the old one stale by definition.

`reprocess` runs the re-embed Workflow for one index or for every configured one, and waits for each. With no `--index` it covers them all, which is what "re-embed after a model change" usually means. Every named index is checked against the config before the first run starts, so a typo costs nothing.

## `--json`

One line, one object, one shape per subcommand. The `command` field carries the space-separated form (`vector provision`), not the dotted one.

```
$ pithy vector provision --env staging --json
{"command":"vector provision","env":"staging","indexes":[{"index":"docs","indexName":"acme-staging-docs","created":[{"propertyName":"ownerId","indexType":"string"}],"extra":[],"observed":[{"propertyName":"ownerId","indexType":"string"}]}]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"vector provision"` | The subcommand that produced the line |
| `env` | `string` | The environment provisioned |
| `indexes` | `object[]` | One entry per configured index — see below |
| `indexes[].index` | `string` | The config's name for the index |
| `indexes[].indexName` | `string` | The Vectorize index name it was provisioned as |
| `indexes[].created` | `object[]` | The metadata indexes created on this run. Empty on a re-run, which is what idempotent looks like |
| `indexes[].created[].propertyName` | `string` | The metadata property the index covers |
| `indexes[].created[].indexType` | `"string" \| "number" \| "boolean"` | How Vectorize stores and compares the property's values |
| `indexes[].extra` | `object[]` | Metadata indexes that exist but the config does not declare. Not fatal; they still spend a slot |
| `indexes[].extra[].propertyName` | `string` | The undeclared property |
| `indexes[].extra[].indexType` | `string` | The type Vectorize reports for it |
| `indexes[].observed` | `object[]` | Every metadata index live on the index when provisioning finished — declared and undeclared alike. This is what the `VECTOR_PROVISIONED` var carries, and what the Worker's boot check compares against |
| `indexes[].observed[].propertyName` | `string` | The metadata property the live index covers |
| `indexes[].observed[].indexType` | `string` | The type Vectorize reports the index was created with, recorded verbatim rather than narrowed to the three types this package declares |

```
$ pithy vector reset --env staging --confirm-reset "yes, i really want to reset staging" --json
{"command":"vector reset","env":"staging","indexes":[…],"deleted":["acme-staging-docs"],"reprocessed":["docs"]}
```

`reset` emits everything `provision` does — it rebuilds through the same path — plus two fields.

| key | type | meaning |
|---|---|---|
| `command` | `"vector reset"` | The subcommand that produced the line |
| `env` | `string` | The environment reset |
| `indexes` | `object[]` | Each rebuilt index, in the shape `provision` reports above |
| `deleted` | `string[]` | The indexes that were deleted and rebuilt, by their Vectorize names |
| `reprocessed` | `string[]` | The reprocess runs started, one per configured index, by their config names |

```
$ pithy vector reprocess --env staging --index docs --json
{"command":"vector reprocess","env":"staging","runs":[{"index":"docs","report":{"indexName":"acme-staging-docs","pages":2,"scanned":140,"reembedded":140,"skipped":0}}]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"vector reprocess"` | The subcommand that produced the line |
| `env` | `string` | The environment the runs happened in |
| `runs` | `object[]` | One entry per index reprocessed, in run order |
| `runs[].index` | `string` | The config's name for the index |
| `runs[].report` | `object` | The Workflow's own return value, passed through verbatim |

**`runs[].report` is the deployed Workflow's output, not the CLI's.** It crosses no schema on the way out — the provisioner types it `unknown` and this command passes it straight through. It is absent from its entry when a completed Workflow returned nothing. What `@pithy-sh/vector` returns today is:

| `report` key | type | meaning |
|---|---|---|
| `indexName` | `string` | The Vectorize index that was reprocessed |
| `pages` | `number` | Pages the run took — one Workflow step each |
| `scanned` | `number` | Rows read |
| `reembedded` | `number` | Rows re-embedded and written back |
| `skipped` | `number` | Rows selected but skipped because the corpus holds no text for them |

## Errors

Each one is a `PithyError` — the problem, then the action. Under `--json` they arrive on stderr as `{"error":{…}}`, and the process exits 1.

**The capability is not configured.** No Worker under `apps/` composes `vector`.

```
The vector capability is not configured.
Add `vector({ indexes: { ... } })` to pithy.config.ts (run `pithy add vector`).
```

**Cloudflare credentials are missing.**

```
Cloudflare credentials are missing.
Run pithy init to record CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or export them.
```

**No `DB` id for this environment.** The document corpus lives in the app database, so provisioning refuses rather than standing up an index with nothing to fill it: `wrangler.jsonc has no DB database_id for <env>.`

**An illegal `--env`.** Checked at the flag, before any config is loaded or any Cloudflare call is made.

**A reset that is not confirmed.** The gate runs before a single Cloudflare call, so a refused reset costs nothing.

```
Resetting staging destroys all of its data.
Pass --confirm-reset "yes, i really want to reset staging" to drop and recreate the staging schema.
```

A supplied-but-wrong phrase is refused separately, and the phrase names its environment — one authorizing a `staging` reset cannot be pasted into a command targeting another.

**An unknown `--index`.** Raised for every named index before the first run starts.

```
No index named `dcos` is configured.
Pick one of: docs, notes.
```

**A malformed `--filter`.** `--filter is not valid JSON.` or `--filter must be a JSON object.` — an array and a bare scalar are both refused.

**The project has no name.** An index is found by name and reused, so the name must be identical on every run, and it is never guessed: a wrong one adopts another project's corpus.

**The Workflow did not finish.** `reset` and `reprocess` wait on dispatched instances and raise a `cloudflare/*` error when one ends `errored` or `terminated`, or is still running at the poll cap.

## Examples

Provision an environment's indexes.

```
$ pithy vector provision --env staging
docs: acme-staging-docs ready, 1 metadata index(es) created.
Done.
```

An index carrying a metadata index the config no longer declares says so, and does not remove it.

```
$ pithy vector provision --env staging
docs: acme-staging-docs ready.
  legacyTag is indexed but not declared. It still costs a slot.
Done.
```

Re-embed after a model change, across every configured index.

```
$ pithy vector reprocess --env staging --all
```

Re-embed one owner's documents only.

```
$ pithy vector reprocess --env staging --index docs --filter '{"ownerId":"ada"}'
```

Rebuild a staging index after adding a filterable field, headlessly.

```
$ pithy vector reset --env staging --confirm-reset "yes, i really want to reset staging"
DESTRUCTIVE. Every vector in staging was deleted and rebuilt from the corpus.
docs: acme-staging-docs rebuilt and re-embedded.
Done.
```
