# pithy adopt

Copy every dev value `doctor` reports as misplaced to where the current layout keeps it — the account's Cloudflare credentials, registry secrets, dev bindings, minted tokens. A dry run by default, and it never deletes from a source file.

## Synopsis

```bash
pithy adopt [--apply] [--json]
```

## Flags

| Flag | Meaning |
|---|---|
| `--apply` | Perform the plan. Default `false` — print it and write nothing. |
| `--json` | Machine-readable output. Default `false`. |

## What it does

`pithy doctor`'s `Dev secrets:` block (`docs/commands/doctor.md`) reports every value a project on the old layout is holding in the wrong file, and where each one belongs. `pithy adopt` performs that sort. It is the other half of one command pair: doctor reports, adopt moves, and doctor goes quiet.

| What | Where it goes |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `SECRETS_STORE_ID` in the root `.dev.vars` | `<config>/cloudflare.json`, account-scoped |
| A registry secret in the root `.dev.vars`, any backend — `SECRETS_ENCRYPTION_KEYS` included | `<config>/<project>/secrets.jsonc`, as a version-1 envelope |
| A registry secret still copied into `<config>/<project>/dev.json` under `"vars"` | the same `secrets.jsonc` |
| A dev value a Worker needs as a binding and no registry declares — a Turnstile sitekey | `<config>/<project>/dev.json` under `"vars"` |
| A minted credential in a `.dev.vars.<env>` | `<config>/<project>/tokens.json`, keyed by environment |
| A key nothing this project composes declares | nowhere. It is named, and left where it is |
| A key nobody could classify, because a Worker's `pithy.config.ts` would not import | nowhere. It is **refused** by name, and the run exits non-zero |

Six rules, and each one is the answer to a way this could go wrong.

**It never deletes from a source file.** It copies, and then reports which lines now have a copy elsewhere. You delete them. #142 was a run that rewrote an adopter's `.dev.vars` and destroyed gitignored secrets with no copy anywhere, and a move that loses a secret has no undo. The consequence is worth stating plainly: `doctor` keeps reporting those keys until you delete them, because they are still in the file.

**A dry run is the default, and there is no prompt.** `pithy adopt` prints the plan and touches nothing. `pithy adopt --apply` performs it, and says so on the line before the first write. A confirmation an agent cannot answer would be a command an agent cannot run, and the two-invocation shape reads the same in a terminal and in CI.

**A value that differs from the one already at its destination is refused, never overwritten.** Two different values under one name is exactly the state that produces "which one signed this?", and picking one silently is how a project ends up with a secret nobody can account for. The refusal is per key — the others still move — and it fails the exit.

**A key it cannot place is named, not guessed.** A project whose root `pithy.config.ts` sets no `name` has no per-project directory to key on, and every destination but `cloudflare.json` is refused by name. A `json` registry secret whose `.dev.vars` line is not JSON is refused the same way, rather than written as a string the next `pithy seed` would reject.

**A value it could not classify is refused, and never called safe to remove.** `adopt` decides where each value belongs by asking the registry what this project declares, and a `pithy.config.ts` that will not import used to answer "declares nothing" — indistinguishable from a project with no secrets. So a registry secret read as a key nothing composes, and the report said so. This command deletes nothing itself, which is exactly why that matters: its verdicts are what an adopter acts on, and the loss would arrive one step later, by hand, on this advice. It names the Worker, refuses that value, moves everything it still has positive evidence for — a Cloudflare credential needs no registry to place — and fails the exit.

**It is idempotent.** A second run copies nothing and says so. A value already at its destination is `already there`, not re-copied — and that is the state the whole project reaches once, permanently.

**Every destination is written atomically, `0600`, in the `0700` config directory**, through the same writers `pithy init`, `pithy add secrets` and `pithy token mint` use. There is no second write path here.

**No value reaches stdout, `--json`, or an error message.** Names, paths, environments and verdicts only, on every path including the refusals.

## `--json`

