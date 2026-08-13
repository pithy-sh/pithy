# pithy doctor

Report toolchain state and update status, plus — inside a project — each Worker's config, binding, and migration health.

## Synopsis

```bash
pithy doctor [--worker <name>] [--offline] [--enable-notifier | --disable-notifier] [--json]
```

## Flags

| Flag | Meaning |
|---|---|
| `--worker <name>` | Check only this Worker. Default: every Worker under `apps/`. |
| `--offline` | Use no ambient credentials and make no network call. `PITHY_OFFLINE=1` says the same thing to every command. Carries no default, so the variable can answer. |
| `--disable-notifier` | Turn off the update notifier, persisted in the state file. Default `false`. |
| `--enable-notifier` | Turn the update notifier back on. Default `false`. |
| `--json` | Machine-readable output — one line, one object, the same exit code. Default `false`. |

## What it does

`pithy doctor` is the user-initiated health check. It bypasses the 24-hour cache, performs a fresh registry query, and reports the full environment state:

```
$ pithy doctor

pithy 1.2.0 (installed via bun)
Update available: 1.3.0
Run: bun update -g @pithy-sh/cli

Shell: zsh (~/.zshrc)
Alias: installed (`p.` → `pithy`)

Config dir: ~/.config/pithy
State file: ~/.config/pithy/state.json
Dev login:  ~/.config/pithy/acme/dev.json — none yet; sign-in stays magic-link only
Secrets:    ~/.config/pithy/acme/secrets.jsonc (run `pithy secrets edit`)
Notifier:   enabled (PITHY_NO_UPDATE_NOTIFIER to disable)

Project: pithy.config.ts found
Project capabilities:
  @pithy-sh/core         1.2.0 ✓
  @pithy-sh/auth         1.1.8 (1.2.0 available — run `pithy upgrade`)
  @pithy-sh/leaderboard  1.2.0 ✓

Project health:
  api:
    prereqs      every composed capability has its peers ✓
    config       parses against every capability schema ✓
    bindings     MEDIA_BUCKET (r2) missing from wrangler.jsonc
                 env: staging, prod
    migrations   2 pending — run: pithy migrate --env dev
    entitlements no gated route without a provider ✓
  collab: healthy ✓

Cloudflare: reachable (token active)

Project name: acme — every resource name matches

OS:      macOS 14.5
Runtime: Bun 1.2.4 (Node 22.10.0 compat)
```

The **`Project health`** block is `pithy upgrade`'s manifest-versus-wiring comparison in read-only mode —
one engine, two commands: doctor reports drift, upgrade fixes it. It is reported **per Worker**, since each
Worker under `apps/` carries its own `pithy.config.ts` and `wrangler.jsonc` and so drifts independently; a
healthy Worker collapses to one line, and the whole block is omitted when every Worker is healthy. **Doctor
exits non-zero when any Worker fails a check**, so CI can gate on it. Nothing else in the CLI tells you a
required binding is missing before deploy does.

The **`migrations`** line asks the question in **both directions**, and the second one is why it exists. A
migration this project declares that the environment's database has not applied is `N pending`, and `pithy
migrate` is the remedy. A migration the database has *applied* that the project no longer declares is a
different fault with a different remedy — and it is invisible to a pending count, because nothing is
missing, so nothing is pending. That state stops the migrator dead: Kysely reads an applied migration its
registry does not carry as a corrupted chain and applies nothing. So doctor called a database healthy that
`pithy migrate` refused to touch, which is the whole of #282.

```
Project health:
  api:
    prereqs      every composed capability has its peers ✓
    config       parses against every capability schema ✓
    bindings     all required bindings present ✓
    migrations   DB records 0250_audit_0002_tenant. This project no longer declares it.
                 Nothing migrates until the ledger and the declaration agree. This is the local dev store, so wiping it is cheap: delete .wrangler/state, then run pithy migrate --env dev again.
    entitlements no gated route without a provider ✓
```

Both halves fail the exit. The remedy names which case applies rather than leaving it to be guessed,
because the tool knows: `dev` is the Miniflare store under `.wrangler/state` and throwing it away costs a
re-migrate, while a deployed environment is a database with real rows in it, where the same advice would be
data loss. There the line says to restore the migration or remove its `pithy_migrations` row. It is the
same sentence `pithy migrate` refuses with — one wording, two commands, so the two can never disagree about
one database again. In `--json` the check carries `pending` and `undeclared`, the latter one entry per
migration with its `database`, `binding` and `name`.

The block's first per-Worker line is **`prereqs`**, and it is the only check here that is not drift. A capability's manifest declares the capabilities it composes against — `auth` declares `secrets` and `email`, `email` declares `secrets` — and `createBackend` refuses to assemble without them. So a Worker failing this line does not start at all, and every other line below it is describing a Worker that is down. It is reported first for that reason.

```
Project health:
  api:
    prereqs      auth requires secrets — run: pithy add secrets
                 auth requires email — run: pithy add email
                 This worker will not boot until they are composed.
