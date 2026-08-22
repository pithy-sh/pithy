# pithy add

Install a capability, wire it into one Worker's config and bindings, and run that Worker's dev migrations.

## Synopsis

```
pithy add <capability> [--worker <name>] [--with-prerequisites] [--set key=value]… [--eject [--force]] [--json]
pithy add --list [--json]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `<capability>` | positional | — | The capability name, e.g. `auth`. Optional only because `--list` runs without one |
| `--list` | boolean | `false` | List the capabilities you can add, with the installed ones marked. Wires nothing |
| `--worker <name>` | string | — | Which Worker to wire it into (`apps/<name>`). Optional in a single-Worker project |
| `--set key=value` | string | — | Override one of the capability's config options. Repeatable |
| `--eject` | boolean | `false` | Copy the capability's source into your repo and repoint the wiring at it |
| `--force` | boolean | `false` | With `--eject`, overwrite an existing local copy. Discards your edits |
| `--with-prerequisites` | boolean | `false` | Compose the capabilities this one requires, if this Worker does not compose them yet |
| `--json` | boolean | `false` | Machine-readable output |

## What it does

One capability, one Worker, in this order.

**Install the package.** The package name comes from the catalog, never from interpolating the capability name — `controlplane` ships inside `@pithy-sh/core`, so `@pithy-sh/controlplane` is a package that has never existed. The project's own package manager runs the install, detected from its lockfile: `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, npm when there is none. A `@pithy-sh/*` package a linked checkout already provides is skipped, and nothing then declares it in a `package.json`.

**Read the real manifest.** `node_modules/@pithy-sh/<pkg>/pithy.manifest.json`, validated. What the package says it needs is what gets wired — the catalog is a discovery list, not the contract.

**Resolve what it composes against.** A manifest's `peerCapabilities` are the capabilities this one reads a seam of: `auth` declares `secrets` and `email`, `email` declares `secrets`, and `payments`, `support`, `storage`, `media` and `turnstile` all declare `secrets`. They are not advice. `createBackend` refuses to assemble a capability without them — `Capability "auth" requires the "secrets" capability, which is not composed` — so a Worker missing one does not start at all.

They are a **graph**, not a list, and they are composed deepest first. `secrets` before `email`, because `email` reads a secret at boot; `email` before `auth`. The order comes from walking the declarations, never from the order a manifest happens to write them in.

Each one is a real `pithy add`: its package installed, its config and bindings written, its dev secrets minted, its own `capability/added` audit event. Their config options take manifest defaults — you asked for one capability, not for an interview about three — and `pithy add email --set …` afterwards edits the same registration.

**What decides whether they are composed at all** is what the run can be asked:

- **A terminal.** One question, for the whole cascade: `auth requires secrets, email. Compose them too?` A nested prerequisite is never asked about again — one intent, one question. Declining refuses the run.
- **`--with-prerequisites`.** Composes them without asking. The deterministic answer, and the one to put in a script.
- **Anything else** — `--json`, no TTY, an agent — is **refused**, exit 1, naming the exact commands in the order they must run. Nothing is wired: an install has happened, because that is how the manifest was readable, and the config is untouched.

```
$ pithy add auth --json
{"error":{…,"message":"auth requires secrets and email, which board does not compose.","action":"Run pithy add auth --with-prerequisites, or compose them first: pithy add secrets, then pithy add email."}}
```

Composing something nobody asked for is not a thing to do behind an adopter's back. Reporting `Done.` on a project that cannot boot is worse. A prompt where there is someone to ask and a flag where there is not is how the rest of this CLI settles that (§`--worker`, `pithy init`'s domains).

**Wire that Worker.** `apps/<name>/pithy.config.ts` gains the import and the registration call; `apps/<name>/wrangler.jsonc` gains the manifest's required bindings, in every environment stanza the file declares, plus any Durable Object class migrations; and the module that Worker's `main` names gains an `export { <Class> } from "…";` for every Durable Object class it now binds. Handler source stays in the package. Only the thin registration lands in your repo.

Every binding whose entry `add` can complete offline is written: `d1_databases`, `kv_namespaces`, `r2_buckets`, `ai`, `durable_objects`, `ratelimits`, and `workflows`. Two are worth a sentence each.

