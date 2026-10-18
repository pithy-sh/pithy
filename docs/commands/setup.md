# pithy setup

_The site renders this for readers: [pithy.sh/docs/cli/commands/setup](https://pithy.sh/docs/cli/commands/setup). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` and `packages/cli/src/setup.e2e.test.ts` hold the code to it — so it stays here._

Make this checkout ready to develop, whatever state it is in. Dev only.

## Synopsis

```bash
pithy setup [--skip-install] [--dry-run] [--json]
```

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--skip-install` | `false` | Leave the dependencies as they are. Every other step still runs |
| `--dry-run` | `false` | Print every step it would take, and write nothing |
| `--json` | `false` | One line, one outcome. Never prompts, because nothing here asks |

## What it does

A fresh clone of a Pithy project is two commands from running:

```bash
pithy setup
pithy dev
```

The same two for the first clone and the fifth. `pithy setup` takes these steps, in order, and each one does only what is missing:

1. **Install.** The project's own package manager, read from its lockfile, against that lockfile: `bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `npm ci`. Setup never rewrites a lockfile. A project with none yet — the one `pithy init` just made — is installed by the manager that launched `pithy`, or by Bun when `pithy` runs under it, and that install writes the first lockfile. Commit it.
2. **Check the project.** The root `pithy.config.ts` parses and names the project. Every Worker's `pithy.config.ts` loads, which is every capability it composes being installed. Every composed capability has the peers its manifest declares. A failure stops the run here, before any later step writes, and names every problem it found.
3. **Mint the local secrets the kit can mint.** The dev master key, and every secret a capability gives a dev value — a session secret, a link-signing key — into `<config>/<project>/secrets.jsonc`, each only when the file lacks it. Every checkout of one project on a machine reads that one file, so the fifth clone reuses what the first minted. A key a project from before #154 kept in `.dev.vars` is carried over, never replaced. `pithy.config.ts` is never touched, which is what makes this not `pithy add secrets`: that command composes a capability, and a clone already has it composed.
4. **Migrate dev.** The local database, the same run `pithy migrate` makes.
5. **Do what `pithy dev` does before it starts anything.** Pin a port for every Worker and capability host in `.dev.config.json`, from the machine's port registry. Generate each Worker's `.dev.vars`. Seed the dev secrets into the local `SECRETS` store. Nothing is started.
6. **Seed dev, only into an empty database.** A database that holds rows is left alone, and the run names the table. Retained tables — the secrets vault, a suppression list — never count: their rows are never what a fixture writes. `pithy seed --env dev --redo` stays the way to reset, and it asks first.
7. **End with what it cannot do.** Each secret somebody else issues — an OAuth app, a payment sandbox, a Turnstile key — named with `pithy secrets edit`, which opens the file it goes in. Then `pithy dev` as the next step.

A second run changes nothing and says so: `Already set up. Nothing changed.`

### Dev only, without exception

Setup never resolves Cloudflare credentials, never makes a call to an account, and never reads or writes `staging` or `prod`. No flag widens it. A teammate who only builds features never signs in to Cloudflare to run the app on their own machine. Staging and production stay with `pithy provision`, `pithy secrets provision`, `pithy migrate --env` and `pithy deploy`, which are a person's decisions.

One seed is out of its reach: a fixture that uploads media to Cloudflare Images or Stream, which have no local emulation. A project whose seed carries one is not seeded by setup, and the run says so. `pithy seed --env dev` uploads it.

### It never starts `pithy dev`

Setup finishes and exits. `pithy dev` runs until it is stopped. Folding them together would leave setup unscriptable and CI waiting on a server, so setup leaves no process running and names `pithy dev` as the next step.

### `--dry-run`

Prints every step: the install line, each secret it would mint and where, each migration, each file it would write, what it would seed. It writes nothing — not the secrets file, not `.dev.config.json`, not the machine's port registry, not the local store.

On a clone with nothing installed, the project's configs cannot load until the install has run, so nothing after the install can be planned. The dry run plans the install, says why it stopped, and exits 0. Only a config that will not load is read that way. Any other failure of the check — a missing peer, an unusable manifest, a missing `pithy.config.ts`, a root with no `name` — is the project's, not the install's, and stops a dry run exactly as it stops a real one.

### `pithy feature sync`

One implementation of ready. `pithy feature sync` reconciles its feature's port block, then runs every step here but the install, because the worktree was installed when it was created. A worktree and a clone cannot come to two answers about what ready means.

## `--json`

One line, one outcome.

```
$ pithy setup --json
{"command":"setup","schemaVersion":2,"outcome":"ready","dryRun":false,"project":"acme","install":{"packageManager":"bun","lockfile":"bun.lock","command":"bun install --frozen-lockfile"},"localSecrets":{"path":"/home/you/.config/pithy/acme/secrets.jsonc","minted":["SECRETS_ENCRYPTION_KEYS","auth-session-secret"],"adopted":[]},"appliedMigrations":["0100_secrets_0001_init","0300_auth_0001_init"],"ports":{"allocated":true,"workers":{"acme-api":{"port":8787,"origin":"http://localhost:8787"}}},"devVarsWritten":["apps/api"],"seededSecrets":["auth-session-secret"],"seed":{"state":"seeded","held":[]},"externalSecrets":["auth-github-client-secret"],"notes":[],"next":[{"command":"pithy dev","why":"Setup starts nothing. The Workers run under pithy dev."}]}
```

| key | type | meaning |
|---|---|---|
| `command` | `"setup"` | The command that produced the line |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `outcome` | `string` | The one outcome. `ready` — this run changed something and the checkout is ready. `unchanged` — it was ready, and nothing was written. `planned` — `--dry-run`. `blocked` — `--dry-run` on a clone whose configs cannot load before the install. No other failure is `blocked`: it stops the run |
| `dryRun` | `boolean` | Whether this was `--dry-run`. Nothing was written when it is `true` |
| `project` | `string` | The project's name, what the dev secrets file and the port registry key on. Absent under `blocked` |
| `install` | `object \| null` | The install: `packageManager`, `lockfile` (`null` when the project had none) and `command`, the whole line. `null` under `--skip-install` |
| `localSecrets` | `object` | The dev secrets file: `path`, absolute and outside the checkout; `minted`, the secrets minted into it; `adopted`, the ones an older home on this machine held and that were carried in rather than minted |
| `appliedMigrations` | `string[]` | The dev migrations applied, or under `--dry-run` pending |
| `ports` | `object` | `allocated`, whether a Worker gained a port; `workers`, each pinned member's `port` and `origin`. `workers` is empty under `--dry-run`, which pins none |
| `devVarsWritten` | `string[]` | Workers whose generated `.dev.vars` this run wrote, relative to the checkout. Empty when every one already held its bytes |
| `seededSecrets` | `string[]` | Dev secrets seeded into the local `SECRETS` store this run |
| `seed` | `object` | How the seed step ended. `state` is `seeded`, `planned`, `held` (dev holds rows, left alone), `media` (a fixture uploads media, which setup never reaches) or `none` (nothing written: nothing to seed, or dev already holds every fixture). `held` lists a table per database that holds rows, empty otherwise |
| `externalSecrets` | `string[]` | Every secret somebody else issues with no value here. `pithy secrets edit` opens the file each goes in |
| `notes` | `string[]` | What the steps had to say, in order: a `.dev.vars` left alone, a store that would not open |
| `blocked` | `string` | Present only under `blocked`: why nothing after the install could be planned, in the project check's own words |
| `next` | `object[]` | `[{ command, why }]` — `pithy dev`, on every real run. Absent under `--dry-run` |
| `plan` | `object` | What `--dry-run` would change, in the one shape every dry run shares. Present only under `--dry-run` |

## Errors

**The project check failed.** `The project check failed, so setup stopped before writing anything.` The action names every problem: a capability composed without its peer, an installed manifest that cannot be used. A Worker config that will not load — usually an uninstalled package — or a Worker whose `pithy.config.ts` is missing stops the run with the loader's own sentence instead, such as `Every worker here is missing its pithy.config.ts.`

**The install failed.** `bun install --frozen-lockfile failed.` A frozen install fails when the lockfile is behind `package.json`. Setup never rewrites it: run the plain install, commit the lockfile, and run `pithy setup` again.

**The root config has no `name`.** Every local store setup writes is keyed on it. Set `name` in `pithy.config.ts`.

## Examples

A fresh clone:

```
$ pithy setup
Installed with bun against bun.lock.
Minted SECRETS_ENCRYPTION_KEYS, auth-session-secret and email-link-signing-key into /home/you/.config/pithy/acme/secrets.jsonc.
Migrated dev: 5 applied.
acme-api: http://localhost:8787
email: http://localhost:8788
secrets: http://localhost:8789
Generated .dev.vars for apps/api.
Seeded auth-session-secret into the local secrets store.
Issued by somebody else, so setup cannot supply it:
  auth-github-client-secret — pithy secrets edit, into /home/you/.config/pithy/acme/secrets.jsonc
Next: pithy dev.
Done.
```

The same checkout, again:

```
$ pithy setup
Installed with bun against bun.lock.
Already set up. Nothing changed.
Next: pithy dev.
Done.
```

A database somebody has been using:

```
$ pithy setup
Installed with bun against bun.lock.
dev holds rows in pithy_auth_users (DB), so it was not seeded.
`pithy seed --env dev --redo` with its --confirm-reset phrase, which only a person gives, deletes the data a seed wrote. That is a person's decision, not a fix.
Already set up. Nothing changed.
Next: pithy dev.
Done.
```