```

Like the entitlement gap, it reports and does not fix: `pithy upgrade` writes bindings and config keys, and composing a capability is a different kind of decision. `pithy add auth --with-prerequisites` is the command that makes it. It fails the exit, because this was the state `pithy add auth` used to leave behind — and doctor called that project healthy, which is how it reached `pithy dev` to be found there instead.

The block opens with a **`manifests:`** section when an installed `@pithy-sh/*` package ships a `pithy.manifest.json` that will not parse or will not validate. It sits above the Workers, and outside all of them, because that is where the fault is: manifests resolve once from the project root, so no Worker owns one — and a capability nobody can read contributes no drift to any check underneath it. Without this section a project full of unreadable manifests read as healthy and said nothing at all. It names the package and the reason, it **fails the exit** like every other check here, and it is the one finding in the block `pithy upgrade` cannot act on: the file belongs to someone else's package, so the fix is a reinstall or a word with its maintainer.

```
Project health:
  manifests:
    @pithy-sh/leaderboard: malformed pithy.manifest.json — reinstall it, or tell its maintainer
      configOptions[0].key: not a bare identifier
  api: healthy ✓
```

The **`Alias:`** line has three states, not two: installed, not installed, and **unknown** — because the rc file it reads may not open. A wrong mode, a dangling symlink, an `EIO`: the read used to throw and take the entire report with it, so the least important line here cost Cloudflare reachability, the secrets paths, project health and dev secrets. Catching it to `not installed` would have been worse than the crash — it is a claim about a file nothing could read, and the adopter's next move on reading it is `pithy alias`, which fails on the same file. So the third state says what it is and names the file:

```
Alias: unknown — can't read ~/.zshrc. Fix that first; `pithy alias` reads the same file.
```

It keeps the report verbose, because "I could not check" is worth the ink, and it never fails the exit — toolchain state does not. In `--json` the field is an object: `state` (`installed`, `not-installed`, `unknown`), `rcPath` (absolute, `null` when no shell was detected), and `reason` (the refusal's own sentence, `null` on the two known states, and never a byte of the file's contents).

That is the rule the whole command is held to, and the rc read was the one place it was not: **one optional line's failure must not cost every other line.** Doctor discards every read failure it meets — an unreadable `wrangler.jsonc`, a `dev.json` that will not parse, a `.dev.vars` it cannot open — and it discards the *write* to its own notifier cache too, since a config directory that will not take a write is exactly the machine somebody runs `doctor` on. A diagnostic has to work in the environment it diagnoses.

The **`Cloudflare:`** line answers "can I reach the account" — the bootstrap `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` pair, verified against Cloudflare rather than merely read (`docs/TOKENS.md`). A configured-but-broken credential fails the exit; an absent one does not, because a project that has not been provisioned yet is a legitimate state.

**Those credentials live in `<config>/cloudflare.json`, not in your repository.** They are functions of the *account*, not of a project: one account holds many Pithy projects, Cloudflare permits one Secrets Store per account, and a per-project home would keep one copy of the same token per project and make rotation an N-place edit. So `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `SECRETS_STORE_ID` and `R2_CREDENTIALS` sit in one file beside `state.json`, mode `0600` in the `0700` config directory. `pithy init` writes the pair at the one moment you are holding both — it needs the token to list your zones two prompts later — and skips the question when they already resolve. Nothing about them is in the checkout, so there is nothing to gitignore and nothing an `npm pack` can carry.

**One account per project, not one per machine.** That reasoning above is right and incomplete: it assumed you have one Cloudflare account. A developer working across two companies has two, and without saying which is which, every project on the machine reads the same file — so switching accounts means editing that file in place, **every project silently follows**, and the next deploy authenticates successfully against the wrong tenant with nothing anywhere disagreeing. So a project says which account it belongs to, in its root `pithy.config.ts`: `cloudflare: { accountName: "leed", accountId: "a1b2c3…" }`.

- **`accountName` selects the file.** `<config>/cloudflare.<name>.json`. Absent, the file is `cloudflare.json` exactly as before — nothing changes for a single-account machine, and there is nothing to migrate. It must be a **bare token**: lowercase letters, digits, and single hyphens. It becomes a file name in the config directory, which sits outside every checkout where no scaffold guard reaches it, so a path separator, `..`, an empty value, or a control character is refused by the config's own schema, naming the file and the value — not by whatever built the path.
- **`accountId` is a pin, and it is optional.** `cloudflare.leed.json` is a *local* file, so the nickname means whatever each machine says it means: two developers on one repository can both have that file and have it point at different accounts, and nothing in the repository would disagree with either of them. With the pin, the repository is the authority — every command that resolves credentials compares the resolved `CLOUDFLARE_ACCOUNT_ID` against it and **refuses on a mismatch, naming both ids and the file**, including when the id came from the environment rather than the file. That last case is CI configured for the wrong account, which is the one that deploys to production. An account id is an identifier rather than a secret — `wrangler.toml` commits them routinely — so it is safe in a repository, including a public one. It stays optional so a solo developer with one account is not made to paste an id, and it earns its keep the moment more than one person deploys.

`pithy init` writes all three at one moment — the credentials file, the `accountName`, and the pin — because that is the one moment they are both free and provably correct. It asks the token first, lists the accounts that token can see, and uses the account's own name, slugified, as the default nickname: one visible account is a confirmation, several are a picker, and choosing the account supplies both the id and the name. The id written is the one read from the account, never one typed twice. A slugified name goes through the *same* schema as a hand-typed one, and a name that slugifies to nothing is asked for rather than guessed at. A token too narrowly scoped to list accounts falls back to asking for the id, exactly as before. **A non-interactive `pithy init` writes no `cloudflare` block at all** and resolves `cloudflare.json`, unchanged: CI scaffolds projects and there is nobody to ask.

**The `Cloudflare:` line prints on every run, and names the file it resolved.** "Which account am I about to deploy to" must never require inspection — the same argument the `Secrets:` line is built on — and once a machine holds `cloudflare.leed.json` beside `cloudflare.other-co.json`, the state alone does not answer it. It used to be suppressed in the terse all-green report, which is exactly the run most likely to be followed by a deploy; a location is not a complaint, so it does not sit behind the not-healthy predicate. The path is tilde-abbreviated like every other path here. In `--json` the same three facts are their own fields — `configPath` (absolute, so a script can open it), `accountName`, and `accountMismatch` (`null` unless the pin disagrees) — alongside `state`, `missing`, `tokenStatus`, `credentialSplit`, `credentialSource` and `detail`.

A pinned account the credentials do not match is its own state: it names both ids, it fails the exit, and it is decided **before anything reaches the network**, so a wrong-account run never authenticates even to be verified.

**The line also says where the credentials came from — the file, or the environment.** Naming the resolved *file* is not the same claim, and the difference is the whole of it: CI has no file at all and authenticates from environment variables, so a report reading `; from ~/.config/pithy/cloudflare.json` was naming a path with nothing at it while a token from somewhere else did the work. An environment pair says so and names the file it did **not** read, because that file is what you were about to go and check. A pair split across both keeps the split warning below, which says which key came from where in more detail than this can. In `--json` it is `credentialSource` — `file`, `environment`, `mixed`, or `null` when neither key resolved.

**`PITHY_OFFLINE=1` means no ambient credentials and no network call.** Set it, or pass `pithy doctor --offline`, and Pithy stops reading `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` out of the environment, and `doctor` reports **not checked** instead of probing:

```
Cloudflare: not checked — offline (PITHY_OFFLINE or --offline); credentials would resolve from ~/.config/pithy/cloudflare.json
```

It never fails the exit — nothing was established, which is the same standard `not configured` is held to — and the two version lines say `Version check skipped (offline).` rather than blaming a registry nobody asked. An adopter on a plane gets a full report and a green exit. `--json` carries `offline` beside every other key, so a script can tell a skipped check from a passing one.

**Why it is a variable, and why `PITHY_CONFIG_DIR` does not imply it.** The variable bites in the one function every command resolves credentials through, so all of them are covered — a deploy, a migrate, a `token mint`, and both of `doctor`'s probes — and it is inherited by a spawned `pithy`, `wrangler`, or test runner, which a flag is not. `--offline` exists on `doctor` because "run the diagnostic without touching anything" is a thing you say once, at a prompt, and exporting a variable to say it is worse. Making `PITHY_CONFIG_DIR` imply the mode was considered and rejected: it conflates *read config from here* with *do not use the environment*, and CI legitimately means the first without the second — no file, credentials in the environment, on purpose. Two sentences, two ways to say them.

**What it does not touch is the credentials file.** A value in `<config>/cloudflare.json` was deliberately written there; a value in the environment is the one nobody in the room remembers exporting. So `PITHY_CONFIG_DIR=/tmp/scratch PITHY_OFFLINE=1` resolves *nothing at all*, which is the isolation people already believed the first variable gave them on its own — it never did, and a `pithy doctor` in an empty scratch directory reached a real account off a token exported hours earlier and called it `reachable (token active)`. Two variables, and now nothing in the CLI has a credential to authenticate with.

The same line warns when the pair **came from two places**. The overlay works per key, so a `cloudflare.json` that sets only `CLOUDFLARE_API_TOKEN` silently takes `CLOUDFLARE_ACCOUNT_ID` from whatever the shell exports — one account's token against another account's id, and nothing disagrees for anything to catch. What you get is a confusing 403, or an empty listing, at some much later call. Doctor names which key came from the file and which from the environment, and this one line is all it adds: an otherwise clean report stays terse. It checks that one source decided the pair, not that the pair is right — a complete file naming the wrong account is coherent, and coherent is all this can judge. Reported, never gated: the credentials may well work. A complete file, a shell exporting a different account's whole pair over it, and CI (which has no file at all) are all silent.

The **`Project name:`** line answers the next question: is what I would find there still mine. Every resource this project provisions leads with the root config's `name` (`docs/NAMING.md`), and teardown *recomputes* those names rather than scanning for them — so one edit to `name` orphans everything while every command keeps exiting 0. Doctor requires positive evidence before it says so, because `<app>-<env>-<resource>` is also the ordinary Cloudflare convention and a database you brought with you is not an orphan. Two states fail the exit: **drifted**, where the wiring contradicts the config wholesale (every declared name leads with one and the same other project, and the configured name appears nowhere — the only shape a one-string rename can leave), and **orphaned**, where a database's `pithy_migrations_owner` stamp proves Pithy created it under another project's name. Neither state ever advises deleting a resource. A single foreign name, a mix, an unset name, and an unreadable `wrangler.jsonc` all pass — none of them establishes anything.

The **`Dev login:`** line names the one config file that is per project rather than per machine: `dev.json`, the opt-in that makes `pithy seed` mint a real session instead of leaving you a magic link (`docs/SEED.md`). It sits with `Config dir:` and `State file:` because it answers the same question they do, and it is here because until recently it could not be: the file was resolved against a second, unrelated config root — and on Windows against no valid root at all — so this block named a directory that did not contain it and a developer whose dev login was not working looked there and found nothing. The line reports the resolved path whether or not the file exists, because where it *would* go is most of what anyone asking needs. **No file is not a fault** — magic-link-only is the documented default, and it never gates. A file that will not parse does, and so does one naming no user: `pithy seed` reads an unparseable `dev.json` as an absence, silently, so nothing else in the toolchain would ever mention it. It reports the user the file names and never claims that user is seeded — doctor runs no seed, so it has not established that, and the seed itself already refuses loudly on a name it does not create.

The **`Secrets:`** line names your dev secret values — `<config>/<project>/secrets.jsonc`, the file `pithy add` mints into, `pithy seed` reads, and every Worker's `.dev.vars` is generated from. **It is not in your repository, and that is the point.** `.dev.vars` has to sit in the worker's directory because wrangler reads it there; nothing but the CLI reads this one, so it lives outside every checkout — nothing to gitignore, nothing a `git add -A` can reach, nothing an `npm pack` can carry, and nothing an `rm -rf` on the working copy destroys. Delete the whole clone and the secrets are still there. Every worktree of one project resolves the same file with no setup step.

Because nothing in the project points at it, this line prints on **every** run whether or not the file exists — where it *would* go is most of what anyone asking needs, and there is no other way to find out. The directory is `0700` and the file `0600`, held there on every write.

**The line names the command as well as the path**, on the same rule the `Alias:` line follows when it offers `pithy alias`. A path outside the checkout is one no editor's file tree reaches and no `ls` in the project finds, so knowing it is not yet a way to open it — and this line is the only place in the toolchain positioned to say both.

The file is keyed on your `pithy.config.ts` `name`, so two unrelated projects sharing a name share one file, and renaming a project leaves the old directory behind with every value in it. Dev-only values, so this is friction rather than danger — but invisible friction, so when this project has no file and others do, the line names them: `no file yet; secrets exist for acme-old — a renamed project leaves its old name here`.

`PITHY_CONFIG_DIR` moves the whole config directory — state file, `dev.json` and `secrets.jsonc` together. Set it in CI, which has no home directory worth writing to, and in any harness that must not touch your real values.

The committed `.dev.secrets.example.jsonc` stays in the repository. It is documentation: the envelope format, and where the real file is.

**`pithy secrets edit` opens it.** Knowing the path is not the same as having a way to edit it, and "resolve it yourself and open it" is not a workflow. The command resolves the file, opens it in your editor, validates what comes back, and writes it atomically at `0600`.

A symlink from the project would have done the first half and is the one thing that must not happen: a link puts the file back in the field of view of every tool that follows one — `tar`, backup software, a Docker build context, `npm pack`. It also cannot do the second half. A malformed `secrets.jsonc` breaks every later command, and catching it while you still remember what you typed is worth more than the convenience.

- **The editor is `$VISUAL`, then `$EDITOR`, then `notepad` on Windows and `nano` (else `vi`) elsewhere.**
- **An editor that opens a window and returns is refused by name, with the flag to add**: `code --wait`, `subl --wait`, `gvim -f`. Without it, the command would validate a file you have not touched yet and report success while you are still typing.
- **A malformed edit is reported and handed straight back to you, with your text intact.** Nothing is written until it parses and validates, and nothing you typed is ever discarded — the value in front of you may be the only copy of it that exists. An edit that cannot be saved is kept in a file beside the real one, and the error names it.
- **Without a terminal it refuses and prints the path**, rather than hanging on an editor nothing will close. That is CI, and it is the one place this command has nothing to offer.
- **It prints a path and a count. Never a name, and never a value** — including when validation fails. `pithy secrets ls` is what lists names.

A **`Dev secrets:`** block appears when something about this project's dev values is wrong. The block *is* the finding — a project whose values are where they belong prints no line saying so. It answers for two files that look alike and are not the same file at all:

| | |
|---|---|
| `<root>/.dev.vars` | Hand-written, and **nothing reads it any more**. The CLI read `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `SECRETS_STORE_ID` and `R2_CREDENTIALS` out of it until those moved to `<config>/cloudflare.json`. No Worker ever read it. |
| `<root>/apps/<worker>/.dev.vars` | **Generated**, one per Worker. Read by wrangler, and so by the Worker. Built from the dev secrets file and this machine's `dev.json`. |
| `<root>/.dev.vars.<env>` | A minted credential the old `pithy token mint --store dev-vars` left in the checkout, one per environment. Nothing writes one now; a minted token goes to `<config>/<project>/tokens.json`. |

Nine things get a line, and every one of them names an absolute path rather than a convention:

- **A Worker whose `pithy.config.ts` will not import.** The line names the Worker and why, and it comes first, because it explains every line under it. A registry nobody could read is not a Worker that declares nothing, and the difference decides what the rest of this block may say: `doctor` used to answer both states with an empty target list, so the whole `Dev secrets:` block disappeared in the one state it was written for. A diagnostic that dies on what it is diagnosing is worse than one that names it.

- **A `.dev.vars.<env>` still in the checkout.** It holds a credential minted for that environment — a live production Cloudflare token, in the worst and most ordinary case. The line names the file and the environment. Gitignored is not enough: `npm pack` does not read `.gitignore` when `files` is set.
- **A registry secret still copied into `<config>/<project>/dev.json` under `"vars"`.** `pithy seed` used to make that copy and the generator used to read it; the generator reads `secrets.jsonc` directly now, so nothing reads the copy. A value there that *no* registry declares — a Turnstile sitekey — is a legitimate tenant of that file and says nothing.
- **A Worker whose generated file has a header and no values.** That Worker starts with none of its bindings and answers every request with `Missing required bindings: …`; before this, that 500 was the only thing that ever said so.
- **A Cloudflare credential in the root `.dev.vars`.** Account-scoped, so it belongs in `<config>/cloudflare.json` — the line names that path. Never described as deletable: the value is live.
- **A registry secret sitting in the root `.dev.vars`**, whatever its backend. It is inert there — dev reads a `d1` secret from the seeded store and a `cf-secrets-store` one from the generated file — so the line says which file the value belongs in and in what shape.
- **A key in the root `.dev.vars` that a Worker needs as a binding.** Real value, wrong file, and never described as deletable.
- **A key nothing reads at all** — not a Cloudflare credential, not a registry secret, not declared by anything this project composes. That one can go.
- **A key nobody could classify**, because a Worker's config would not import. It is named, and nothing else is claimed about it. "Nothing reads it, delete it" is a *negative* claim, and the registry that would have settled it is exactly the one that could not be read — so that sentence is withheld until it can be made. The three verdicts above it survive a partial read, because each rests on positive evidence: a fixed credential list, a registry that did declare the name, a composition that does want it.

And one more, from the neighbouring `Dev secrets:` lines: **a project with no `SECRETS_ENCRYPTION_KEYS` at all** is told to run `pithy add secrets`, which mints one into `secrets.jsonc`. It is the one declared secret nobody outside the project issues, and until it exists the local `SECRETS` store cannot be opened.

Reported, never fixed, and it never fails the exit. Every project that predates the generated file is in this state by definition, and an upgrade that turns a green `pithy doctor` red in CI over a file that still worked yesterday is a surprise rather than a diagnosis — and rewriting somebody's `.dev.vars` for them is worse than either. It does make the report verbose: a Worker that cannot start is worth the ink.

Each of those lines names the command that performs the move — `pithy adopt` (`docs/commands/adopt.md`). Doctor still never performs it: `adopt` is asked for, prints its plan first, and deletes nothing.

The two name lines appear in the verbose report only, with the one exception above — a split credential pair prints its `Cloudflare:` line without making the rest of the report verbose. A clean pass on each is otherwise a precondition of the terse form, so their absence below is the report saying they passed.

An **`Environments:`** block appears when a Worker's `env.<name>` stanzas stop agreeing with the environment set the root `pithy.config.ts` declares. It leads with the declared set, then names each disagreement per Worker. Three faults, three remedies:

- **`undeclared`** — the Worker has a stanza for an environment the project does not declare. Nothing was provisioned under it; add it to `environments`, or remove the stanza.
- **`missing`** — the project declares an environment this Worker has no stanza for. That Worker cannot deploy there, and `pithy add <capability>` will bind every other environment and not this one.
- **`orphaned`** — the same undeclared stanza, but carrying resource **ids**. Resources exist under a name the project no longer claims. `<project>-<env>-<thing>` is recomputed and never stored, so changing a declaration does not rename a database: it orphans it, exactly as renaming `name` does. The report names the ids and stops; only you can say whether to restore the declaration or delete them in Cloudflare.

It **fails the exit**, on the same standard the two blocks below it meet: the contradiction is between this repo's own config and its own wiring, established from local files alone with no account consulted. A stanza whose bindings carry no ids is read as *not provisioned* rather than as broken — that is the shape every project scaffolded before the declaration existed is in.

A **`Secret bindings:`** block appears when a declared environment's `wrangler.jsonc` stanza does not bind a `cf-secrets-store` secret that Worker reads. It is the deployed half of the block above: `Dev secrets:` is about the machine-local file, this is about the stanza a Worker boots against in staging or prod. One line per Worker and environment — `board env.staging binds no CONNECTION_KEY_ENCRYPTION_KEY, SECRETS_ENCRYPTION_KEYS.` — because one command answers all of them.

`pithy add` deliberately cannot write a `secret` binding — the entry needs a `store_id` and a `secret_name` that do not exist until an account has been reached — and `pithy secrets provision` is the step that comes back and writes it. Nothing said so, and a Worker deployed without `SECRETS_ENCRYPTION_KEYS` answers its first request with `Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS`. This line is what says it before the deploy.

It reads files only and never asks the Secrets Store: whether an *entry* exists is provisioning's question, and a declared secret whose entry has not been written is reported rather than bound, because wrangler refuses a config naming an absent entry. **`dev` never appears** — not by being filtered, but because the environments walked are the ones the root `pithy.config.ts` declares, and local dev materialises these secrets into each Worker's generated `.dev.vars` instead. A `d1`-backed secret is a row rather than a binding and never appears either, and neither does a keyspace, which has no single entry to name. It **never fails the exit**: every project that composed `secrets` and has not yet provisioned is in this state, and that is a step not yet taken rather than a contradiction.

An **`Origins:`** block appears when an environment's named origins and its served origins do not line up. The invariant is one sentence in both directions — **every origin a Worker answers on is one its config names, and every origin its config names has something configured to serve it**. Every auth `baseURL`, OAuth callback, magic-link URL and CSRF allowed-origin is derived from the first half, so when it is missing each of them invents its own — and the dangerous invention is production's origin, which is how a staging deploy emails real users magic links into production. Three faults:

- **`no-origin`** — nothing states an address for this environment: no `domains` declaration, no `routes` pattern, no `vars.BASE_URL`. Declare `domains.<env>` in the Worker's `pithy.config.ts`, or set `vars.BASE_URL` in its `env.<name>` stanza. `domains` covers `staging` and `prod` only, so an environment you declared yourself takes the second route.
- **`unserved-origin`** — an origin *is* named and **nothing in the config serves it**: no `routes` pattern in that `env.<name>` stanza covers the host. The Worker answers at no address at all. A `domains` block written by hand is how this happens — only `pithy init`, `pithy worker add` and `pithy worker sync` write the route it implies — and `"workers_dev": false` beside it, this command's own remedy for the fault below, closes the last thing that was serving. Run `pithy worker sync` to write the route from the declaration; an origin named by `vars.BASE_URL` instead was generated from nothing, so its `routes` entry is yours to write. The mirror image is the same fault: a named `workers.dev` origin with `"workers_dev": false` is also served by nothing.
- **`workers-dev-open`** — an origin *is* named and served, and the Worker also answers on `<name>.<subdomain>.workers.dev`, which nothing decided about. Wrangler's `workers_dev` defaults to `true` and declaring `routes` does not change it; `preview_urls` then follows `workers_dev`, so every deployed version is reachable there too. On that second origin `BASE_URL` names the other host, the CSRF same-origin gate refuses the requests that establish who you are, and nothing bound to the hostname — a WAF rule, an Access policy, a rate limit — applies. Set `"workers_dev": false` in `env.<name>`, or `"workers_dev": true` to say you meant both.

One fault per Worker and environment, and `unserved-origin` comes first: a Worker reachable nowhere makes the question of a second origin moot, and `pithy worker sync` writes the route and the `workers_dev` decision together anyway.

`unserved-origin` and `workers-dev-open` both **fail the exit**. Each is a contradiction between this repo's own config and its own wiring, established from that config alone. `no-origin` is the state every project is in before it has a domain, which is legitimate and universal — failing it would turn `pithy doctor` red on day one for everyone. It is reported, it makes the report verbose, and `pithy deploy --env <name>` is what refuses it, at the moment it stops being hypothetical. `pithy init` and `pithy worker add` write the route and `"workers_dev": false` beside every domain they declare, so a project that answers the domain question never reaches any of the three.

A **`Workflows:`** block appears when an environment's `wrangler.jsonc` stanza does not bind what its Worker's `app` capability declares. The invariant is one sentence — **what the app declares is what the stanza binds** — and it is asked as one comparison of the whole table rather than as a list of the ways the two can differ, because the list is what goes stale. `reconcileAppWorkflows` derives the `workflows` entries and `triggers.crons` from the declaration and `pithy worker sync` is its only caller, so a job declared and never synced ships with neither. Two faults:

- **`unsynced-stanza`** — the declaration and the stanza are not the same table. A declared job the stanza does not bind, a binding the declaration no longer names, a cron either way, or a binding carrying another environment's Workflow name: one fault, because there is one remedy. Run `pithy worker sync`.
- **`unwritable-declaration`** — the declaration cannot be reduced to a stanza at all, so no command could write one. A job with no `className` has no class for wrangler to instantiate; `reason` carries the refusal, which names the field. Fix `workflows` in the Worker's `pithy.config.ts` — `pithy worker sync` refuses it the same way.

Both **fail the exit**, and there is no day-one state to spare: a project that declares no Workflows has no drift to report. This is also the one fault in the report whose entire symptom is that **nothing happens** — an unsynced cron never fires, and no request fails, no log line appears and no probe goes red to say so. The line names both sides of the comparison, because the reader is being told about a table they believed already matched. A Worker whose `pithy.config.ts` will not import claims nothing, and a Worker with no `app` capability has no declaration to be held to. `pithy deploy --env <name>` refuses the same drift before anything is built.

A **`Capability extensions:`** block appears when a capability composed something an adopter passed into its config — a Better Auth plugin added through `auth({ plugins: [...] })` is the first of them. One line per extension, per Worker, naming the capability, the extension, and the tables it introduced.

It is the only block here that is **not a finding**. An extension is a deliberate act, so there is nothing to be wrong about, and it **never fails the exit**; `--terse` omits it for that reason. It prints because the alternative is silence: an extension has no `package.json` for `Project capabilities:` to read a name off, and it still adds routes to the Worker and tables to the database. A capability declares its own through `Capability.extensions`, so a new extension point anywhere is a line here rather than a new check.

A **`Worker names:`** block appears when a Worker's three names stop agreeing — its `apps/<dir>`, the deployed script name in its `wrangler.jsonc`, and its `vars.WORKER`. It is the hand-rename check: `git mv apps/api apps/board` and one forgotten edit leaves a Worker deploying under one name and stamping its audit events with another, and nothing else in the toolchain notices. Shown per Worker, one line per stamp that disagrees, and it **fails the exit** — the contradiction is between this repo's own directory and its own config, so it is established from local files alone and no account is consulted. Held to the same evidence bar as `Project name:`: a script name that was never composed from `<project>-<worker>` was brought in from somewhere, not renamed, and passes. `pithy worker rename` (`docs/commands/worker.md`) is what moves all three at once.

## `--json`

**`--json` mirrors every block above**, because an agent cannot read aligned columns. One line, one object, and the same exit code:

```
$ pithy doctor --json
{"cli":{"installed":"1.3.0","latest":"1.3.0","installer":"brew","state":"current","upgradeCommand":"brew upgrade pithy"},"shell":"zsh","alias":{"state":"installed","rcPath":"/Users/jo/.zshrc","reason":null},"configDir":"/Users/jo/.config/pithy","stateFile":"/Users/jo/.config/pithy/state.json","notifier":"enabled","offline":false,"project":{"present":true,"capabilities":[{"name":"@pithy-sh/core","installed":"1.2.0","latest":"1.2.0","state":"current"}],"health":{"ok":true,"workers":[{"worker":"api","ok":true,"config":{"ok":true,"drift":[]},"bindings":{"ok":true,"missing":[]},"migrations":{"ok":true,"pending":0,"undeclared":[],"env":"dev"},"entitlements":{"ok":true,"gates":[]},"prerequisites":{"ok":true,"missing":[]}}],"manifests":{"ok":true,"faults":[]}}},"cloudflare":{"state":"ok","missing":[],"tokenStatus":"active","credentialSplit":null,"configPath":"/Users/jo/.config/pithy/cloudflare.leed.json","accountName":"leed","accountMismatch":null,"credentialSource":"file","detail":"reachable (token active); from ~/.config/pithy/cloudflare.leed.json"},"projectName":{"state":"ok","project":"acme","misnamed":[],"detail":"acme — every resource name matches"},"workerNames":{"state":"ok","mismatches":[]},"environments":{"state":"ok","declared":["staging","prod"],"drift":[]},"origins":{"state":"ok","drift":[]},"workflows":{"state":"ok","drift":[]},"extensions":{"extensions":[{"worker":"api","capability":"auth","kind":"better-auth-plugin","id":"organization","tables":["organization","member","invitation"],"detail":"auth: organization (better-auth-plugin), tables organization, member, invitation."}]},"devPreferences":{"state":"absent","path":"/Users/jo/.config/pithy/acme/dev.json","user":null,"detail":"none yet; sign-in stays magic-link only"},"devSecretsFile":{"path":"/Users/jo/.config/pithy/acme/secrets.jsonc","present":true,"orphans":[]},"devSecrets":null,"secretBindings":null,"devVarsLocal":null,"devVars":null,"os":"macOS 14.5","runtime":{"name":"Bun","version":"1.2.4","nodeCompat":"22.10.0"},"node":"22.10.0"}
```

Three rules hold across the payload. **Paths are absolute here, never tilde-abbreviated** — this output is opened by a script, not recognised by a human. **A check with no project to run against is `null`, not an empty verdict**: `project`, `projectName`, `workerNames`, `environments`, `origins`, `workflows`, `devPreferences`, `devSecretsFile`, `devSecrets`, `secretBindings`, `devVarsLocal` and `devVars` all take that shape, so nothing ever reports a name verdict for a directory that has no config. And **every finding carries its own `detail` sentence** beside its fields, so an agent fixing one never has to reproduce the report's wording from the parts.

`project.health.manifests` is the `manifests:` block above, and it is project-wide rather than per Worker for the same reason. `devSecrets.mode` is octal-formatted (`600`), because `384` is not a permission anybody recognises. **`devSecrets.healthy` is the field to gate on.** It is every fault in that block, decided by the same function the text report draws its lines from, so a script never has to enumerate fault names — and a fault class added later needs no consumer to be updated. `devSecrets.unreadable` is the loader's own sentence for a file that will not parse, or `null`; it was a boolean once, so a gate written as `unreadable === true` stopped firing the day it became a sentence. `devSecrets.malformed` names each stated value that will not read and why, and `devSecrets.bootstrapMissing` the bootstrap secrets nothing has minted yet. `devSecrets.unresolvable` and `devVars.unresolvable` are the Workers whose `pithy.config.ts` would not import, each naming the Worker, its directory and the reason — a `devSecrets` object carrying one is how a script tells "nothing loaded" from the `null` that means this project composes no secrets. `runtime` is the interpreter that ran, `node` the version it emulates — equal on Node, different under Bun.

| key | type | meaning |
|---|---|---|
| `cli` | object | The installed version, the latest known, the detected installer, the state, and the command that upgrades it. |
| `shell` | string \| null | The detected shell, `null` when none was. |
| `alias` | object | `state` (`installed`, `not-installed`, `unknown`), `rcPath` (absolute, `null` when no shell was detected), and `reason` (the refusal's own sentence, `null` on the two known states). |
| `configDir` | string | The config directory. |
| `stateFile` | string | The notifier state file. |
| `notifier` | string | `enabled` or `disabled`. |
| `offline` | boolean | Whether this run refused ambient credentials and the network. |
| `project` | object \| null | `present`, then either `loadError` or the project's `capabilities` and `health`. `null` outside a project. |
| `cloudflare` | object | `state`, `missing`, `tokenStatus`, `credentialSplit`, `configPath`, `accountName`, `accountMismatch`, `credentialSource`, `detail`. |
| `projectName` | object \| null | `state`, `project`, `misnamed`, `detail`. |
| `workerNames` | object \| null | `state`, and one `mismatches` entry per stamp that disagrees, each carrying its own `detail`. |
| `environments` | object \| null | `state`, `declared` (the set the root `pithy.config.ts` names, in declaration order), and one `drift` entry per Worker-and-environment that disagrees — `kind` is `undeclared`, `missing`, or `orphaned`, `resources` names the ids found under an orphan, and each entry carries its own `detail`. |
| `origins` | object \| null | `state`, and one `drift` entry per Worker-and-environment whose named and served origins disagree — `fault` is `no-origin`, `unserved-origin` or `workers-dev-open`, `origin` is the one the config does name (`null` when it names none), `source` (on `unserved-origin` alone) is where it was named: `declaration`, `route` or `var`. Each entry carries its own `detail`. |
| `workflows` | object \| null | `state`, and one `drift` entry per Worker-and-environment whose declaration and stanza are not the same table — `fault` is `unsynced-stanza` or `unwritable-declaration`, `declared` and `bound` are the two sides of the comparison (`workflows` entries and `crons`), and `reason` (on `unwritable-declaration` alone) is why the declaration could not be reduced to a stanza. Each entry carries its own `detail`. |
| `devPreferences` | object \| null | `state`, `path`, `user`, `detail` — the `dev.json` this project resolves. |
| `devSecretsFile` | object \| null | `path`, `present`, `orphans` — the dev secrets file, reported whether or not it exists. |
| `devSecrets` | object \| null | The dev-secrets findings. `healthy` is the one field to gate on; `mode` is octal-formatted, `malformed` names each stated value that will not read, `unresolvable` the Workers nobody could read. |
| `secretBindings` | object \| null | `state` (`ok`, `could-not-check`, `unbound`), one `missing` entry per Worker-and-environment-and-`binding` that a declared environment does not bind, and a `detail` line per Worker-and-environment. `null` when no Worker composes `secrets`. |
| `devVarsLocal` | object \| null | The root `.dev.vars.local` classification, with its `detail`. |
| `devVars` | object \| null | The root `.dev.vars` classification — the whole classification, names only, never a value. |
| `os` | string | The operating system and its version. |
| `runtime` | object | `name`, `version`, and `nodeCompat` — the interpreter that ran. |
| `node` | string | The Node version it emulates. Equal to `runtime.version` on Node, different under Bun. |

## Errors

Nothing here refuses except a contradiction between two flags: `pithy doctor` is a report, and what it finds is carried in the exit code rather than in a throw. A diagnostic has to work in the environment it diagnoses, so every read failure it meets is discarded into a line — including the write to its own notifier cache.

| Condition | Effect |
|---|---|
| `--disable-notifier` and `--enable-notifier` together | Refused before anything is read: *Pass either --disable-notifier or --enable-notifier, not both.* |
| A `pithy.config.ts` that will not load | Exit 1. |
| A Worker failing a config, binding, migration, or entitlement check, or a manifest nothing can read | Exit 1. |
| A Cloudflare credential that is configured and broken, or a pinned account the credentials do not match | Exit 1. `not configured` and `not checked` establish nothing, so neither gates. |
| A project name that is `invalid`, `drifted`, or `orphaned` | Exit 1. |
| A Worker whose three names disagree | Exit 1. |
| A `dev.json` that will not parse, or that names no user | Exit 1. No file at all is the documented default and never gates. |
| Toolchain state — the CLI version, the shell, the alias, the `Dev secrets:` findings | Never fails the exit. |

## Examples

When everything is up to date, the output is correspondingly terser:

```
$ pithy doctor

pithy 1.3.0 (installed via brew)
Up to date.

Shell: zsh
Alias: installed

Secrets: ~/.config/pithy/acme/secrets.jsonc (run `pithy secrets edit`)

Project: pithy.config.ts found
Project capabilities: all up to date

Cloudflare: reachable (token active)

OS:      macOS 14.5
Runtime: Bun 1.2.4 (Node 22.10.0 compat)
```

The **`Secrets:`** line survives into the terse report, and it is the only one that does. Every other line above reports a fault, and terse is the report saying there is none; this one reports a *location*, and "where is my dev secrets file" is a question, not a complaint — asked most often by the developer whose project is working fine. It stands on its own there, unpadded, because there is no `Config dir:` beside it to align against.

`Runtime:` names the interpreter actually executing. Under Bun, `process.versions.node` is the Node version being emulated, so reporting it alone would name a runtime that is not running — the one thing a diagnostic must not do. On Node it reads `Runtime: Node 22.10.0`, with no compat suffix.

Outside a Pithy project directory, the `Project:` line states the one fact — there is no `pithy.config.ts` here, so run `pithy init` or change to a project directory — and every other project line is omitted, `Project name:` included. With no project there is no name to reconcile, and a second line answering that question is how doctor came to advise adding a key to a file that does not exist. The exit stays 0 and the report stays terse when the toolchain is clean: checking the CLI version, the shell, or the alias from anywhere is legitimate, and someone doing it is asking about their toolchain, not their project.

```
$ cd /tmp && pithy doctor

pithy 1.3.0 (installed via brew)
Up to date.

Shell: zsh
Alias: installed

Project: no pithy.config.ts here — run `pithy init`, or change to a project directory

Cloudflare: reachable (token active)

OS:      macOS 14.5
Runtime: Bun 1.2.4 (Node 22.10.0 compat)
```

The `Cloudflare:` check still runs there, and it is the one check that never needed a project: the credentials are account-scoped and read from `<config>/cloudflare.json`, so "are my credentials right" has the same answer in every directory on the machine — worth answering before `pithy init` as much as after.