A **rate limiter** is a policy, not a resource — nothing exists behind it in your account. It is written at **100 requests per 60 seconds, per client IP**, which is a flood guard rather than a product rule. Tune it in `wrangler.jsonc`; `add` never rewrites an entry you have changed. Cloudflare accepts a `period` of `10` or `60` and nothing else.

A **Durable Object** is two halves, and only one of them is config. The `durable_objects.bindings` entry names a `class_name`, and wrangler resolves that name against the module `main` names — a Worker whose entry does not export the class is refused at deploy with *Your Worker depends on the following Durable Objects, which are not exported in your entrypoint file*. So `add` writes the export too, under a comment saying what the block is. Delete a line from it and the Worker stops deploying; `pithy remove` takes it back out. A class the entry already exports, however you wrote it, is left alone.

A **Workflow** entry names the capability's host Worker across scripts — `<project>-<env>-<capability>-<job>` running in `<project>-<env>-<capability>` — so it is complete before that host exists, and `wrangler dev` binds it either way. The host itself is deployed by `pithy <capability> provision`, which `notes` says.

What is left out is left out because wrangler would refuse the file: a `vectorize` entry needs the `index_name` provisioning mints, and a `secret` has no array in `wrangler.jsonc` at all. Those come back in `notes`.

**Scaffold the config options.** Values come from `--set` first, then from a prompt when a human is attached. An option whose default is an object or an array is left as the manifest scaffolds it — a secrets registry is not something anyone types at a prompt.

**An option with no default is required.** That is the whole declaration: a capability that states a default has an answer the kit is willing to pick, and one that states none has an answer only you can give. A prompt asks it with nothing to accept by pressing enter, and a run with no human is refused unless it carries `--set key=value`. `payments.billingSubject` is the first — whether an entitlement is held by a person or a company, which lands in a column and a UNIQUE index — and nothing guesses it. An option that also states its choices is asked as a list, and `--set` refuses anything outside them.

**Eject, if asked.** Before the migrations, because eject repoints the config import at the local copy and promotes the capability's runtime dependencies into your project, and the migrate step has to load the config with everything it imports present.

**Run that Worker's dev migrations.** The config is re-read after wiring, so the migration that just arrived is in the registry. Local Miniflare state lives at the project root, shared with `wrangler dev`.

**Bootstrap what is left.** Dev-only values a capability needs to boot — the master key `pithy add secrets` mints, the session secret `auth` needs — land in `$PITHY_CONFIG_DIR/<project>/secrets.jsonc`, outside every checkout. What only a provision command can supply comes back as a note instead.

`add` runs against no Cloudflare account. It writes config and local D1 only. Bindings whose resources live in the account (`pithy storage provision`, `pithy secrets provision`, `pithy vector provision`) are named in `notes` rather than created here. The one thing an account changes is the audit trail: with Cloudflare credentials resolvable and the `audit` capability composed, the run records `capability/added` at `info` severity, on success and on failure alike. Without them the emitter is inert — which is always true the first time `pithy add audit` runs, since nothing can audit-log its own installation.

**The project needs a `name`.** It leads every resource name `add` proposes, and it claims the database the closing dev migration writes to. A project without one is told to set it before anything is installed, rather than left half-configured around an unowned database.

**Which Worker.** `--worker` names it. A single-Worker project needs no ceremony. A project with several never guesses: it prompts a human, and raises an actionable error for anyone else — an agent driving `--json` is told what to pass rather than hanging on a question it cannot answer.

Idempotent. A second `pithy add auth` changes nothing. Adding the same capability to a second Worker reuses the installed package and writes only that Worker's config and bindings.

## `--json`

One line, one object. Two shapes: one for `--list`, one for a real add.

### `pithy add --list --json`

```
$ pithy add --list --json
{"command":"add","capabilities":[{"name":"auth","package":"@pithy-sh/auth","whenToEnable":"Authentication and session management.","installed":false}, …],"manifestFaults":[]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"add"` | The command that produced the line |
| `capabilities` | array | The built-in catalog, in catalog order, each entry tagged with whether this project has it installed |
| `capabilities[].name` | string | The capability name — the `pithy add <name>` argument |
| `capabilities[].package` | string | The npm package it ships in. `@pithy-sh/<name>` for all but `controlplane`, which ships inside `@pithy-sh/core` |
| `capabilities[].whenToEnable` | string | One-line rationale: why a project would enable this |
| `capabilities[].installed` | boolean | Whether this project's `node_modules/@pithy-sh` holds a usable manifest for it |
| `manifestFaults` | array | Installed packages shipping a `pithy.manifest.json` that is present and unusable. Empty on a healthy install |
| `manifestFaults[].package` | string | The package the manifest was read from, as an adopter names it: `@pithy-sh/audit` |
| `manifestFaults[].reason` | string | Why it could not be used — the schema's refusal text, or the errno where the file would not open |

