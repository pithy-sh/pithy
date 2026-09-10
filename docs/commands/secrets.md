# pithy secrets

_The site renders this for readers: [pithy.sh/docs/cli/commands/secrets](https://pithy.sh/docs/cli/commands/secrets). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Declare, write, rotate, list, and edit a project's secrets — and stand up the per-environment infrastructure that stores them.

## Synopsis

```bash
pithy secrets create <name> [--env <env>] [--json]
pithy secrets update <name> [--env <env>] [--json]
pithy secrets rotate <name> [--env <env>] [--dry-run] [--json]
pithy secrets rm <name> [--env <env>] [--json]
pithy secrets ls [--json]
pithy secrets edit [--json]
pithy secrets provision [--json]
pithy secrets deprovision [--keys] [--json]
```

**Its Worker deploy is gated.** The Worker is deployed carrying a stamp naming the package version and a hash of its resolved configuration, and a run whose stamp matches both ships nothing. Anything the gate cannot establish — no Worker, no stamp, an unreachable account — deploys. `pithy deploy --env <env>` ships the same Worker without provisioning anything else, and `pithy deploy --env <env> --kit --force` re-uploads it regardless. See [`pithy deploy`](./deploy.md).

## Flags

| Subcommand | Flag | Meaning |
|---|---|---|
| `create`, `update`, `rotate`, `rm` | `<name>` (positional, required) | The secret's name — a registry entry. |
| `create`, `update`, `rotate`, `rm` | `--env <env>` | Target environment for an environment-scoped secret: `staging` or `prod`. Not `dev`. |
| `rotate` | `--dry-run` | Resolve the declaration and say what would happen. Calls no issuer, writes nothing, needs no credentials. Default `false`. |
| `deprovision` | `--keys` | Also delete each environment's master key. Irreversible: every stored secret becomes undecryptable. Default `false`. |
| all | `--json` | Machine-readable output. Default `false`. |

`--env` here is the **managed** set — every environment the root `pithy.config.ts` declares, `["staging", "prod"]` unless it says otherwise — not the three `--env` takes elsewhere. `dev` is local-only, so it is refused with a sentence pointing at `pithy dev`, and an environment the project does not declare is refused by name with the ones that are.

**`--env` on a `global` secret is refused, not ignored.** A global secret is defined by holding one value everywhere, so naming an environment asks for something the scope does not permit. The command says so and stops, with nothing written:

```
email-link-signing-key is global. It holds one value across every environment, so --env cannot narrow it.
Run it again without --env to set it in every environment.
```

The re-run is the confirmation, so there is no prompt and no `--yes`. It could have printed that sentence and proceeded — but an operator who typed `--env staging` would then have had **prod** rewritten by a command they did not intend, with a notice printed after the fact as cover. One extra command is cheaper than that, every time. `rm` gets the same refusal, and it matters more there: removing a global secret from one environment is the same category error arriving from the destructive direction.

There is no `--worker`. Every subcommand reads the **project's** registry: each Worker's, merged by secret name.

## What it does

The registry is the definition. `pithy secrets` never invents a name — a secret must be declared by a capability the Worker composes, and an undeclared one is refused before anything is sent. Every capability's declarations count, not just the secrets capability's own: `auth`'s session secret and OAuth credentials, `email`'s link signing key and `payments`' provider credentials are all declared by the capability that reads them, and all of them are yours to create here.

**A value never comes from a flag.** `create` and `update` read the value from stdin when it is piped, and from a masked prompt when one can be drawn — and refuse when neither is available, rather than reading your terminal in silence. A flag would leave a live credential in shell history and in every process list on the machine. Nothing here prints a value back, on any subcommand, in either output mode.

**A `json` secret is asked for one field at a time.** On a terminal, `create` and `update` walk the entry's schema and ask per field, using that field's own description as the question. Every field is masked, with no exceptions: these values arrive by paste, so masking costs nothing an operator was going to use, and a field wrongly treated as public is a credential in a screen share. An empty answer is not a value — it is left out, and a field the schema requires is then named on the problem line by the same validation that checks a piped document, so you know which of six questions to answer again. The name only, never the value.

**Only the blocks this project configured are offered.** `payments-provider-credentials` holds one block per payment rail, and the schema knows five are possible where only `pithy.config.ts` knows which are on. One configured rail is named and asked for; several become a checkbox of those rails and nothing else. A rail that is off is never offered and never written, and a block you do not choose is absent from the stored value rather than stored empty.

**An update replaces the whole secret, and it says so every time.** The value is sealed under a master key the CLI cannot read — the read seam answers whether a name is there, never what is under it — so it cannot merge what you type into what is stored, and it cannot show you what is stored either. Anything you are not asked about is gone: a block for a rail you switched off months ago is not in the prompts, so it is not in the value that gets written. That is stated on every interactive update, including the one-rail project that never sees a checkbox. **Pipe the whole document when you need to keep a block you are not editing.**

A schema this cannot render — a union, a record, a list of objects — falls back to the single prompt for the whole document. Refusing to ask is fine; guessing a shape is not.

**A field is asked for on its own line only once somebody has said it fits on one.** A masked prompt reads one line, and a longer paste is silently truncated to one: the first line if your terminal sends carriage returns, the last if it sends newlines. The rest is gone, the fragment is a non-empty string, so the bundle *passes validation* and nothing goes wrong until a signature check does, in production. So every string field of a `json` secret declares whether its value can span lines, and a field holding a PEM — Apple's App Store Connect key, Google's service-account key — says that it can. A secret with such a field among the blocks you configured is asked for as a single JSON document instead, where `\n` is escaped and nothing splits, and the CLI names the field that is the reason. **A field that has declared nothing is treated the same way**, because *undeclared* and *safe* are not the same thing: in the kit nothing is undeclared — a repo-wide test fails any field that has not said — and in your own registry the fallback is what keeps a value you have not classified out of a single-line prompt. If a field marked single-line is handed a PEM anyway, the prompt refuses it by name rather than storing one line of it.

**Piped input is unchanged by any of it.** A pipe takes one whole JSON document, exactly as it always has. Per-field prompting is the interactive path only, because the non-interactive one is what CI and agents drive.

**What decides which of the two you get is stdin, and only stdin.** A pipe, a heredoc, a file, `< /dev/null` — anything that is not a terminal on stdin — is a document, and it is read exactly the same way with `--json`, with output redirected to a file, and with neither. Whether a *prompt* can be drawn is a separate question with separate inputs: `--json` off, and a terminal on stdout.

**So there is a third case, and it says so rather than guessing.** stdin is your terminal, so no document is coming; and the run cannot draw a prompt, because you passed `--json` or redirected the output to a file. Reading your terminal anyway would be an unmasked, unannounced request for a credential, and waiting on it would be a hang. It refuses instead, and names the way in that works from there:

```
No value was piped for 'STRIPE_SECRET_KEY', and this run cannot prompt for one — stdout is not a terminal, or --json was passed.
  Pipe the value in: printf '%s' "$VALUE" | pithy secrets create STRIPE_SECRET_KEY
```

`create`, `update` and `rm` are audited (`secrets/set`, `secrets/rotated`, `secrets/removed`), recording the secret's name, its backend, and the environments reached — never its value. A write that fails is audited too, with the environments it reached before it failed. Which environments a write reaches is the registry's decision, not the flag's: an `environment`-scoped secret reaches exactly the one you named; a `global` one in D1 fans out across every managed environment; a `global` one in the CF Secrets Store is written once, canonically, through the last declared environment.

**Where a write lands is the registry's decision too, and the same one.** A `d1` secret is dispatched through that environment's manager Workflow, which encrypts it under a master key that never leaves the Worker. A `cf-secrets-store` secret is written straight into the account's Secrets Store, at the `<project>-<env>-<secret>` entry ([docs/NAMING.md](../NAMING.md)) that Worker's stanza binds — composed by the same code `pithy secrets provision` looks it up with, so what you write is what gets bound. `create` refuses a name that is already there and `update` refuses one that is not, in both stores alike.

**And what the entry holds is the registry's decision as well.** Nearly every secret is stored as a versioned envelope and read back through it, which is what makes a value rotation expressible. A `bootstrap` secret is not: it is read straight off its binding by code that runs before the store that decoder needs is open, so its entry holds the **value**, with nothing around it. The rule is the one the dev secrets file already states — the destination receives the payload, not a wrapper — and it is why `SECRETS_ENCRYPTION_KEYS` can be parsed at boot at all. If you declare a `bootstrap` secret of your own, `pithy secrets create` writes it the same way.

**A `global` CF-Secrets-Store write reports the entry, not the environment it went through.** There is one account-level entry and every environment's stanza binds it, so the line names what actually changed:

```
payments-provider-credentials written to one account entry, read by staging, prod.
```

Under `--json` that is `environments` naming every environment that reads it, plus `"accountEntry": true`. The environment the write was *dispatched* through is an implementation detail — the canonical one, picked so the same manager always performs it — and reporting it alone understated the change by every environment but one.

**`create` writes the entry; it does not write the stanza.** Follow it with `pithy secrets provision`, which binds on existence — an entry you supplied a moment ago is bound exactly like one it minted itself. `pithy doctor` and `pithy provision` both print that pair for a secret whose entry is missing.

**`rm` on a store-backed secret deletes the entry, and says what it leaves behind.** The entry is the value the Worker reads, so deleting it is the revocation; the Worker's `wrangler.jsonc` still carries a `secrets_store_secrets` line naming it, and nothing in the kit removes one. Wrangler refuses a config naming an absent entry, so the next deploy of that Worker fails until you delete the binding or supply the value again — which the command tells you on the line under the removal.

**`SECRETS_ENCRYPTION_KEYS` is refused in all three.** It is the master key every other secret in that environment is sealed under: replacing it orphans each of them and removing it loses them. `pithy secrets provision` creates it when it is absent, and that is the only thing that writes it.

**A `global` D1 write is the one fan-out, and it is not a transaction.** Each environment is a separate Workflow in a separate Worker; there is no rollback across them, and a compensating write is itself a Workflow that can fail. So the guarantee the command gives is narrower than "all or nothing", and it is stated rather than implied: **no ordinary command can create a split**, because a narrowed global write is refused before anything is dispatched. A *fault* part-way through the fan-out still can, and when it does the command names the environments it reached before it failed — on stdout, before the error:

```
email-link-signing-key written to staging, canary before this failed.
```

Under `--json` that is one line with `"interrupted": true`, `environments` naming only what landed, the `{ "error": … }` line on stderr, and exit code 1. Nothing reports success. A `global` CF-Secrets-Store secret needs none of this: it is one account-level entry every environment binds, so there is one write and nothing for it to disagree with.

### `rotate` — replacing a value against the declaration that says how

A registry entry says how its secret is replaced, and until #367 nothing acted on it. `rotate` does, and it branches on that declaration and on nothing else — never on a list of names.

- **`local`** — the kit produces the value, so it produces another. Minted here, written through the same manager Workflow every other write goes through.
- **`provider`** — the issuer is called and returns the successor. The call is the adopter's or the capability's, attached to the registry entry as a rotator; a `provider` secret with no rotator is refused by name, with both ways out. The kit ships the tag on `turnstile-secret-keys` and no rotator for it, because rolling that widget needs a Cloudflare account token this package must never hold.

  A rotation writes wherever the registry says the secret is held — the same routing `create` and `update` use — and **everything refusable is refused before the issuer is called**. That includes the destination's own refusals, on either backend: a store that cannot be reached — an account with no Secrets Store, a manager Workflow that was never deployed — and an `update` of a secret that is not there. Both are knowable in advance, and discovering one at the write is a credential rolled at the issuer whose successor is then lost.
- **`manual`** — a human, in somebody else's console. It prints the console, the page, and the `pithy secrets update` that records the result, and calls nothing. It exits `0`, and it never prints `Done.`: nothing was done.

**`--dry-run` resolves the declaration and stops.** It reaches no account, needs no credentials, and rolls nothing — which is what makes it the thing to type first at 2am, when the question is *is this one rolled at somebody else's API, or minted here?*

**There is no `--all`, and that is a decision.** The case that wants one is real — somebody has left, and every credential they could have seen needs rolling today. Two things argue against a flag. The blast radius is the obvious one: the failure below does not average out over ten secrets, it is ten chances to strand a live credential in one invocation, reported into one scrollback, at the hour an operator is least able to read carefully. The second is decisive. The precedent for a fleet-wide rotation is *more than one confirmation, plus an audit entry naming the operator* — and the CLI cannot honor the second half. A CLI audit resolves its actor from the Cloudflare API token and records `system, actorResolutionFailed` when there is none, so the one act most certain to be reviewed afterwards would be recorded as *somebody with the token*. What the case gets instead is `pithy secrets ls` and a shell loop, which is a worse ergonomic and forces the operator to see the list before they roll it.

#### The failure this subcommand is built around

**A provider roll succeeds and the store write fails.** The old credential is dead at the issuer, the new one exists only in the process that received it, and the environment is holding something that no longer works. Nothing repairs it by trying harder at the roll — a second roll issues a *third* credential and loses the second, so the retry meant to save it is what destroys it.

So the ordering is the design:

1. **Every refusal happens before anything is called.** An undeclared rotation, a `provider` secret with no rotator, a keyspace, the master key, missing Cloudflare credentials — each is answered with nothing rolled and nothing written. A refusal arriving *after* a roll would be the worst of both.
2. **The value is produced once**, and never again for any reason.
3. **The store is retried against that value** — three attempts, the same string every time. There is no path from a failed store back to a fresh roll.

#### The rotation is recorded, whichever path ran it

A rotation opens a row in that environment's rotation history **before** anything is rolled, and closes it after — so a rotator that never returns still leaves a trace naming the secret and the attempt, and a rotation that succeeded advances `lastRotatedAt`. Until #379 the command line did not do this: it dispatched an ordinary update, nothing recorded a rotation, and the secret went on reporting **overdue** forever while the same act performed from a control-plane client recorded correctly. One act with two paths is not allowed to disagree about whether it happened.

A `global` secret opens one row per environment, and each closes against what that environment actually got: a fan-out that reached staging and stranded prod is a success in one history and an incident in the other. A row records *what caused it* — a rotation is `manual`, the marker written when a secret is first stored is `baseline` — so a first write and a replacement stay legible as different events. `pithy secrets update` is a write, not a rotation, and does not advance the clock.

**Bookkeeping never decides whether a credential is replaced.** A manager that cannot be reached costs the row and not the rotation; the gap is visible as a missing entry and a `lastRotatedAt` that did not move. A `--dry-run` and a `manual` secret record nothing, because nothing was attempted.

The report is per secret and never in aggregate. The word *rotated* is printed only where a value landed:

```
REPLAY_PROVIDER_TOKEN rolled at cloudflare and recorded nowhere.
prod still holds a credential cloudflare has retired.
```

and on stderr, with exit code **3**:

```
REPLAY_PROVIDER_TOKEN was rolled at cloudflare and its new value was not stored. prod holds a credential cloudflare has retired.
The new value is gone. It existed only in this process, and printing it would leave a live credential in your shell history. Roll it again at cloudflare, then record it with pithy secrets update REPLAY_PROVIDER_TOKEN --env prod. https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/update/
```

**Exit `3` is its own status, distinct from `1`.** `1` means the previous credential is still live and the command can simply be run again — a `local` mint whose store refused, a refusal, a missing token. `3` means it is not, and nothing automated will fix it. A script cannot tell those apart from a message, and the two need opposite reactions. `2` is left alone: shells and citty use it for usage errors, and a status that might mean *you typed it wrong* or *a production credential is dead* is no signal at all.

#### What happens to the value, said plainly

**It is discarded.** Not printed, not written to a file, not put in the audit trail, not returned to a caller. The rotation result has no field that could carry one, so this is structural rather than a habit.

That is a real cost and it is worth stating the alternative rather than implying there wasn't one. Printing it would put a live production credential in shell scrollback, in the CI log, in the terminal-recording buffer, and in whatever ships those elsewhere — permanently, and for a value that is by construction the most sensitive thing this command touches. Writing it to a file is the same leak with a filename. Against that, a rolled-and-unrecorded credential is an outage with a known remedy the declaration can name: the issuer has a console, `origin` and `rotation` both record where it is, and the failure prints it. The three store attempts are what make reaching this point rare; the refusal to pretend otherwise is what makes it survivable.

**A rotator that *throws* is reported differently, and the difference is not cosmetic.** A rotator that returned and a store that refused means the credential was rolled. A rotator that threw means it *may* have been — the call reached the issuer and the answer did not. Both exit `3` and both need a human at the issuer, but only one may be described as rolled, and a report that says so of both is wrong half the time about the one fact being acted on. So the second says *may have been rolled at cloudflare*, and its remedy starts with checking rather than with rolling again — because rolling again on an issuer that already rolled produces a second orphan. It does not claim the value is gone either: whether this process ever held it is itself unknown when the rotator threw, and a second guess stacked on the first is how a message stops being trusted.

**Two gaps, named rather than left to be discovered.** Nothing here verifies the new value against the issuer before treating it as current — a verification seam no rotator implements would be a step that always passes. And a crash between the roll returning and the store accepting leaves the same state with no report at all; that window is far smaller than the store's, and it is not zero. Both belong to the rotation Workflow this command will eventually enter rather than to the command.

`ls` lists the declared names with their routing facts, offline. It reads the registry and nothing else — no credentials, no network.

`edit` is the odd one out, and deliberately: it touches nothing but this machine's dev values at `<config>/<project>/secrets.jsonc`, the file every registry secret's local value lives in as a versioned envelope and the source generation reads. It opens a draft beside the real file, validates what comes back, and writes it atomically at `0600`. **It prints a path and a count, never a name and never a value** — `ls` is what lists names. A draft that will not validate is handed back with the problem printed above it; a draft that is still broken, that the editor abandoned, or that lost a race with another command is kept, and the refusal names its absolute path. Nothing here deletes text it could not write.

`provision` stands up the per-environment infrastructure for every managed environment in order: the manager's own least-privilege token first, then per environment a dedicated D1, a minted master key, the migrated schema, and the deployed manager Worker. Every step is idempotent — running it again is a no-op. `deprovision` reverses it, and keeps the master keys unless `--keys` says otherwise.

Credentials for every subcommand above that reaches an account come from `<config>/cloudflare.json`, or `<config>/cloudflare.<accountName>.json` when the root `pithy.config.ts` names an account — account-scoped, not per project. `provision` and `deprovision` additionally need `SECRETS_STORE_ID`, which `pithy add secrets` records. `PITHY_OFFLINE` refuses ambient credentials outright, so an offline run of a Cloudflare-touching subcommand fails rather than reaching an account nobody named.

## `--json`

One line on stdout. A failure is one `{"error": …}` line on stderr and a non-zero exit.

### `secrets create` · `secrets update` · `secrets rm`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets create"`, `"secrets update"`, or `"secrets delete"` — `rm` reports the mode it ran, which is `delete`. |
| `name` | string | The secret name given on the command line. |
| `environments` | string[] | The managed environments the write reached: `"staging"`, `"prod"`, or both. What landed, never what was planned — on an interrupted fan-out it names only the environments actually written. |
| `interrupted` | boolean | Present and `true` only on a `global` fan-out that failed after at least one environment was written. `environments` then names what landed, the `{ "error": … }` line is on stderr, and the exit code is 1. Absent on a run that finished, and absent on a failure that wrote nothing. |

### `secrets rotate`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets rotate"`. |
| `name` | string | The secret name given on the command line. |
| `rotations` | object[] | One record per secret. Always one today, because there is no `--all` — the shape is per secret so that no aggregate field can ever be added beside it and disagree. |
| `rotations[].name` | string | The secret's registry name. Never its value; this payload has no field that could carry one. |
| `rotations[].status` | string | `"rotated"`, `"unchanged"`, `"unrecorded"`, or `"failed"`. `unrecorded` is the issuer-rolled-and-not-stored state, and it is the only one that exits `3`. |
| `rotations[].rotation` | string | How the registry says the secret is replaced: `"local"`, `"provider"`, or `"manual"`. |
| `rotations[].rolled` | boolean | Whether a third party's credential was actually changed. `true` only for a `provider` rotation that reached its rotator — and `true` on the failure path too, which is the point of the field. |
| `rotations[].rollFailed` | boolean | Present and `true` when the **rotator itself** failed rather than the store after it. Then `rolled` is a guess: the call reached the issuer and the answer did not come back, and nothing can tell a request that never landed from a response that was lost. The report says *may have been rolled* rather than *was*, and the remedy starts with checking at the issuer instead of rolling again. |
| `rotations[].recorded` | string[] | The environments that took the new value, in the order they took it. |
| `rotations[].stranded` | string[] | The environments the new value never reached. Empty on a run that finished. On an `unrecorded` run these are the environments now holding a credential the issuer has retired. |
| `rotations[].reason` | string | `"manual"` or `"dry-run"`. Present only when `status` is `unchanged` — why nothing was called. |

An `unrecorded` run also writes one `{ "error": … }` line to stderr with code `secrets/rotation_unrecorded`, and exits `3`. A `failed` run writes the store's own failure and exits `1`. Nothing on either stream carries a value.

### `secrets ls`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets ls"`. |
| `secrets` | object[] | Every declared name, sorted. |
| `secrets[].name` | string | The registry key — a secret name, or a keyspace. |
| `secrets[].description` | string | The entry's routing facts, joined by ` · `: backend (`d1` or `cf-secrets-store`), then scope (`environment` or `global`), then `rotatable` when it is, then `keyspace` when the entry is keyed. |

A `keyspace` marker is the one entry an operator must not try to set: its members are written per key, in-Worker, by the application that mints them — through `putKeyed` / `rotateKeyed` / `deleteKeyed` on the accessor it already holds. See `@pithy-sh/secrets`' README.

### `secrets edit`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets edit"`. |
| `path` | string | The absolute path of `<config>/<project>/secrets.jsonc`. |
| `changed` | boolean | Whether the file was written. `false` for an edit that changed nothing, which is not a failure. |
| `secrets` | number | How many secrets the file holds now. A count — the names are not in this payload. |

### `secrets provision`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets provision"`. |
| `environments` | object[] | One entry per managed environment, in order. |
| `environments[].env` | string | `"staging"` or `"prod"`. |
| `environments[].databaseId` | string | The id of that environment's secrets D1. |
| `environments[].storeId` | string | The Secrets Store id that environment's master key was written to. |
| `wired` | object[] | One entry per Worker and environment whose `secrets_store_secrets` stanza this run wrote. Empty when no Worker composes `secrets`, or when every declared secret's entry is still missing. |
| `wired[].worker` | string | The Worker, as `pithy worker list` shows it. |
| `wired[].env` | string | The environment whose `env.<name>` stanza was written. Never `dev`: local dev materializes these secrets into the generated `.dev.vars` instead. |
| `wired[].bindings` | string[] | The binding names written into that stanza. |
| `wired[].created` | string[] | The binding names whose value **this run** minted, because the registry declared it may be. A subset of `bindings`, and empty on a re-run — an existing value is never replaced. |
| `generated` | object[] | One entry per `d1` secret the registry declares mintable. Empty when the project declares none. |
| `generated[].name` | string | The secret's registry name. Never its value — nothing here, or in the audit trail, carries one. |
| `generated[].environments` | string[] | Where the secret belongs: one environment for an `environment`-scoped secret, every declared one for a `global` secret. |
| `generated[].created` | string[] | The environments this run **created** it in. A subset of `environments`, and empty on every run after the first. Separate from `environments`, because "sent" is not "made" — this is the field that answers *did this run generate a production signing key*. |
| `interrupted` | boolean | Present and `true` only on a run that failed part-way through creating the `d1` secrets. `generated` then names what landed before the failure, the `{ "error": … }` line is on stderr, and the exit code is 1. Absent on a run that finished. |

**`provision` creates every secret the registry says nobody chooses.** A registry entry declares whether its value is *arbitrary* — a session signing key, a link signing key: any random string works, because nothing outside the project validates one. Provisioning creates those rather than printing a `pithy secrets create` line for each. A `cf-secrets-store` secret is written and bound in the same pass (`wired[].created`); for a `d1` secret every environment's manager is **asked first** — it holds the master key and is the only thing that can say whether a value is already there — and only then written to (`generated`). **An existing value is never replaced, on either path.** Replacing a session secret signs everyone out, replacing a link key stops verifying links already in inboxes, and replacing a key-encryption key orphans everything sealed under it — so creating a missing secret and replacing a live one are different acts, and only the first happens here. A secret whose value must match something issued elsewhere — an OAuth client secret, a payment rail's key — declares nothing, and stays a question for the person who can answer it.

**A `global` secret has one value in every environment, or the command stops.** `global` is the promise that a link signed in staging verifies wherever the recipient's click lands, and it is a property of the whole declaration rather than of any one environment — so it is decided across every environment at once, before anything is written. All present, and nothing happens; all absent, and one minted value goes to each. **Split — some environments hold it, some do not — and the run fails, naming the secret and both sides.** That state is what a run interrupted part-way through leaves behind, and completing it means minting a *second* value for a secret defined by having one. There is one repair, and it is destructive: remove the secret everywhere with `pithy secrets rm <name>`, then run this again. The other-sounding option — give the empty environments the value the others hold — cannot be performed by anyone. A `d1` secret is sealed under a master key that never leaves its environment's manager Worker, so nothing reads the value back out to copy it. The refusal therefore names that one command and says what it costs: a live signing key destroyed, and everything signed by it stops verifying.

**A run that fails part-way says what it wrote.** The fan-out creates a signing key per environment, so a fault after the first write leaves key material behind. Whatever landed is printed before the failure — as `created in <environments>` lines, or as `generated` beside `"interrupted": true` under `--json` — and the failure itself goes to stderr with exit code 1. That report is what makes the destructive repair safe to perform: it names the environments a previous run reached.

**`provision` also writes the adopter's `secrets_store_secrets` stanza.** `pithy add secrets` cannot: a `secret` binding needs a `store_id` and a `secret_name` that do not exist until an account has been reached, and `ensureSecretsStoreId` records nothing in five further cases. That deferral was right and nothing came back for it, so a project deployed to staging and its Worker booted without `SECRETS_ENCRYPTION_KEYS`, failing at the first request with no message anywhere. Provisioning is when the store certainly exists and every entry has certainly been written, so it is where the stanza is written or corrected — upserting by binding, never duplicating, and leaving a binding the registry does not declare exactly where the adopter put it.

### `secrets deprovision`

| key | type | meaning |
|---|---|---|
| `command` | string | `"secrets deprovision"`. |
| `keysDeleted` | boolean | Whether `--keys` was passed, and so whether the master keys were deleted with the rest. |

## Errors

- **No secrets capability.** No Worker in the project composes `secrets`, so there is no registry to read.
- **`Secret '<name>' is not declared in the registry.`** Add it to the registry first. Nothing writes a name the registry has never heard of.
- **`Secret '<name>' is a keyspace, not a secret.`** A keyspace has no single value; its members belong to the application that mints them, and it writes them with `putKeyed`.
- **`Secret '<name>' does not declare how it rotates.`** `rotate` only. Add a `rotation` to its registry entry, or replace the value with `pithy secrets update`.
- **`Secret '<name>' rotates by calling <issuer>, and this project supplies no rotator for it.`** `rotate` only. The declaration is right and the code is missing: attach a rotator to the entry, or roll it at the issuer by hand and record it with `pithy secrets update`.
- **`Secret '<name>' is the key every other secret is read through, so nothing replaces it in place.`** `rotate` only, and only for `SECRETS_ENCRYPTION_KEYS`. It rotates on its own axis, inside the manager, on the manager's own cron. Replacing it here would leave every stored secret sealed under a key nothing holds.
- **`<name> was rolled at <issuer> and its new value was not stored.`** `rotate` only, exit code `3`. The one failure this command cannot undo. Roll again at the issuer, then `pithy secrets update`.
- **`Secret '<name>' is environment-scoped — choose an environment.`** Pass `--env staging` or `--env prod`.
- **`Secret '<name>' is global. It holds one value across every environment, so --env cannot narrow it.`** Run it again without `--env`. Nothing was dispatched, so nothing was written — the re-run is the confirmation, and there is no flag that skips it. `rm` says *remove it from every environment* instead of *set it in*.
- **`--env dev`.** Refused with `--env must be one of staging, prod`, and pointed at `pithy dev` — this writes to a Cloudflare account, and `dev` is local.
- **`Cloudflare credentials are missing.`** Run `pithy init` to record the pair, or export it. Raised by every subcommand that reaches Cloudflare — not by `ls`.
- **`The CF Secrets Store id is missing.`** `provision` and `deprovision` only. Run `pithy add secrets` to record `SECRETS_STORE_ID`.
- **No project name.** Every subcommand that resolves a path or a Workflow requires `name` in the root `pithy.config.ts` and refuses to guess one. A guess would open one checkout's secrets from another's worktree, or dispatch this project's values into another project's manager.
- **`edit` conflicts.** The file changed while you were editing (nothing is written, merge by hand); the editor exited non-zero on changed text (your text is kept, and named); the text came back invalid twice (same).

## Examples

```bash
# List what is declared. Offline, no credentials, no values.
pithy secrets ls --json

# Create a secret. The value is piped, never typed as a flag.
printf '%s' "$THE_VALUE" | pithy secrets create STRIPE_SECRET_KEY --env prod --json

# Update one interactively — a masked prompt asks for the value.
pithy secrets update STRIPE_SECRET_KEY --env prod

# Create a bundle interactively — one masked prompt per field, for the rails this project runs.
pithy secrets create payments-provider-credentials --env prod

# Say what rotating would do. Reaches no account, rolls nothing.
pithy secrets rotate TURNSTILE_SECRET --env prod --dry-run

# Rotate it for real, against the rotator its registry entry declares.
pithy secrets rotate SESSION_SIGNING_KEY --env prod

# Remove one.
pithy secrets rm OLD_WEBHOOK_SECRET --env staging --json

# Edit this machine's dev values in $EDITOR.
pithy secrets edit
```

```json
{"command":"secrets create","name":"STRIPE_SECRET_KEY","environments":["prod"]}
{"command":"secrets update","name":"email-link-signing-key","environments":["staging","canary"],"interrupted":true}
{"command":"secrets ls","secrets":[{"name":"SESSION_SIGNING_KEY","description":"d1 · environment · rotatable"},{"name":"TENANT_KEYS","description":"d1 · environment · keyspace"}]}
{"command":"secrets rotate","name":"SESSION_SIGNING_KEY","rotations":[{"name":"SESSION_SIGNING_KEY","status":"rotated","rotation":"local","rolled":false,"recorded":["prod"],"stranded":[]}]}
{"command":"secrets rotate","name":"CLOUDFLARE_API_TOKEN","rotations":[{"name":"CLOUDFLARE_API_TOKEN","status":"unrecorded","rotation":"provider","rolled":true,"recorded":[],"stranded":["prod"]}]}
{"command":"secrets edit","path":"/home/you/.config/pithy/acme/secrets.jsonc","changed":true,"secrets":4}
{"command":"secrets provision","environments":[{"env":"staging","databaseId":"<database-id>","storeId":"<store-id>"},{"env":"prod","databaseId":"<database-id>","storeId":"<store-id>"}]}
{"command":"secrets deprovision","keysDeleted":false}
```

No example above contains a value, and none of these payloads can carry one.
