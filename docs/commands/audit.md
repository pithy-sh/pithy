# pithy audit

_The site renders this for readers: [pithy.sh/docs/cli/commands/audit](https://pithy.sh/docs/cli/commands/audit). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Verify the audit trail's hash chain from outside the Worker, and lock the checkpoints it is verified against. What the chain is, what a checkpoint holds and what the export carries is [`packages/audit/README.md`](../../packages/audit/README.md) §Tamper evidence.

## Synopsis

```bash
pithy audit verify <file> [--json]
pithy audit lock --env <name> [--json]
```

## Flags

| Flag | Meaning |
|---|---|
| `<file>` | `verify` only. An export saved from `GET {audit}/control-plane/export`, as it came. Required. |
| `--env <name>` | `lock` only. The deployed environment whose checkpoint bucket to lock. Required; `dev` is refused, because a local bucket has nothing to lock. |
| `--json` | Machine-readable output. Default `false`. |

## What it does

### `pithy audit verify <file>`

Reads one export page and checks it offline: each event's hash over its canonical serialization, each link to the event before it starting from the page's `prior`, each personal value against its commitment when the export carries values, and each checkpoint the page carries. It reads the file and nothing else — no project, no credentials, no network — so an auditor trusts neither the Worker nor us. Nothing is signed, so nothing needs a key.

**It names the first break and stops there**, with the event and its position in the tenant's chain: `edited` (the event does not hash to what it carries), `commitment` (a value does not match its commitment, a value travels without the salt that opens it, or an export that says it carries the values is missing one), `missing` (events before it are gone), `inserted` (it is not where the chain says it belongs), `unlinked` (it does not name the event before it), `checkpoint` (its hash differs from the checkpoint at its position), or `truncated` (the chain ends before a checkpoint says it did). A truncation is only judged on the last page of a range that runs to the head, which the page says in `complete`.

**The checkpoints in the file are only as good as where they came from.** Fetch them from the checkpoint bucket yourself when the export's provenance matters: a checkpoint object is the chain's head and count at an hour, under an object lock nothing in the Worker can lift.

**The event id and the detail are printed with every control character stripped.** They come out of the file being checked, and an id carrying an escape sequence could otherwise repaint the verdict on the terminal. `--json` escapes them as JSON does.

A broken chain is an answer, not an error: the report is printed and the run exits 1.

### `pithy audit lock --env <name>`

Adds an indefinite object-lock rule over `checkpoints/` to the environment's checkpoint bucket, `<project>-<env>-audit-checkpoints` — the bucket `pithy provision` creates for the `AUDIT_CHECKPOINTS` binding. From then on no checkpoint can be replaced or deleted, by the Worker, by you, or by anyone holding the bucket's keys, which is what makes it evidence. The bucket's other rules are kept. A re-run finds the rule in force and changes nothing. Where the account does not support bucket locks, Cloudflare's refusal is reported as it came.

`pithy doctor` says per environment whether the lock is in force, and names this command when it is not.

## `--json`

One line on stdout.

### `pithy audit verify --json`

| key | type | meaning |
|---|---|---|
| `command` | string | `"audit verify"`. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `file` | string | The export file read, as given. |
| `tenant` | string \| null | The tenant whose chain the export holds, or `null` for the untenanted chain. |
| `intact` | boolean | Whether the export's chain is whole against its checkpoints. |
| `checked` | integer | How many events were checked before the first break. |
| `checkpoints` | integer | How many of the tenant's checkpoints the export carried. |
| `values` | boolean | Whether the export carried personal values, so their commitments were checked too. |
| `break` | object \| null | The first break: `{ eventId, position, reason, detail }`. `eventId` is `null` where the break is an absence. |

### `pithy audit lock --json`

| key | type | meaning |
|---|---|---|
| `command` | string | `"audit lock"`. |
| `schemaVersion` | integer | The version of this payload's shape. |
| `env` | string | The environment whose checkpoint bucket was locked. |
| `bucketName` | string | The checkpoint bucket. |
| `lock` | string | `"added"` — this run added the rule. `"already"` — an indefinite rule already covered the checkpoints. |

## Errors

- **`Cannot read <file>.`**, **`<file> is not JSON.`**, **`<file> is not an audit export.`** `verify` was handed something other than an export body. Exit 2.
- **`Name the environment to lock.`** `lock` with no `--env`. `input/required`. Exit 2.
- **`The checkpoint bucket <name> does not exist.`** `lock` before `pithy provision --env <name>` created it. Exit 3, with `pithy provision --env <name> --yes` as the `fix` — except for an environment the project calls production, which is a person's to provision and carries none.

## Examples

```console
$ pithy audit verify acme-export.json
Intact. 1204 events, 3 checkpoints.
```

```console
$ pithy audit verify acme-export.json
Broken at position 418, event 6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13: edited.
Event 6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13 does not hash to the value it carries.
Checked before the break: 417 events, 1 checkpoint.
```

```console
$ pithy audit lock --env prod
Locked acme-prod-audit-checkpoints. Checkpoints there can no longer be replaced or deleted.
Done.
```