A faulted package is reported rather than refused: one broken manifest must not cost you the other fifteen entries. In human output the faults go to stderr; the listing still goes to stdout.

### `pithy add <capability> --json`

```
$ pithy add secrets --json
{"command":"add","capability":"secrets","worker":"board","deployedAs":"replay-board","package":"@pithy-sh/secrets","packageManager":"npm","databases":[{"database":"app","binding":"DB","results":[{"migrationName":"0300_auth_0001_init","direction":"Up","status":"Success"}]}],"kvNamespaces":[],"notes":["SECRETS_STORE_ID is not recorded, and there are no Cloudflare credentials to resolve it with. Run pithy init, then pithy add secrets again.", …]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"add"` | The command that produced the line |
| `capability` | string | The capability's name, taken from the manifest rather than from the argument |
| `worker` | string | The `apps/` directory that was wired. What `--worker` accepts, and what every path in this payload is relative to |
| `deployedAs` | string | The same Worker's deployed script name, from `wrangler.jsonc`. What the Cloudflare dashboard shows |
| `package` | string | The npm package the capability ships in |
| `packageManager` | `"npm" \| "pnpm" \| "yarn" \| "bun"` | The project's package manager, detected from its lockfile. Reported whether or not an install ran — it is a fact about the project, not a record of a spawn |
| `databases` | array | The dev migration run, one entry per database this Worker's registry touched |
| `databases[].database` | string | The database name — a capability's `databases` key |
| `databases[].binding` | string | The D1 binding it resolves to in this Worker's `wrangler.jsonc` |
| `databases[].results` | array | The migrations this Worker's capabilities contributed, and how each fared |
| `databases[].results[].migrationName` | string | The migration's namespaced name, e.g. `0300_auth_0001_init` |
| `databases[].results[].direction` | `"Up" \| "Down"` | The direction it was executed in |
| `databases[].results[].status` | `"Success" \| "Error" \| "NotExecuted"` | `NotExecuted` means an earlier migration failed |
| `databases[].sharedWith` | string[] | The other Workers bound to this same physical D1. Present only when a database is shared |
| `kvNamespaces` | array | KV namespace titles to create, one per environment that gained the binding. Reported rather than written, because a `kv_namespaces` entry has no title field — the name can only land in the account. D1's proposal goes into `wrangler.jsonc` as `database_name` |
| `kvNamespaces[].binding` | string | The Worker env binding the name is proposed for, e.g. `SESSIONS` |
| `kvNamespaces[].env` | string | The environment whose stanza declares it — `dev` for the top-level one |
| `kvNamespaces[].name` | string | The proposed resource name, `<project>-<env>-<binding>` |
| `notes` | string[] | What `add` finished off-config, and what only a provision command can supply. One line each, in order — a prerequisite's notes come first, so the dev master key `pithy add secrets` mints is never swallowed. Empty for a capability every one of whose bindings `add` writes |
| `prerequisites` | string[] | The capabilities composed on the way to this one, in the order composed — deepest first. Empty when it declares none, and empty on a re-run into a Worker that already composes them |
| `eject` | object | Present only when `--eject` ran |
| `eject.capability` | string | The capability that was forked |
| `eject.path` | string | The Worker-relative directory the source was copied into, `capabilities/<cap>` |
| `eject.promotedDependencies` | string[] | The `name@version` dependencies promoted into your project. Workspace-internal ones are excluded |
| `eject.forced` | boolean | Whether an existing local copy was overwritten (`--force`) |

`kvNamespaces` is empty when the capability needs no KV, when no project name was resolved, and on a re-run — a binding already present is left alone.

## Errors

Each one is a `PithyError`: the problem, then the action. Under `--json` it is a single `{"error":{…}}` line on stderr and exit 1.

**No capability named.**

```
$ pithy add
Name a capability to add.
Run pithy add --list to see what's available.
```

