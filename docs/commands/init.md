# pithy init

Scaffold a new Pithy project — the root config, the gates CI needs, and its first Worker under `apps/`.

## Synopsis

```
pithy init [--name <name>] [--worker <name>] [--dir <path>] [--json]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--name <name>` | string | the target directory's name | Application name. Leads every Cloudflare resource this project provisions |
| `--worker <name>` | string | `api` | Name of the first Worker, created at `apps/<name>` |
| `--dir <path>` | string | `.` | Target directory. Created if missing; must not already hold the files `init` writes |
| `--json` | boolean | `false` | Machine-readable output. Also suppresses every prompt |

## What it does

**Check the target first.** Before a single question is asked, so a doomed run fails fast instead of after you have answered. The check is collision, not emptiness: a directory holding only `.git`, a README, a licence, or an editor config is not a project, and refusing it would mean `pithy init` could not scaffold into a repo you just cloned — which is how projects normally start. It refuses only if something `init` would write is already there. The two paths the scaffold *moves* rather than copies — `apps/api` and `apps/<worker>`, when `--worker` is not the default — are held to emptiness instead, because a rename is not a merge.

**Ask the two names**, when a human is attached and a flag did not supply them. The project name comes with the reasoning printed above it, because both halves of it are hard to undo: the name leads every Cloudflare resource this project provisions, teardown recomputes those names rather than storing them, and the scope decision behind it — one project or two? — cannot be fixed by editing a string later. One project per set of apps that share users or data. Another app is another Worker, not another project. The first Worker is named too, because every Worker lives in `apps/<name>` and `api` is only a default.

**Write the scaffold.** The root `pithy.config.ts`, the root `package.json`, `biome.jsonc`, `.gitignore`, the `.dev.vars.example` and `.dev.secrets.example.jsonc` templates, the two Grit plugins, and the configs CI gates on — `tsconfig.json` (a solution file), `tsconfig.tools.json`, `vitest.config.ts`, and `vitest.workers.config.ts`. Then `apps/<worker>/` with its own `pithy.config.ts`, `wrangler.jsonc`, `pithy.worker.jsonc`, `tsconfig.json`, `package.json`, `src/index.ts`, `src/cloudflare-test.d.ts`, and a `src/bindings.workers.test.ts` that runs against real D1 and KV through Miniflare.

**Record the Cloudflare credentials and discover the account.** This is the one moment you are holding the token, which is why it belongs here: listing zones two prompts later needs it, and so does every command after this. The token is written to `$PITHY_CONFIG_DIR/cloudflare.<name>.json` — `0600`, in a `0700` directory, **outside every checkout**. Nothing secret goes into the project. The account is discovered rather than asked for: the token lists the accounts it can see, one is a confirmation and several are a picker, and choosing the account is what supplies both its id and the nickname for its credentials file. A narrowly scoped token that cannot list falls back to asking for an account id, and `init` still completes. What lands in `pithy.config.ts` is at most a `cloudflare` block naming the account — its nickname, and, if you accept the offer, the account id as a pin. An account id is an identifier, not a secret, and pinning it is what stops another machine's nickname from meaning a different account.

**Ask where the Worker answers**, against that account's real zones. Skippable: a project without a domain yet is legitimate, and adding one later is a config edit plus a deploy. What is declared is written into the Worker's `pithy.config.ts` as a `domains` block, and generated from there into its `wrangler.jsonc` `routes` entry and `vars.BASE_URL`.

**Offer the `p.` shortcut**, once, at the end. Only to a human at a terminal.

A block the writer could not place is **printed for you to paste**, never dropped. That applies to both the `cloudflare` block and the `domains` block: guessing at the shape of a file somebody may already have edited is how a scaffold eats an edit.

**Nothing here is prompted under `--json`, or without a TTY.** Not the names, not the credentials, not the domains, not the alias. A CI run scaffolds with the flags it was given and writes no `cloudflare` block; `pithy doctor` names the missing credentials until they are set.

While nothing under `@pithy-sh/*` is published, the scaffolded Worker declares no kit dependency — a range naming a version no registry has would break your very next install. `init` says so at the end and tells you to link the kit from a checkout instead.

## `--json`

One line, one object.

```
$ pithy init --name replay --worker board --json
{"command":"init","targetDir":"/home/you/replay","appName":"replay","worker":"board","domains":null}
```