`pithy adopt --json` carries six fields. `command` is the command's name and `project` the root config's `name` (`null` when it sets none). `applied` says whether this run wrote anything. `entries` is the whole plan, one object per value found, each carrying its `key`, the absolute `source` file it is in, the `env` a minted token was minted for (`null` otherwise), its `kind` (`credential`, `secret`, `binding`, `token`, `unclassified`, `unread`), the absolute `destination` (`null` when nothing composes it), the `action` taken (`copy`, `present`, `conflict`, `refused`, `leave`), a `reason` sentence for a refusal (`null` otherwise), and `safeToRemove`. `safeToRemove` at the top level is the same list as a pair of `file` and `key` — empty on a dry run, because nothing was written and so nothing is safe to delete yet. `refused` is the same shape, for every value that was not placed.

```
$ pithy adopt --json
{"command":"adopt","project":"replay","applied":true,"entries":[{"key":"CLOUDFLARE_ACCOUNT_ID","source":"/w/replay/.dev.vars","env":null,"kind":"credential","destination":"/Users/jo/.config/pithy/cloudflare.json","action":"copy","reason":null,"safeToRemove":true}],"safeToRemove":[{"file":"/w/replay/.dev.vars","key":"CLOUDFLARE_ACCOUNT_ID"}],"refused":[]}
```

| key | type | meaning |
|---|---|---|
| `command` | string | `"adopt"`. |
| `project` | string \| null | The root config's `name`, `null` when it sets none. |
| `applied` | boolean | Whether this run wrote anything. |
| `entries` | object[] | The whole plan, one object per value found. |
| `entries[].key` | string | The value's name. Never its value. |
| `entries[].source` | string | The absolute path of the file it is in. |
| `entries[].env` | string \| null | The environment a minted token was minted for, `null` otherwise. |
| `entries[].kind` | string | `credential`, `secret`, `binding`, `token`, `unclassified`, or `unread`. |
| `entries[].destination` | string \| null | The absolute path it belongs at, `null` when nothing composes it. |
| `entries[].action` | string | `copy`, `present`, `conflict`, `refused`, or `leave`. |
| `entries[].reason` | string \| null | A refusal's sentence, `null` otherwise. |
| `entries[].safeToRemove` | boolean | Whether this value now has a copy elsewhere. |
| `safeToRemove` | object[] | The same list as a pair of `file` and `key`. Empty on a dry run — nothing was written, so nothing is safe to delete yet. |
| `refused` | object[] | Every value that was not placed, in the same shape. |

## Errors

**The exit code is non-zero when anything was refused** — a conflicting value, or one with nowhere to go. A key nothing composes is not a refusal and does not gate: it is the ordinary residue of an old project, and deleting it is a judgement only its author can make.

The three refusals are a conflicting value, a key with nowhere to go, and a value nothing could classify. Each is stated in full above, each names itself in the report, and each appears in `refused` under `--json`. No value reaches any of them.

## Examples

```
$ pithy adopt

replay — 9 values, 7 to copy.

  auth-session-secret      ~/.config/pithy/replay/dev.json  →  ~/.config/pithy/replay/secrets.jsonc  already there
  auth-session-secret      .dev.vars                        →  ~/.config/pithy/replay/secrets.jsonc  would copy
  CLOUDFLARE_ACCOUNT_ID    .dev.vars                        →  ~/.config/pithy/cloudflare.json       would copy
  CLOUDFLARE_API_TOKEN     .dev.vars                        →  ~/.config/pithy/cloudflare.json       would copy
  OLD_FEATURE_FLAG         .dev.vars                        →  nothing reads it                      nothing reads it
  SECRETS_ENCRYPTION_KEYS  .dev.vars                        →  ~/.config/pithy/replay/secrets.jsonc  would copy
  SECRETS_STORE_ID         .dev.vars                        →  ~/.config/pithy/cloudflare.json       would copy
  TURNSTILE_SITEKEY        .dev.vars                        →  ~/.config/pithy/replay/dev.json       would copy
  CF_TOKEN_CI_SYSTEM       .dev.vars.production             →  ~/.config/pithy/replay/tokens.json    would copy

Nothing written. Run pithy adopt --apply to perform this.
```

With `--apply`, every `would copy` reads `copied`, and the report closes with the one thing only you can do:

```
Copied 7. Nothing was deleted — delete these yourself when you are ready:
  .dev.vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SECRETS_ENCRYPTION_KEYS, SECRETS_STORE_ID, TURNSTILE_SITEKEY, auth-session-secret
  .dev.vars.production: CF_TOKEN_CI_SYSTEM
Done.
```