**Several Workers, none named.** The prompt is attached only when a human is attached, so this is what an agent gets.

```
$ pithy add audit --json
{"error":{"code":"validation/invalid_input","status":400,"issues":[],"message":"This project has several workers, so which one to wire is ambiguous.","action":"Pass --worker <name>. Known: relay-deck, relay-tally."}}
```

**A `--worker` that names nothing.**

```
$ pithy add audit --worker nope
No worker named "nope".
Run pithy worker list to see this project's workers. Known: relay-deck, relay-tally.
```

**An unknown `--set` key.** The valid keys come back with it, so an agent and a human get the same correction.

```
$ pithy add auth --set nope=1
auth has no config option "nope".
Valid keys: basePath, baseURL, disableSignUp.
```

**A `--set` with no `=`.**

```
$ pithy add auth --set nope
--set expects key=value, got "nope".
Pass --set key=value.
```

**A `--set` on an option only you can write.** An option whose default is an object or an array takes more than a string.

```
$ pithy add secrets --set registry=x
secrets option "registry" is not settable from the command line.
Edit registry in the worker's pithy.config.ts — pithy add scaffolds it empty.
```

**A required option nobody answered**, in a run that cannot be asked. Exit 1, and the action names the flag and every value it takes.

```
$ pithy add payments --json
{"error":{"code":"validation/invalid_input","status":400,"issues":[],"message":"payments needs a value for billingSubject, and nothing in this run names one.","action":"Pass --set billingSubject=user or --set billingSubject=organization."}}
```

**A `--set` outside an option's choices.**

```
$ pithy add payments --set billingSubject=team
payments option "billingSubject" does not take "team".
Pass one of: user, organization.
```

**A prerequisite this Worker does not compose**, in a run that cannot be asked. Exit 1, and the commands come back in dependency order.

```
$ pithy add auth --json
{"error":{"code":"validation/invalid_input","status":400,"issues":[],"message":"auth requires secrets and email, which board does not compose.","action":"Run pithy add auth --with-prerequisites, or compose them first: pithy add secrets, then pithy add email."}}
```

**A capability whose manifest is not there**, when the install did not run or did not land. `No capability named "<name>" is installed.` — with `Run pithy add <name> to install it.`

**A malformed manifest on the direct path.** The `--list` scan reports a fault and carries on; asking for that capability by name refuses, naming the package and the schema's own reason.

**`--eject` over an existing fork.**

```
$ pithy add audit --eject
capabilities/audit already exists.
Edit the local copy, or re-run with --force to overwrite it (discards your changes).
```

**A project with no `name`.** Thrown before the package is installed, so a nameless project is told to set one rather than left half-configured around an unowned database.

## Examples

Wire a capability into a single-Worker project.

```
$ pithy add audit
Wired audit into board.
app: 1 applied.
Done.
```

Compose a capability and everything it requires, in one command. `auth` reads `secrets` and sends through `email`, so both arrive with it — deepest first, each fully wired.

```
$ pithy add auth --with-prerequisites
Composed secrets, email into board first — auth requires them.
Wired auth into board.
app: 1 applied.
Minted a dev master key as SECRETS_ENCRYPTION_KEYS, into ~/.config/pithy/replay/secrets.jsonc. Local only, and it reaches each Worker's generated .dev.vars.
Minted a dev email-link-signing-key into ~/.config/pithy/replay/secrets.jsonc. Local only.
Minted a dev auth-session-secret into ~/.config/pithy/replay/secrets.jsonc. Local only.
Deployed environments need pithy secrets create auth-session-secret.
Done.
```

Name the Worker in a project with several.

```
$ pithy add audit --worker deck
```

Set config options without a prompt. `--set` repeats.

```
$ pithy add auth --set basePath=/session --set disableSignUp=true
```

Fork the source and own it.

```
$ pithy add audit --eject
Wired audit into board.
Ejected audit into apps/board/capabilities/audit/. It's yours now — @pithy-sh/audit no longer upgrades it.
Promoted 4 dependencies. @pithy-sh/audit is safe to remove.
Done.
```

An ejected capability is never reconciled again — `pithy upgrade` reports it as skipped. See `docs/EJECT.md`.

See what there is.

```
$ pithy add --list
auth          Authentication and session management.
secrets       Encrypted secret storage with a worker-only master key and automatic at-rest key rotation.
…
```