| key | type | meaning |
|---|---|---|
| `command` | `"init"` | The command that produced the line |
| `targetDir` | string | The absolute directory the project was scaffolded into — `--dir` resolved against the working directory |
| `appName` | string | The project name written into the root `pithy.config.ts` as `name`. From `--name`, or the target directory's basename |
| `worker` | string | The first Worker's `apps/` directory. What `--worker` accepts, and what `--worker` on later commands names |
| `domains` | object or `null` | Where that Worker answers, per environment, or `null` when none was declared. **Always `null` under `--json`**, because declaring a domain is a prompt and `--json` never prompts |
| `domains.staging` | object | Where the Worker answers in `staging`, if it has a domain yet |
| `domains.staging.pattern` | string | The hostname, e.g. `api.example.com`. A bare hostname, not a URL — that is what wrangler's route matcher takes |
| `domains.staging.zone` | string | The Cloudflare zone the pattern sits under, e.g. `example.com`. Cloudflare needs it to attach a custom domain, and it is not always derivable from the hostname |
| `domains.prod` | object | Where the Worker answers in `prod`, if it has a domain yet |
| `domains.prod.pattern` | string | The hostname, as above |
| `domains.prod.zone` | string | The zone it sits under, as above |

`domains` is reported with the shape it takes in `pithy.config.ts` so that a `--json` consumer and a hand-written config describe the same thing. Both environment keys are optional: a project with staging wired and production not is legitimate. `dev` is absent by design — local runs answer on `http://localhost:<port>` from the port pinned in `.dev.config.json`.

The `--json` line carries no `cloudflare` block. The account's nickname and id go into `pithy.config.ts`, and the credentials go outside the repository; neither is echoed, because a token in a terminal is a token in a scrollback and a CI log.

## Errors

Each one is a `PithyError`: the problem, then the action. Under `--json` it is a single `{"error":{…}}` line on stderr and exit 1.

**Something `init` would write is already there.** The collision list names every path, sorted.

```
$ pithy init
/home/you/replay already has .gitignore, apps/board, package.json, pithy.config.ts, tsconfig.json, ….
Move those aside, or pick a directory without them. Run pithy init again.
```

**A Worker name that is not kebab-case.** Validated before any path is built out of it.

```
$ pithy init --worker "Bad Name"
Worker name must be kebab-case (got "Bad Name").
Use lowercase words joined by hyphens, e.g. api or admin-api.
```

**A project name over 26 characters.** The name sits at the front of every Cloudflare name the project composes, and a provisioned project cannot be renamed, so the limit is enforced at the scaffold rather than at the first `provision`. `docs/NAMING.md` derives the number.

```
$ pithy init --name this-is-a-really-long-project-name
"this-is-a-really-long-project-name" is 34 characters. A project name stops at 26.
Shorten `name` in pithy.config.ts to 26 characters or fewer.
```

**A symlink or a non-directory in the way.** Refused at every segment of the path, rather than left to die on a raw `ENOTDIR` with the run half-written.

**A name in the reserved test namespace.** Refused before anything is written — the debris reaper deletes on that prefix alone.

**A cancelled prompt.** `Cancelled.` on stderr, exit 1. Nothing proceeds on a value you did not choose.

## Examples

Scaffold into the current directory, answering the prompts.

```
$ pithy init
One project per set of apps that share users or data. Another app? Add a worker, not a project.
The name leads every Cloudflare resource this project provisions. Changing it later orphans them.

Project name: replay
First worker (apps/<name>): board
…
Done.

Want a shortcut? Type `p.` instead of `pithy`.
```

Answering yes installs the alias silently — its own `Added …` and `Reload your shell …` lines are the only output. See `pithy alias`.

Scaffold headlessly. Both names given, so nothing is asked.

```
$ pithy init --name replay --worker board --json
{"command":"init","targetDir":"/home/you/replay","appName":"replay","worker":"board","domains":null}
```

Scaffold into a directory that does not exist yet. It is created.

```
$ pithy init --name relay --worker deck --dir apps-relay
```

The project name and the Worker name are different things, and it is worth keeping them different. `replay` is the project; `board` is one of its Workers; the Worker deploys as `replay-board`, and `staging` suffixes that again. Add the next Worker with `pithy worker add`, not a second `pithy init`.
