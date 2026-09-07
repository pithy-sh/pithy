# @pithy-sh/cli

## 0.1.3

### Patch Changes

- [#481](https://github.com/pithy-sh/pithy/pull/481) [`24de77d`](https://github.com/pithy-sh/pithy/commit/24de77d3c66ba179556a718446deb421920b8d3d) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy` runs on Node. The binary was raw TypeScript behind a `bun` shebang, so it installed for everyone and started for nobody without Bun.
  
  ```
  $ PATH=without-bun pithy --version
  /usr/bin/env: 'bun': No such file or directory
  ```
  
  `bin` is `./dist/bin.js` now, behind `#!/usr/bin/env node`. Bun was never a runtime this code needed — nothing under `src` uses a `Bun.*` API or imports from `bun:` — it was loading TypeScript, and every package having a build ended that job. One shebang serves everyone, because Bun runs plain JavaScript; a `bun`-else-`node` dispatcher would need the same build for its fallback and adds a branch that can be wrong.
  
  **Wrangler runs through your project's package manager, not through Bun.** Every command that reaches Cloudflare shelled out to `bun x wrangler`, and reported `Is wrangler installed and on PATH?` when wrangler was installed and Bun was what was missing. It reads your lockfile now — `bun x`, `pnpm exec`, `yarn`, or `npx` — and if the runner itself is absent, it names the runner.
  
  **Packages build unbundled, so a module keeps its own path.** Left to bundle, rolldown hoists shared code into chunks at the output root, which moves any path a module computes from `import.meta.url`: `pithy init` looked for its vendored starter one directory above the package and reported `This pithy install is missing its starter template` on an install that had it. `dist/` mirrors `src/` exactly now, which is what three separate rules were already assuming.
  
  The clean room runs `pithy` with Bun removed from PATH, and `bun run verify-published` refuses a `bin` that is TypeScript or that the tarball does not carry.

- [`9579441`](https://github.com/pithy-sh/pithy/commit/9579441c0cd49bb690f21451a8ec07460e1220d9) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add` no longer crashes on the manifest `pithy init` wrote.
  
  It crashed for any adopter whose resolver landed below zod 4.4.0, and for nobody else — the second command of the standard first run, on a file the first command had just written. Below that version `z.record`'s key check enumerates symbol keys, and comment-json hangs a document's comments off exactly those, so a manifest was refused for having comments in it. Bisected: 4.0.0 through 4.3.6 fail, 4.4.0 onward pass.
  
  **The defect was the range, not the code.** Every package declared `zod: ^4.0.0` while depending on behavior that arrives in 4.4.0 — a promise about every version in the range that only some of them keep. The floor is now `^4.4.0`, and `manifests.test.ts` holds it there with the reason attached.
  
  Nothing loosens `z.record`'s key check. Symbols are preserved deliberately so an adopter's comments round-trip ([#222](https://github.com/pithy-sh/pithy/issues/222)), and the schema already validates by delegation to keep that true.
  
  The reporter is fixed too, separately. `whereItBroke` joined an issue path with `Array.prototype.join`, which throws on a symbol — so it threw while reporting, and the adopter got a `TypeError` from an unrelated file instead of a word about theirs. It stringifies each segment now. Nothing in the kit produces such a path any more; a function whose job is to name where something broke still must not be able to break.

- [#479](https://github.com/pithy-sh/pithy/pull/479) [`24d3245`](https://github.com/pithy-sh/pithy/commit/24d32459145ccedd8b2c3b6cf715646acdfdabaa) Thanks [@kingmesal](https://github.com/kingmesal)! - Every package now ships JavaScript with declarations beside it, so node can import the kit.
  
  `exports` pointed at `./src/*.ts`. That works for every consumer with a bundler — wrangler, Vite, vitest transforming a test — and fails for the one with none: node, which refuses to strip types under `node_modules` and cannot be argued out of it. An adopter's `vitest.config.ts` importing `@pithy-sh/vite` died there with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, and so would any Node script that touched the kit.
  
  Each package builds with tsdown for the JavaScript and `tsc --emitDeclarationOnly` for the types. Two tools because each does one half well: tsdown resolves relative imports to real extensions and leaves siblings external, so `core` is not copied into the twenty packages that depend on it, while its own declaration bundling would flatten `src/error/pithyError.ts` to `dist/pithyError.d.ts` and break the `./src/*` deep-import surface. `tsc` mirrors the tree exactly, so `@pithy-sh/core/src/error/pithyError` keeps resolving to the same path it always named.
  
  **The import path an adopter writes has not changed.** `exports` still keys on `./src/*`; it resolves onto `./dist/*.js` and `./dist/*.d.ts` now instead of onto the TypeScript. Source still ships, because the declaration and source maps point back into it — stepping into the kit lands on the file it was written in.
  
  Two gates were added rather than assumed. `bun run clean-room` imports the packed kit with plain `node` and requires a declaration beside each module; pointing one package's `exports` back at raw TypeScript fails it with the original error. And `bun run verify-published` refuses a tarball that carries no build, or a published module with one half of its pair — a `.js` with no `.d.ts` is an `any` in the adopter's editor, and a `.d.ts` with no `.js` is a type that cannot be imported.

- [#484](https://github.com/pithy-sh/pithy/pull/484) [`800abda`](https://github.com/pithy-sh/pithy/commit/800abdaae3ef4b584c3b0060642d49ebd098fa67) Thanks [@kingmesal](https://github.com/kingmesal)! - `zod`, `kysely` and `hono` are peer dependencies now, so you and the kit share one copy.
  
  They were plain dependencies, which meant an adopter who imports them directly — and anyone writing their own schemas or queries does — could end up with a second copy. Two copies of a package whose classes carry private members are two different types, and the compiler says so in a way that names neither the package nor the duplication:
  
  ```
  Type 'Kysely<any>' is not assignable to type 'Kysely<any>'.
    Property '#private' refers to a different member that cannot be accessed from within type.
  ```
  
  Both paths read identically unless you compare them character by character. A dependency is the kit saying "I need some copy of this"; a peer dependency is the kit saying "you and I must share one", which is the true statement and the one npm, pnpm and bun all act on by installing it once, at the top, where your own import finds it too.
  
  **Nothing to do in most projects.** Your installer resolves the peer on the next install. If you already declare these, check the range matches — `zod@^4.4.0`, `kysely@^0.29.0`, `hono@^4.13.2`.
  
  `@hono/zod-validator` and `kysely-d1` are deliberately not peers: their types do not cross the published boundary, and each depends on `hono` and `kysely` itself, so the copy that matters is already the shared one.
  
  **`pithy doctor` reports a duplicate now**, with the directories each copy was resolved from, because the symptom is otherwise unreadable. It resolves rather than scanning, so what it answers is whether the kit and your code agree on which copy — and it never fails the exit, since a second copy can be deliberate.

- [`3dfe5a7`](https://github.com/pithy-sh/pithy/commit/3dfe5a703a200eaeedba2e54677bf1623053331c) Thanks [@kingmesal](https://github.com/kingmesal)! - A release is now driven from outside the workspace before it ships.
  
  Three defects reached the registry in one day and not one was visible from inside this repository. `workspace:*` published unrewritten, so twenty of twenty-two packages could not be installed — in a workspace that range resolves perfectly. `pithy ui add` crashed on the manifest `pithy init` had just written, for any adopter whose resolver landed below zod 4.4.0 — the lockfile here resolves above it. The `pithy` binary is raw TypeScript behind a `bun` shebang — Bun is always installed here. Every gate that existed asserted about the checkout.
  
  `bun run clean-room` packs what would be published, installs it into an empty directory with nothing else on disk, and runs the commands an adopter runs first. Kit packages are overridden to their own fresh tarballs, so it tests the release being cut rather than the one before it.
  
  **`--floors` is the half that matters most.** A range is a promise about every version in it, and nothing tested the bottom of ours. Pinned at its declared floor, the kit died on `z.codec is not a function` — the API the entire data layer is built from, absent below zod 4.1.0. No amount of reading manifests would have found that; installing at the floor found it on the first run.

- [#485](https://github.com/pithy-sh/pithy/pull/485) [`c8e45ba`](https://github.com/pithy-sh/pithy/commit/c8e45baeac30231559ba53dba4b7b9a4a10cd46a) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add` declares the capability on the Worker that composes it, and refuses a choice it cannot write.
  
  **A capability now lands in `apps/<worker>/package.json`.** The import goes into that Worker's `pithy.config.ts`, so that is what depends on it — which is where `pithy init` already puts `@pithy-sh/core` and where `pithy ui add` already writes. Declared only at the root, it resolved by hoisting, and under a package manager that does not hoist it was not linked beside the Worker at all: a fresh sequence of adds failed part-way and then succeeded on a retry, because the failed run left the package on disk. A first-day failure nobody could reproduce afterwards. The install still runs at the root, where the lockfile is; only the declaration moved, at the range the root resolved.
  
  It also makes the Worker's manifest true. The composed config is per-Worker by design — two Workers are meant to compose different sets — and one shared root dependency list cannot say what either is made of.
  
  **`pithy add payments --set billingSubject=organization` is refused rather than written.** That mode needs a `resolveSubject` seam saying which organization a caller is acting for; the capability refuses to assemble without one, deliberately, because a capability that guessed would key a company's plan to whoever signed in first. `pithy add` renders JSON and cannot render a function, so it was writing the one composition the kit is designed to reject — and since every command begins by loading the config, the add bricked the project. It now stops at the flag and names the two steps.
  
  Capabilities can declare this themselves: a manifest's `configOptions[].choicesNeedingCode` maps a choice to the sentence explaining what to do instead.

- [#488](https://github.com/pithy-sh/pithy/pull/488) [`8ed1f95`](https://github.com/pithy-sh/pithy/commit/8ed1f958925f6987a1cc357225631b56221d5621) Thanks [@kingmesal](https://github.com/kingmesal)! - A refusal never offers a value the next refusal rejects.
  
  Making `billingSubject=organization` unwritable left the message telling you what to pass still naming it: `pithy add payments --json` answered `Pass --set billingSubject=user or --set billingSubject=organization`, and passing the second was refused. The interactive prompt had the same gap, offering it in the select.
  
  Both now offer only what composes. The prompt withholds such a choice rather than listing something unselectable, and says what it would take — `organization` is the mode a B2B project is looking for, and a list that simply lacks it reads as "unsupported" instead of "needs one line you have to write".
  
  The rule, written down in `docs/commands/add.md`: **a scaffolded stub is right when the missing value is data, and a refusal is right when it is behavior.** `pithy add secrets` writes an empty registry with a comment, because an empty registry is a valid state you fill in; there is no equivalent for `resolveSubject`, because a resolver returning nothing loads and then silently denies every entitlement gate.
- Updated dependencies [[`9579441`](https://github.com/pithy-sh/pithy/commit/9579441c0cd49bb690f21451a8ec07460e1220d9), [`24d3245`](https://github.com/pithy-sh/pithy/commit/24d32459145ccedd8b2c3b6cf715646acdfdabaa), [`800abda`](https://github.com/pithy-sh/pithy/commit/800abdaae3ef4b584c3b0060642d49ebd098fa67), [`c8e45ba`](https://github.com/pithy-sh/pithy/commit/c8e45baeac30231559ba53dba4b7b9a4a10cd46a), [`8ed1f95`](https://github.com/pithy-sh/pithy/commit/8ed1f958925f6987a1cc357225631b56221d5621)]:
  - @pithy-sh/cloudflare@0.1.3
  - @pithy-sh/core@0.1.3
  - @pithy-sh/email@0.1.3
  - @pithy-sh/secrets@0.1.3
  - @pithy-sh/turnstile@0.1.3
  - @pithy-sh/ui-react@0.1.3

## 0.1.2

### Patch Changes

- [`b8673f3`](https://github.com/pithy-sh/pithy/commit/b8673f3a08377ecaff9f43aad600d6aae0660ef4) Thanks [@kingmesal](https://github.com/kingmesal)! - Every package installs from npm. Twenty of them did not.
  
  `0.1.0` and `0.1.1` published their dependencies on sibling packages as `workspace:*`. That is a Bun, pnpm and yarn convention, and **npm does not implement it** — measured both ways, `npm pack` leaves it verbatim from the package directory and from the repository root with `-w`. Changesets publishes through `npm publish`, so the range reached the registry unrewritten and no resolver could do anything with it. `bun add @pithy-sh/cli` failed before installing anything. Only `core` and `ui-react` worked, because they depend on no sibling.
  
  Internal dependencies now carry a concrete range, which Changesets already maintains across releases, and which still resolves to the workspace locally — a package's siblings link exactly as before.
  
  **Nothing in this repository could have caught it.** Every test here runs inside the workspace, where `workspace:*` resolves perfectly; the range is only wrong once it leaves. So the check moved to where the evidence is: `verify-published` now extracts the manifest from a real tarball rather than reading the one on disk, and fails on a workspace range in anything a consumer installs. A devDependency keeps it, because a consumer never installs one.
- Updated dependencies [[`b8673f3`](https://github.com/pithy-sh/pithy/commit/b8673f3a08377ecaff9f43aad600d6aae0660ef4)]:
  - @pithy-sh/cloudflare@0.1.2
  - @pithy-sh/core@0.1.2
  - @pithy-sh/email@0.1.2
  - @pithy-sh/secrets@0.1.2
  - @pithy-sh/turnstile@0.1.2
  - @pithy-sh/ui-react@0.1.2

## 0.1.1

### Patch Changes

- [`dfda7b2`](https://github.com/pithy-sh/pithy/commit/dfda7b25c897f3fe30ad7d498dde1216a25edc09) Thanks [@kingmesal](https://github.com/kingmesal)! - Released from CI, with provenance.
  
  Every package's first release was cut from a laptop, and a laptop has no OIDC identity to attest with — so `0.1.0` carries no provenance. This one is built and published by the release workflow over npm trusted publishing, so `npm audit signatures` can verify each tarball came from this repository, from `main`, from the workflow that claims it.
  
  No code changed. The difference is what an adopter can prove about what they installed.
- Updated dependencies [[`dfda7b2`](https://github.com/pithy-sh/pithy/commit/dfda7b25c897f3fe30ad7d498dde1216a25edc09)]:
  - @pithy-sh/cloudflare@0.1.1
  - @pithy-sh/core@0.1.1
  - @pithy-sh/email@0.1.1
  - @pithy-sh/secrets@0.1.1
  - @pithy-sh/turnstile@0.1.1
  - @pithy-sh/ui-react@0.1.1

## 0.1.0

### Minor Changes

- [#314](https://github.com/pithy-sh/pithy/pull/314) [`5d2eae2`](https://github.com/pithy-sh/pithy/commit/5d2eae2d68a3f7cb03f0bbd9164a21bf1324b414) Thanks [@kingmesal](https://github.com/kingmesal)! - Sell through Lemon Squeezy. A fourth payments rail — hosted checkout, the customer portal, signed webhooks, and reconciliation — resolving to the same entitlements as Apple, Google, and Stripe, with the merchant of record handling your tax.
  
  Apple, Google, and Stripe all leave the adopter as merchant of record: you own the tax registration, the VAT thresholds, the invoices, and the chargebacks. Lemon Squeezy owns all of it. That is the whole reason to reach for this rail, and it is a commercial difference rather than a technical one — the entitlements it produces are the same entitlements, resolved by the same writer.
  
  `rails.lemonSqueezy` turns it on, a product carries `lemonSqueezy: { variantId }`, and the credential bundle gains an optional `lemonSqueezy` block with `apiKey`, `webhookSecret`, and `storeId`. `POST /payments/webhooks/lemon-squeezy` takes the deliveries. `/checkout` and `/portal` now pick a rail from the product's declared blocks rather than assuming Stripe, and a product sold on both takes a `rail` field — which a client may name, because a rail decides who takes the money and not how much or on whose behalf.
  
  **Two things about this store are unlike the other three, and both are visible in your data.** Lemon Squeezy numbers each object type from one, so ids are namespaced in `provider_transaction_id` — `subscription:90001`, `subscription_invoice:8001`, `order:7001` — because a bare id would fuse an order and an invoice into one row. And it splits money from subscription state at the source, with no latest-invoice pointer to join them by, so a subscription writes one `role = 'state'` row carrying access and one `role = 'charge'` row per billing invoice carrying the money. Only `charge` rows fulfill a `grants` clause, so N renewals credit exactly N times.
  
  `role` is new on `pithy_payments_purchases` and defaults to `charge`, which is what every other rail writes for every row.
  
  Its webhook signature is a bare HMAC over the received bytes with no timestamp, so there is no freshness window to enforce and the verifier takes no clock — replay protection rests entirely on the existing `UNIQUE (rail, providerEventId)` insert. A refund revokes: Lemon Squeezy issues them on its own for a chargeback or a tax dispute, and the entitlement goes back with the money. A store shared between `dev` and `staging` is fenced by an environment stamp the checkout writes and the rail reads back, so one deployment never projects another's purchases.
  
  There is no client-submittable receipt. Lemon Squeezy order ids are sequential integers, so `verify` refuses rather than letting any authenticated caller claim an order by counting; purchases land through the webhook alone, and a return page shows a pending state instead of posting a receipt.

- [#140](https://github.com/pithy-sh/pithy/pull/140) [`bd6b339`](https://github.com/pithy-sh/pithy/commit/bd6b339d155ee5ec0746f42f5fb0e39d21a8f33d) Thanks [@kingmesal](https://github.com/kingmesal)! - Workflow and Durable Object logs are structured records now, not bare console lines — filterable by level and capability in Workers Logs, with errors carrying their full payload. New projects are scaffolded with a lint rule that keeps it that way, and you can turn it off.
  
  `logger.ts` has always said it: resolve the logger from the request context, never reach for `console`. Nothing enforced that, and nine calls had drifted into shipped runtime code — six of them in Workflow entrypoints, where there is no `c.var.log` to reach for and `console.log` is the shortest path to a line of output. Those six were the only observability a Workflow run had, and every one of them was an unstructured string: no level to filter on, no name to scope to a capability, no instance to correlate by, and a caught `PithyError` arriving as prose rather than lifted into the typed `error` field with its payload.
  
  `plugins/no-console.grit` is the gate, and `plugins/no-process-io.grit` is the same rule for `process.stdout` and `process.stderr` — the Node habit that reaches for a stream instead of a logger. Biome's own `suspicious/noConsole` matches the same code and is deliberately not used: its message is fixed and names no replacement, and a rule that only prohibits gets suppressed by the next person who needs a line of output. Both plugins match the member access rather than the call, so `items.forEach(console.log)` and `const sink = console.error` are caught alongside `console.log(x)`. Two files are exempt, and in both `console` *is* the implementation: `logger/local.ts` sinks to `console.error` and `logger/worker.ts` emits through `console.log`, which is how a record reaches Workers Logs at all.
  
  `bindWorkflowContext` is the Workflow peer of `bindRequestContext`. A run has no method or path; it has an instance id, and that is what anyone reading Workflows Logs searches by.
  
  `pithy init` scaffolds both plugins and both `biome.jsonc` entries into a new project, scoped to the Worker's own `.ts` source. Those files are yours — narrow them, widen them, or drop an entry and delete its plugin with it. Pithy ships the practice; the code is yours.
  
  `readCohort` and `resolveActivity` in `@pithy-sh/testers` take an optional `Logger`, so a degraded activity read is correlated to the request or the run that asked for it rather than surfacing as an orphaned line. Both default to the no-op logger, so no existing call changes.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - the dev secrets file is a first-class citizen of the CLI. `.dev.vars` is env bindings again.
  
  `pithy init` writes `.dev.secrets.example.jsonc`. `pithy add <capability>` mints that capability's generatable secrets into the dev secrets file as version-1 envelopes instead of `.dev.vars` — the declaration and the minting are unchanged, only the destination. `pithy seed` seeds the file into the local `SECRETS` D1, deriving each secret's destination from the registry's `backend` and never from the file. `pithy dev` seeds before any Worker starts, for the same reason it wires the shared `.dev.vars` link before starting: a store filled after startup missed the session's first sign-in. All three call one seeder, so there is one seeding path rather than three that drift.
  
  The file is written `0600` on creation **and on every rewrite**. An atomic write is a rename, so the mode that survives is the temp file's — `writeFileAtomic` now takes the mode and applies it before the rename, or the second write would silently widen a file holding OAuth client secrets back to the umask default.
  
  Writes merge and never replace. The file is hand-edited, so a write re-parses the adopter's own JSONC and edits that tree: comments survive, trailing commas survive, and a value already there is never overwritten.
  
  Migration is told, not enforced. Nothing rewrites an existing project's `.dev.vars`. A secret still sitting there is left exactly as it is — not moved, and not minted a second time beside it — and `pithy doctor` names it, says where it belongs, and repeats itself every run until it moves. It does not fail the exit: every project that predates this file has misplaced secrets by definition, and an upgrade that turns a green `pithy doctor` red in CI over a file that still works is a surprise, not a diagnosis.
  
  `pithy doctor` also reports the standing states no run should repeat: declared secrets with no value that nothing can honestly mint, names in the file no capability declares, and a secrets file readable by anyone but its owner.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A deployed Worker gets its Secrets Store bindings.
  
  An adopter's Worker never got a `secrets_store_secrets` stanza. Nothing wrote one, for any environment, at any point — every writer in the kit targeted a kit-internal host Worker, never `apps/<worker>/wrangler.jsonc`. So a project deployed to staging or prod and the Worker booted without `SECRETS_ENCRYPTION_KEYS`, failing the way an unprovisioned local Worker does, at the first request, with no message anywhere:
  
  ```
  {"error":{"message":"Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS"}}
  ```
  
  **The skip was right and the outcome was wrong.** `core/src/capability/bindings.ts` says why `pithy add` cannot write the entry: it needs a `store_id` and a `secret_name` that do not exist until an account has been reached, and "telling anyone to add one of these to `wrangler.jsonc` sends them somewhere the value does not exist". That was a decision about *when*, and it was implemented as a decision about *whether*. The thing being deferred to did not exist.
  
  It does now, and two commands reach it. `pithy provision --env <name>` writes the stanza as it wires the environment. `pithy secrets provision` writes or corrects it for every declared environment once the entries certainly exist — the five cases `ensureSecretsStoreId` cannot resolve at `add` time, and every project that predates the stanza existing at all. Both upsert by binding, so an existing entry is corrected rather than duplicated, and a binding the registry does not declare is left exactly where the adopter put it.
  
  **`dev` is excluded deliberately, and the reason is in the source.** Local dev materialises every `cf-secrets-store` secret into the generated `.dev.vars` ([#179](https://github.com/pithy-sh/pithy/issues/179)), so a stanza there would name store entries a local run never reads.
  
  **A declared secret whose entry has not been created is reported, not bound.** Wrangler refuses a config naming an absent entry, so binding one would turn a single missing value into a failed deploy of the whole Worker. `pithy provision` names it and the command that creates it.
  
  Not closed here: `pithy add secrets` does not write the stanza at the moment it resolves the store id, and `pithy doctor` does not yet report a `cf-secrets-store` registry secret with no binding in a deployed stanza. Both remain on [#238](https://github.com/pithy-sh/pithy/issues/238).

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - `doctor` reports a deployed environment that binds no Secrets Store entry, and provisioning stops binding only half of them.
  
  Two things were left open when the stanza writer landed. Both close here.
  
  **`pithy doctor` names a `cf-secrets-store` registry secret with no binding in a deployed stanza**, and names the command that writes it. That is the safety net for every project that predates the stanza existing at all — including the adopter who found this by reading their own `wrangler.jsonc` and asking where the binding was. Until now the only thing that reported a missing binding was the Worker's own response to its first request:
  
  ```
  {"error":{"message":"Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS"}}
  ```
  
  It reads files only and never asks the store. Whether an *entry* exists is provisioning's question, and a declared secret whose entry has not been written is reported rather than bound, because wrangler refuses a config naming an absent entry. `dev` never appears, and not by being filtered: the environments walked are the ones the project declares, and local dev materialises these secrets into each Worker's generated `.dev.vars` instead. It reports and never fails the exit — a project that has composed `secrets` and not yet provisioned is a step not yet taken, not a contradiction.
  
  **And the writer was binding the master key and nothing else.** `workerSecretRegistry` read the `secrets` capability's own slice rather than the aggregate every capability contributes, so a `cf-secrets-store` secret declared by `auth`, or by the adopter's own `app` capability, got a binding from no command at all — the dashboard's `CONNECTION_KEY_ENCRYPTION_KEY` and `RELEASE_INGEST_SECRET` among them. It now reads the same aggregate the Worker composes and `pithy seed` already resolves against, so the Worker boots with the bindings it will actually read rather than failing at the first read of one. Composing `secrets` is still the gate: a Worker with no store to read from has nothing to bind.
  
  Which registry entries need a binding is one predicate now, shared by the writer and the check — so a `doctor` that reported a binding provisioning would never write, or missed one it would, is not a state the two can reach.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A feature environment gets its secrets.
  
  `pithy provision --feature` created a real, deployable environment — D1, KV, R2, environment-scoped script names, service bindings — and touched secrets not at all. So a feature Worker composing `secrets` deployed and failed on its first request:
  
  ```
  {"error":{"message":"Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS"}}
  ```
  
  Worse than the same gap in staging, because the adopter chose staging. A feature environment is created by pithy, from a branch name, with every other resource wired automatically — so there was no reason to think secrets were the one thing to arrange by hand, and nothing said so.
  
  **A feature gets its own master key, and teardown takes it.** `pithy secrets deprovision` preserves a key unless explicitly asked, because losing it orphans every secret encrypted under it. For an ephemeral environment that reasoning inverts: nothing outlives the feature, so the key is the feature's and goes with it. `pithy feature destroy` removes every entry the feature could have named, by recomputed name, and leaves staging's and prod's alone — asserted, because the account's Secrets Store is flat and the name is the only partition there is.
  
  **`ManagedEnvironment` does not widen, and the argument is recorded in the source.** Since [#241](https://github.com/pithy-sh/pithy/issues/241) that type *is* the set the project declared, and everything iterating it multiplies with it — most of all a manager Worker with its own D1 and its own rotation cron, per environment. One per open pull request is not a cost a branch should carry. So the feature takes the narrow route: a key of its own and the bindings that reach it, and none of the durable machinery. The consequence is stated where an adopter meets it — a feature has no manager, so a secret it needs beyond the master key is reported as unbound with the command that creates it.
  
  **A `global` secret is bound, never copied.** It is one account-level value every environment binds; minting a feature's own would be a second copy of a value defined as one.
  
  The writer underneath is shared. `ProvisionScope` gained `secretEntry(secret, scope)`, so an entry name comes from the same object the resource names and the wrangler stanza do, and `applyProvisionedEnv` writes the `secrets_store_secrets` stanza for whichever scope it was handed. A declared secret whose entry has not been created is **reported rather than bound**: wrangler refuses a config naming an absent entry, so binding it would turn one missing value into a failed deploy of the whole Worker.
  
  Both provisioning writers now emit through the one JSONC printer ([#249](https://github.com/pithy-sh/pithy/issues/249)) rather than a raw `stringify`, and `src/ci/jsoncWriters.test.ts` states that as a rule about the call rather than a list of files — the gate that would have caught this one, which did not exist when [#249](https://github.com/pithy-sh/pithy/issues/249) landed.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy provision --env <name>` — the lifecycle step that was written for feature environments and never for the ones a project ships to.
  
  A project scaffolded, wired and migrated by pithy could not be deployed. `pithy add` runs the Worker's *dev* migrations, `pithy migrate --env prod` queries a database it assumes exists, and `pithy deploy` provisions nothing — so `apps/<worker>/wrangler.jsonc` declared `"database_name": "<project>-staging-db"` with no `database_id`, in every environment, and stayed that way. The first deploy failed inside wrangler, on a field the adopter never knew they were meant to fill in, after four commands had all succeeded.
  
  The provisioner was never the missing part. `pithy provision --feature` already resolves the Worker set, creates one resource per binding name, writes the ids into each Worker's own config and migrates. What was missing was the command, and the naming.
  
  **`ProvisionScope` is the naming, and it is why this is one object rather than two arguments.** A scope carries both the names a run composes and the `env.<name>` stanza it writes them into. `environmentScope(project, env)` gives `<project>-<env>-<thing>`, so a name's environment segment is always the stanza the name lives in; `featureScope(identity)` gives `<project>-f<issue>-<slug>-<thing>`, with the `f<issue>` marker instead of an environment because a feature *is* one. `provisionScope.test.ts` asserts that property over every scope, project, binding and kind, in both directions.
  
  That closes a hazard that was reachable before it: `pithy provision --feature --env staging` composed `<project>-f<issue>-<slug>-db` and wrote it in as staging's `DB`, in a checked-in `wrangler.jsonc`, then ran a remote migrate against it. Nothing refused it. **`pithy provision --feature` no longer takes an `--env`** — the combination cannot be expressed, rather than being on a list of things not to do.
  
  `pithy provision` is idempotent and **adopts**: every resource is matched by name before it is created, so a re-run is a no-op and a database made by hand under the right name is taken up rather than shadowed by a second. It writes a D1's `database_name` beside its `database_id`, because `pithy add` proposes the name offline and provisioning is the step that makes the proposal true. It creates the stanza when it is absent, so an environment declared after scaffolding needs no hand-editing. Seeding is off unless `--seed` is passed.
  
  **`pithy deploy --env <name>` refuses** when a binding has no resource behind it, naming the command that creates one — before anything is built or spawned. A deploy that silently created account resources would be hard to review, and these are the ids that land in a pull request.
  
  Production takes an exact, environment-naming phrase that `--yes` never replaces, and there is no `pithy deprovision`: staging and production are not disposable, and the one-word difference between them and a branch is not a difference a flag should carry.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A project declares which environments it has, and three parts of the CLI stop guessing.
  
  Nothing said. The set existed only as `env.<name>` stanzas in each Worker's `wrangler.jsonc` — per Worker, so two Workers in one project could disagree with nothing reconciling them — while `ManagedEnvironment` held a closed enum of `staging` and `prod` and `seed.productionEnvironments` invited a project to name a third. An adopter adding `env.live` got `pithy migrate --env live` working, `<project>-live-db` created, and `pithy secrets provision` skipping it: no master key, no manager, no store entry, silently, until the first request.
  
  The root `pithy.config.ts` now carries `environments`, defaulting to `["staging", "prod"]`. `pithy init` asks with that default — one keypress for the common case, and no line written into the config, because a declaration that repeats the default says nothing. A non-interactive `init` takes the default and is byte-for-byte what it always was. The list is ordered, least-production first: that is the order provisioning walks, and the last entry is the one a `global` account-level secret is written through, which used to be the literal `prod` even for a project that had none. `dev` cannot be declared — it is local, it is the top-level wrangler stanza, and it always exists. `global` stays reserved.
  
  **Declared and managed are one set, deliberately.** `ManagedEnvironment` is no longer a closed enum; it is the declaration. The cost is named rather than hidden: everything that iterates the set multiplies with it, and the largest item is a manager Worker per environment with its own rotation cron, so a project declaring five environments gets five managers. The alternative — a second, smaller "but only these are managed" list — is the bug restated, because an environment that deploys and is not managed is one whose secrets have no master key, which is exactly the silence `live` was already in. So declaring an environment is what costs a manager, and that is the one decision, in the one place `pithy doctor` can see it.
  
  `--env` refuses an environment the project does not declare, by name, listing the ones it does. `pithy init` and `pithy worker add` generate each Worker's `env.<name>` stanzas from the declaration rather than a hardcoded pair, with their binding arrays empty — a stanza that asserts nothing is the honest shape, and an existing project's scaffolded stanzas keep working untouched.
  
  **A fresh `init` still writes those stanzas**, and that is a decision with a reason in the source. `pithy add <capability>` writes bindings into the stanzas that exist and creates none, so a project scaffolded without them would have its very next `pithy add auth` bind `dev` alone and leave staging and prod silently unbound — a worse silence than the one this closes. Provisioning owning the stanza is right and is the follow-on work.
  
  `pithy doctor` gains an `Environments:` block and an `environments` key in `--json`. It reports a Worker whose stanzas disagree with the declaration, and — separately, because the remedies are opposite — a declaration changed **after** provisioning: an undeclared stanza still carrying resource ids. That one is never applied. `<project>-<env>-<thing>` is recomputed and never stored, so changing an environment name does not rename a database; it orphans it, exactly as renaming `name` does. The report names the ids and stops. A stanza whose bindings carry no ids is read as not provisioned rather than as broken.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A feature's provisioned ids never touch a tracked file.
  
  `pithy provision --feature` wrote feature-scoped ids into `apps/<worker>/wrangler.jsonc` — tracked, committed, and impossible to gitignore, because it is the project's real config. In CI that is correct as designed: the checkout is throwaway, wrangler reads the stanza, the job ends, nothing is committed. Everywhere else it was an expectation rather than a guarantee. A developer in a feature worktree carried a modified tracked file they had not edited, with nothing saying it must not be committed; `git add -A` put ids for since-deleted resources onto `main`. And `pithy feature destroy`, which reverses every other thing provisioning does, did not reverse the edit — the one part that outlived the feature.
  
  **The fix is a shape, not a warning: a provisioning run never writes a file a checkout tracks.**
  
  `ProvisionScope` gained `source` — is this environment's config source, or a build artifact? A declared environment's ids are long-lived facts about the repository and belong in the tracked file, under review, in a pull request a human reads. A feature's are facts about one job. So the same object that answers "what is this called?" and "which stanza does it go in?" answers "which file?", because those three answers have to agree.
  
  A feature's config is generated at `apps/<worker>/.wrangler/pithy/wrangler.feature.jsonc`, regenerated from the tracked file on every run so it cannot drift from it. `.wrangler/` has been in the scaffolded `.gitignore` since the first release and is ignored at any depth, so there is no new ignore rule and nothing for an existing project to adopt — which is the point: a rule existing projects lack would have left them exactly where they were. `main` is rewritten to an absolute path, because wrangler resolves a config's paths relative to the config file.
  
  One resolver decides which bytes describe an environment, and `migrate`, `seed` and `deploy` all use it; `deploy` passes it to wrangler as `--config`. `feature destroy` now has nothing to reverse, and a feature abandoned without teardown strands nothing.
  
  The gate is the sentence: after `pithy provision --feature`, every path whose bytes changed is one the scaffolded `.gitignore` already covers, and the Worker's own `wrangler.jsonc` is byte-identical — with a non-vacuity check, so "wrote nothing tracked" cannot pass by writing nothing at all.
  
  Worth stating: `pithy env` reports what a Worker's tracked config declares, so a feature environment does not appear in it.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - Provisioning is one command: `pithy provision --env <name>` or `pithy provision --feature`.
  
  Both create an environment's Cloudflare resources, write the ids into each Worker's config, and migrate. They differ only in **how the target environment is named** — declared in the root `pithy.config.ts`, or derived from the checked-out branch. That is a flag, not a different verb.
  
  The safety lives in the scope rather than in the spelling. A `ProvisionScope` carries the resource naming **and** the `env.<name>` stanza the ids are written into, as one value — so a feature-named resource landing in a declared environment's stanza of a checked-in config is unexpressible rather than merely refused. Nothing about that depends on which words were typed, which is what leaves one command free to carry both modes.
  
  `pithy feature` is `create`, `sync` and `destroy`. All three derive the feature from the checked-out branch, so provisioning was the only verb there that a flag on `pithy provision` could say better.
  
  **Exactly one of the two flags is required, and neither is ever inferred.** Passing both, or neither, is refused at the flag — before the working directory is read, before a config is loaded, and before any Cloudflare client exists, which is why the refusal reads the same outside a project as inside one. `--feature` is never derived from "the branch looks like a feature branch": an implicit mode switch on branch shape is how someone provisions the wrong thing while reading a command line that says nothing about it.
  
  **The two modes have opposite persistence semantics, so every run says which it did and where.** `--env` writes `env.<name>` into the tracked `wrangler.jsonc` — long-lived ids a human reviews in a pull request. `--feature` writes a generated config under the already-ignored `.wrangler/` — one job's output, rebuilt every run, never committed. A single flag that flips whether output is committed will eventually surprise someone:
  
  ```
  Wrote 3 ids into apps/board/wrangler.jsonc. Commit them.
  Wrote 3 ids into apps/board/.wrangler/pithy/wrangler.feature.jsonc. Ignored, and rebuilt on the next run.
  ```
  
  `--json` carries the same answer as `configs` and `committed`, so a pipeline reads it rather than infers it. That is what keeps the standing rule checkable rather than remembered — **a CI build process never commits back to the repository**: a pipeline runs `--feature` and has nothing to commit. The gate is the sentence: a run names every file it wrote, every file whose bytes moved is one it named, and `committed` is exactly whether those paths are tracked.
  
  **`feature` is now refused as a declared environment.** It was legal to write `environments: ["feature"]`, which gave one wrangler stanza two owners — a tracked file provisioning wrote and a generated file every other command read. It stays a legal environment *name*, because it is a real stanza key; it is the declaration that is refused, the way `dev` and `global` are. So `--env` cannot reach a branch's environment and `--feature` cannot reach a declared one, in both directions, by construction rather than by check.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy deploy` refuses an environment that answers on an origin nothing declares, and a declared domain closes `workers.dev`.
  
  **Every origin a deployed Worker answers on is one its configuration names.** That is the invariant, and nothing enforced it. Anything derived from an environment's public origin — an auth `baseURL`, an OAuth callback, a magic-link URL, a CSRF allowed-origin — has to answer "what is this environment's origin?", and when the config answers nothing every caller invents one. The first adopter shipped the dangerous invention: a staging deploy that emailed real users magic links into **production**.
  
  Two shapes are refused, at `pithy deploy --env <name>`, before anything is built or spawned — the same shape as its refusal of a binding with no id.
  
  **No origin at all.** No `domains` declaration, no `routes` pattern, no `vars.BASE_URL`. The refusal names the Worker, the environment, and the edit: declare `domains.<env>`, or set `vars.BASE_URL`. Two answers because `WorkerDomains` has keys for `staging` and `prod` only, and telling a project on a custom declared environment to declare a domain would send it to a config that would not validate.
  
  **`workers.dev` left open beside a custom domain.** A Worker with a declared domain still answers on `<name>.<subdomain>.workers.dev`: wrangler's `workers_dev` defaults to `true` and declaring `routes` does not change it, and `preview_urls` then follows `workers_dev`, so every deployed version is reachable there too. On that second origin `vars.BASE_URL` names the other host — so OAuth callbacks and magic links point away from the host in use — and the CSRF same-origin gate refuses exactly the requests that establish who you are. Reachable, and broken in that half. Anything bound to the hostname rather than the script, a WAF rule or an Access policy or a per-hostname rate limit, does not apply there at all.
  
  So `pithy init` and `pithy worker add` now write `"workers_dev": false` beside every domain they declare — visible and diffable, in the same file the route and `BASE_URL` are generated into. Unlike those two it is written only when the key is absent: **the fault is the absence of a decision, not the decision.** A team that wants the `workers.dev` URL for staging until DNS is cut over writes `"workers_dev": true`, and a named origin satisfies the invariant exactly as a domain does.
  
  `workers.dev` is therefore supported rather than refused, and the answer to "is it derivable?" is that it must be *stated*: an adopter with no custom domain sets `vars.BASE_URL` to their `workers.dev` URL, which is the one place an origin comes from and the one the resolver already reads. What dies is the third state, where the origin is neither declared nor derivable and each caller guesses.
  
  `pithy doctor` reports both faults so they are findable before a deploy is attempted. Only the `workers.dev` one fails the exit: it is a live origin this repo's own config does not name, established from that config alone. Having no origin yet is the state every project is in before it has a domain, and failing it would turn `pithy doctor` red on day one for everyone.
  
  A feature environment is exempt. It is ephemeral, has no declared domain by design, and `workers.dev` is how it is reached.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - No capability asks an adopter to write down an origin.
  
  `originFor` landed the derivation; nothing scaffolded it and every capability still shipped a URL as its default, so `pithy add auth` wrote `baseURL: "https://api.example.com"` into a config that had no other answer. `pithy init` now scaffolds the shape the first adopter arrived at by hand:
  
  ```ts
  const DOMAINS = { /* staging, prod */ };
  export const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);
  const config = { domains: DOMAINS, capabilities: [ … ], app };
  ```
  
  Hoisted, because the origin has to exist before the capabilities that take it are constructed — and `domains: DOMAINS` beside them is the same object, so there is one declaration with two readers. The domain prompt fills that const rather than inserting a second `domains` key, which is what the previous writer would have done to a config carrying one.
  
  A manifest option whose value is an origin now names a **constant** rather than stating a URL, and `pithy add` and `pithy upgrade` both render it unquoted. The vocabulary is closed — a manifest names `publicOrigin`, never an expression — for the same reason a capability's own name is constrained: a manifest is third-party data written into the adopter's TypeScript. A `--set` override still wins, and a project scaffolded before the constant existed keeps the literal rather than being handed an identifier nothing defines.
  
  `auth.baseURL`, `email.baseUrl` and `testers.baseUrl` derive. The gate found the third: the issue named three capabilities and the fourth was sitting there unreported. `controlplane.issuer` deliberately does not — it is an identity, not an address, and a connection minted in staging must stay verifiable in production — and it is the one named exemption on a gate that fails any other origin-shaped default.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - Write every binding a capability requires, so a scaffolded project boots.
  
  `pithy init`, `pithy add email`, `pithy add auth`, `pithy dev`, `curl /health` — the shortest path through the product, in the order the docs teach it — answered `500` on **every** route. `@pithy-sh/auth` requires `ratelimit:AUTH_RATE_LIMITER` and `@pithy-sh/email` requires `workflow:EMAIL_SENDER`, both non-optional, the composition correctly refused to assemble without them, and nothing wrote either one. Because it is every route, `/health` failed too, so the error named a binding and never the capability behind it.
  
  Both are now written by `pithy add`, per environment. A rate limiter is a policy with no resource behind it, so it lands at 100 requests per 60 seconds and is yours to tune. A Workflow entry names the capability's host across scripts — `<project>-<env>-<capability>-<job>` in `<project>-<env>-<capability>` — which is derivable offline, so the binding exists before `pithy <capability> provision` deploys the host. `vectorize` and `secret` stay unwritten and stay in `notes`: wrangler refuses a `vectorize` entry with no `index_name`, and a Secrets Store entry has no array in `wrangler.jsonc` to sit in.
  
  `isWrittenBinding` in `@pithy-sh/core` is the rule, and `capabilities/requiredBindings.test.ts` is the gate over it: a capability requiring a kind that neither `add` writes nor a provision command creates fails CI rather than a request. `project/scaffoldBoot.test.ts` runs the whole path — scaffold, add, compose, `GET /health` — with the Worker's env built from the files the commands wrote and nothing else, which is the gap the defect lived in.
  
  `pithy add` and `pithy upgrade` now write bindings through one function rather than two copies "kept in lockstep by intent". The two had already drifted: `add` stamped a capability's `remote` flag and wrote the Workers AI binding, `upgrade` did neither.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - A failed `pithy ui add` leaves the project as it found it.
  
  `runUiAdd` wrote its whole template and *then* composed the app to derive the asset allowlist, so a composition that threw left the files written and the wiring absent. The retry was refused by the command's own guard — `pithy ui add` declines a Worker that already carries a front end, which is correct and deliberate, and could not tell a finished front end from one this command had abandoned a minute earlier. The adopter was told the thing was done, by the run that failed to do it, and the way out was deleting files by hand and working out which ones were the template's.
  
  Two changes, and both are needed. The allowlist is derived **before** anything is written: `wireAssets` takes the patterns rather than composing them, so the step most likely to throw throws first. And every write runs under `withRollback`, because ordering alone only removes the failure someone has already met — the next step added goes back on the end of the list. Stated over the outcome, the property survives the next step.
  
  `withRollback` (`project/rollback.ts`) is the primitive: snapshot the files a run may touch, restore them if it throws, and remove the directories it had to create. `pithy worker add` has done this by hand since [#158](https://github.com/pithy-sh/pithy/issues/158) for the one directory it creates; this is that, for a command that edits files an adopter already owns. An unreadable path refuses the run up front rather than being recorded as absent — recorded as absent, the rollback would delete it.
  
  The genuine refusals are untouched: a Worker that really has a front end is still refused, and a second framework in one Worker still refused outright.

- [#266](https://github.com/pithy-sh/pithy/pull/266) [`014d475`](https://github.com/pithy-sh/pithy/commit/014d475d28aa4d59652f70347aad389a901c3ff5) Thanks [@kingmesal](https://github.com/kingmesal)! - A declared origin with nothing serving it is a fault, `pithy worker sync` writes the route, and a deploy that reaches nothing is a failure.
  
  **Every origin a config names has something in that config configured to serve it.** That is the other half of [#253](https://github.com/pithy-sh/pithy/issues/253)'s invariant, and nothing asked it. The consequence was that `pithy doctor` handed out a remedy which took the Worker down and then reported the result as healthy.
  
  The path: an adopter declares `domains` in `pithy.config.ts` any way other than an interactive `pithy init` — a `--json` scaffold, a CI run, or the documented hand edit that adds an environment. `applyDomains` is the only thing that writes the `custom_domain` route a declaration implies, its one caller was the interactive domain prompt, and `askDomains` returns nothing at all when a session is not interactive. So the declaration exists and no route does. Doctor then reports `workers-dev-open` — correctly, `workers.dev` is open — and names the remedy: `"workers_dev": false`. Applying it closes the only origin that was actually serving. `doctor` exits 0, `pithy deploy --env prod` prints `Done.`, and the Worker answers at no address at all. Nothing in the toolchain ever said the word "route".
  
  **The gate now states the invariant rather than enumerating shapes.** One question is asked of the resolved address — *what in this config serves this host?* — and there are two answers: a `routes`/`route` pattern that covers the hostname (wildcards included, so a `*.example.com/*` that has served for a year is not suddenly a fault), or, for a `workers.dev` hostname, `workers_dev` not being off. The mirror image falls out of the same rule for free: a named `workers.dev` origin with `"workers_dev": false` beside it is also served by nothing. A gate keyed on `workers_dev` values would have missed both.
  
  `pithy doctor` reports the new `unserved-origin` fault by name — naming the missing route, never `workers_dev` — and **fails the exit**. `pithy deploy --env <name>` refuses before anything is built or spawned, through the same `assertOriginsDeclared` the other two faults go through. The feature-environment exemption is unchanged: it is ephemeral, has no declared domain by design, and `workers.dev` is how it is reached.
  
  **`pithy worker sync` is the non-interactive writer.** It already reconciled the app capability's Workflows and cron triggers into `wrangler.jsonc`; it now writes the route and `vars.BASE_URL` a `domains` block implies, from the same file, for every environment the declaration names or just the one `--env` names. Running it twice changes nothing, writes nothing, and says `already in sync` — `applyDomains` reports per environment whether anything moved and skips the write when nothing did. Doctor's own sentence names the command, so the fault and its fix arrive together. An origin named by a hand-set `vars.BASE_URL` was generated from nothing, so it is told to write the `routes` entry instead of being sent to a command that would report, correctly and uselessly, that it wrote nothing.
  
  **And a post-deploy probe that reached nothing is a failed deploy.** `verifyDeploy` conflated two facts: a Worker that answered without a version, and a Worker that answered nothing at all. Both were `inconclusive`, under a sentence blaming `CF_VERSION_METADATA` — so the Worker that was routed nowhere reported success and pointed the adopter at a binding that was already declared. They are now separate. Something answered and could not name a version stays `inconclusive`, because an unadopted binding is ordinary. Nothing answering is the `unreachable` arm that the status union has always declared and no code path ever returned, its detail names the address that did not answer, and it fails the command.

- [#269](https://github.com/pithy-sh/pithy/pull/269) [`f3c35be`](https://github.com/pithy-sh/pithy/commit/f3c35be709cb6f1e152b8daa84c5dea1e1d03213) Thanks [@kingmesal](https://github.com/kingmesal)! - A declared Workflow the stanza does not bind is a fault, and a deploy that would never run it is a failure.
  
  **What the app capability declares is what the environment's stanza binds.** `reconcileAppWorkflows` derives the `workflows` table and `triggers.crons` from an app capability's `workflows` map and writes them into `wrangler.jsonc`; `pithy worker sync` is its only caller; and nothing read the two halves back. So an adopter who declares a job and never runs `sync` — nothing tells them to, and nothing else runs it — gets a green `pithy doctor`, a green `pithy deploy --env prod`, and a Worker that ships with no `workflows` entry and no `triggers.crons` at all. The same structure as [#264](https://github.com/pithy-sh/pithy/issues/264) one file over: a declaration in `pithy.config.ts`, a fact in `wrangler.jsonc`, one writer, no reader.
  
  Of the three things that then go wrong, one is silent and that is the one this is for. `c.var.workflows.trigger("board/digest", …)` fails loudly — `createBackend` derives a `workflow` binding spec from every registered job, so a missing one fails `validateBindings` on the Worker's first request. A binding carrying another environment's Workflow name starts instances of the wrong Workflow. **The cron just never fires.** No request fails, no log line appears, no probe goes red, and the first sign of it is whatever the job existed to prevent.
  
  **The gate states the invariant rather than enumerating shapes.** The declaration is reduced to the table it implies — through `planAppWorkflows`, the function the writer plans with — the stanza's own app-owned table is read back beside it through the one ownership rule the writer replaces by, and the two are compared whole. A declared job nothing binds, a binding the declaration no longer names, a stale cron, and a binding pointing at another environment's Workflow are not four rules: they are four ways one comparison comes out, with one remedy. Order is not part of it, because Cloudflare reads a table and the array's order carries no meaning. A gate written as a list of forbidden shapes is how [#264](https://github.com/pithy-sh/pithy/issues/264) shipped, and this is one file over from it.
  
  `pithy doctor` reports the new `Workflows:` block, naming both sides of the comparison, and **fails the exit** — there is no day-one state to spare here, since a project that declares no Workflows has no drift to report. `pithy deploy --env <name>` refuses before anything is built or spawned. Both name `pithy worker sync`. A second fault, `unwritable-declaration`, covers a declaration that cannot be reduced to a stanza at all — a job with no `className` — and sends it to `pithy.config.ts` instead, because no command can write that one. A Worker whose `pithy.config.ts` will not import claims nothing, and a Worker with no `app` capability is not held to a declaration it does not have. Files only, offline, no account call. A **feature environment is exempt**, as it is from the origins gate: its stanza is a generated build artifact under `.wrangler/`, not the tracked `wrangler.jsonc` this reads and `worker sync` writes.
  
  **And `pithy worker sync` now reconciles an app that declares no Workflows**, where it used to return before the file was opened. Dropping the last job from `pithy.config.ts` left its binding and its cron in `wrangler.jsonc` with no command that would take them out — so the new fault would have named a command that could not answer it. What it writes is still nothing at all where there was nothing: no empty `workflows` key, which wrangler reads as a declaration, and no invented `triggers` block.

- [#272](https://github.com/pithy-sh/pithy/pull/272) [`5e93279`](https://github.com/pithy-sh/pithy/commit/5e9327927c0f59e1d94387f2880ddba0043ec600) Thanks [@kingmesal](https://github.com/kingmesal)! - An adopter can compose their own Better Auth plugins, and `pithy migrate` creates the tables those plugins need.
  
  `packages/auth/src/instance/auth.ts` hardcoded four plugins and nothing in the capability's config reached them, so an adopter who needed `organization`, `passkey`, `twoFactor`, `apiKey`, `admin` or a generic OAuth provider had two options: fork the capability, or stop using it. That is a large part of what Better Auth is, closed off by a list. `auth({ plugins: [organization()] })` is now the whole of it.
  
  **The four the kit composes are fixed, and additive is the rule.** `bearer`, `jwt`, `magic-link` and `emailOTP` are always present and are composed **first**; the adopter's list is appended. `magic-link` and `emailOTP` are the sign-in this product promises and there is no password to fall back to; `jwt` mints the JWKS the control-plane seam verifies against, and `bearer` is how a mobile client presents its credential. Better Auth merges plugin endpoints by id with the later registration winning, so "adding" one of the four would silently redefine it — a config that names one is refused at `auth()`, by name, and so is a list that repeats an id.
  
  **A plugin's tables are created, not deferred.** The kit's migration model had no path for tables an adopter introduced through a capability's plugin, and an app whose plugin queries a table nobody created fails at runtime on the first call. It needed no new path: the plugin list is in `pithy.config.ts`, which is the file `pithy migrate` already imports to collect capabilities. The auth capability asks Better Auth what schema the composed list implies, subtracts the schema its own four already imply, and contributes **one ordinary Kysely migration per plugin** — `0300_auth_0002_plugin_<id>` — beside `0001_init`, each with a tested `down`. Both halves of a plugin's schema are derived: `organization` creates `organization`, `member` and `invitation` **and** adds `active_organization_id` to `pithy_auth_sessions`, and a create-table-only reading would have shipped a schema where `setActive` fails on the first call.
  
  Three consequences worth stating. A column added to a table that already exists is **nullable** whatever the plugin declares, because SQLite will not add a `NOT NULL` column to a table with rows — Better Auth writes the value on every insert it makes, so the constraint holds where the plugin enforces it. A plugin's tables carry the plugin's own names, not `pithy_auth_*`; a collision with a table this capability owns, or between two plugins, is refused at `auth()` naming both, and a collision with a table another composed capability declares in the same D1 is refused at boot, which is the first moment anything can see both. And **removing** a plugin needs the same care as removing a capability — roll its migration back while it is still composed, then take it out of the config.
  
  **The client's surface is the adopter's to compose, and it needs no cast.** Better Auth builds a client from its own plugin list and the server's type never crosses into a browser bundle, so `organizationClient()` beside `organization()` is the answer, and `AuthInstance` is now parameterized in the plugin tuple for the one thing that genuinely needs the server's type — `inferAdditionalFields`. A typecheck-enforced test in the auth package compiles `authClient.organization.create(…)` with no cast anywhere in it.
  
  **Nothing an adopter plugs into a capability is invisible any more.** `Capability.extensions` is a new, additive, descriptive field on the composition contract — `{ kind, id, tables }` — and `pithy doctor` prints a `Capability extensions:` block from it. A composed plugin has no `package.json` for `Project capabilities:` to name it from, and it still adds routes to the Worker and tables to the database. The block is the only one in that report that is not a finding: an extension is a deliberate act, so it never fails the exit and `--terse` omits it. A capability declares its own, so the next extension point anywhere is a line in the report rather than a new check in the CLI.
  
  A project that composes no plugins is unchanged: one migration, no extensions, the same four plugins in the same order.

- [#289](https://github.com/pithy-sh/pithy/pull/289) [`e04870f`](https://github.com/pithy-sh/pithy/commit/e04870fab31169f0721e9625ef8609f66a0a9f5d) Thanks [@kingmesal](https://github.com/kingmesal)! - A failed migrate names what failed, and doctor sees a ledger row nothing declares.
  
  `pithy migrate` said, in full: *Migration run failed. Fix the migration. Run pithy migrate again.* No database, no migration, no cause — because the cause went to `detail`, which the terminal renderer never prints and the HTTP codec strips. Kysely had already named both. The runner now puts the migration, the binding it was running against, and what the runtime actually said into `message`, and keeps the throw-site half in `detail`: *Couldn't apply "0900_board_0003_broken" on DB. D1_ERROR: no such table: no_such_table: SQLITE_ERROR.*
  
  And the state behind that particular failure was not a broken migration at all. The ledger held a migration the project had deleted, which Kysely reads as a corrupted chain and refuses the whole run over. `pithy doctor` called the same database `migrations none pending ✓`, because pending is declared minus applied and a subtraction cannot see an extra.
  
  `readMigrationLedger` now asks both directions of one database in one read, and every caller takes the comparison rather than one side of it — `countPendingMigrations` is gone, replaced by `readProjectLedger`. `pithy migrate` refuses before it writes, at the same choke point that claims a database's owner; `pithy doctor` reports it on the `migrations` line and fails its exit. Both print the same sentence, from one writer: *DB records 0900_board_0002_tenant. This project no longer declares it.*
  
  "Fix the migration" is the wrong remedy for that — no migration is broken — so the action line says which case applies, from what the tool already knows. On `dev` the store is Miniflare's under `.wrangler/state` and deleting it costs a re-migrate. Anywhere else it is a database with real rows in it, where the same advice would be data loss, so the line says to restore the migration or remove its `pithy_migrations` row instead.

- [#293](https://github.com/pithy-sh/pithy/pull/293) [`d60e1da`](https://github.com/pithy-sh/pithy/commit/d60e1daefdb57d81dd1ddeb04f805b2eb23d9807) Thanks [@kingmesal](https://github.com/kingmesal)! - Key rotation goes through the seam that enforces it.
  
  The control plane has exposed `POST {basePath}/keys` since it shipped — `requireControlPlane(KEYS_ROTATE_SCOPE)`, signed with the key it replaces, audited on the adopter's own side. `pithy dashboard rotate` did not use it. It opened the adopter's D1 through `openConnectionRegistry` and wrote the same `keys` column the route governs.
  
  Not duplicated logic: both paths call core's `appendKey`, so the ordering rules were always shared. A duplicated **authority**. The safety property lived in a function rather than at a boundary, so it held for callers who remembered to use it and for nobody else — and three things followed only from the route. The grant was never checked, so a connection with no `keys:rotate` rotated anyway. The adopter's trail recorded nothing, on the one change that decides who may call them. And the CLI needed D1 write access to do ordinary work.
  
  **`rotate` now asks the management client to register the successor at the adopter's Worker**, sending the seam's address from the adopter's own row rather than trusting the client's memory of it. The CLI writes nothing. A Worker that cannot be reached fails the rotation and changes nothing, where the old path wrote the key locally, failed the ping, and left the two sides disagreeing about which keys existed.
  
  **One rule replaces the convention**, stated as a property and enforced in the registry rather than at its call sites:
  
  > The CLI adds a key to a connection only when no live key exists to sign for one through the seam.
  
  That is first connect — nothing can sign, and the Worker may not be deployed at all, so requiring a running Worker to register the key that lets anyone talk to it would be a chicken-and-egg with no exit. The same sentence covers recovery from a connection whose every key was revoked, because it is the same fact. `connectionRegistry.appendKey` refuses while anything is live, `save` may create or replace a connection but never rewrite the keys of one it is keeping, and a test asserts that no other module in the CLI opens that table at all. Revocation stays outside it deliberately: it removes trust, and revocation needing the Worker's cooperation would not be revocation.
  
  `connect --public-key` therefore registers a first key and refuses a successor while one is live, printing the call to make instead — the CLI holds no private half and cannot sign for you. Re-offering the key already registered is now an address re-point rather than a duplicate-id error, which is what that path needed to stay usable.
  
  **Two contract changes for management clients.**
  
  - `rotateKey(token, connectionId, address)` takes the seam's address and returns `{ keyId, validFrom }` — no key material, because the CLI no longer writes the key. Implementations must register at `POST {basePath}/keys`, signed with the key being replaced, and must fail rather than report a key they did not register.
  - `ConnectionHealth` gains a required, nullable `keyId`: which key answered the `ping`. **This is what proves a rotation.** The seam echoes the verifying key precisely so a client can tell which one answered, and a rotation is reported connected only when that is the new key — a ping answered by the key being replaced proves the connection, not the successor the next step would expire the old one on the strength of.
  
  That check was first written as a re-read of the adopter's row and the end-to-end run refuted it: locally the CLI's D1 handle and the Worker's are two runtimes, so a registration the Worker had just committed was invisible to a reader that had already opened the file — a correct rotation failing on a stale read, in the environment everybody tries first.
  
  `docs/CONTROL-PLANE.md` §15 now names every operation, where its write happens, and why exactly one is exempt.

- [`4611470`](https://github.com/pithy-sh/pithy/commit/46114709c054891101aa4339150e522bdc8154eb) Thanks [@kingmesal](https://github.com/kingmesal)! - Sell through Paddle. A fifth payments rail — overlay, inline or hosted checkout, coupon codes, signed webhooks, a customer portal with per-subscription deep links, and a nightly events sweep — resolving to the same entitlements as Apple, Google, Stripe and Lemon Squeezy, with the merchant of record handling your tax.
  
  `rails.paddle` turns it on, a product carries `paddle: { priceId }`, a `paddle` settings block declares the account and the publishable client token, and the credential bundle gains an optional `paddle` block with `apiKey` and `webhookSecret`. `POST /payments/webhooks/paddle` takes the deliveries.
  
  **`CheckoutRail` no longer returns `HostedSession { url }`.** Paddle's overlay and inline checkouts never leave the adopter's page, so there is no address to return — only an empty string, or a lie. `CheckoutHandoff` is a union: `{ kind: "redirect", url }` is what Stripe and Lemon Squeezy return, unchanged in every field, and `{ kind: "paddle", transactionId, clientToken, environment, displayMode }` is what a browser opens with Paddle.js. `PortalHandoff` widens the same way, so a subscription screen can render one subscription's cancel and update-payment-method links rather than one "Manage billing" button. On the client, `startCheckout` answers three outcomes instead of two: told "left" for a rail that never leaves, a paywall's button silently does nothing.
  
  The client projection is now keyed by rail — `products[].skus.{stripe,lemonSqueezy,paddle}` — plus a `paddle` block carrying the three facts Paddle.js needs to initialize. A screen asks `skus[rail]`, which cannot fall out of date when a rail is added.
  
  **Signature verification is this rail's own, and the reason is two characters.** Paddle sends `Paddle-Signature: ts=…;h1=…` and signs `${ts}:${body}`; core's `signed-webhook` splits on `,` and joins with `.`. Neither is a parameter there, deliberately. The freshness window defaults to **300 seconds, not the 5 Paddle's SDKs use**: replay protection rests on `UNIQUE (rail, providerEventId)` over `evt_…`, which is absolute, and a five-second window converts ordinary clock skew into a dropped renewal. `paddle.webhookFreshnessSeconds` sets it.
  
  **Ownership travels with a proof, not just a stamp.** `Paddle.Checkout.open` accepts `customData` beside an `items[]` array with nothing but the publishable client token, so a browser can write `custom_data.pithy_user`. The rail honors a stamped reference only when an HMAC over `(environment, user)` — keyed with the notification destination's secret, and domain-separated from the body signature — verifies beside it. Unlike Lemon Squeezy this rail does implement `verify`: a submitted `txn_…` is a pointer, and the proven stamp is the authorization, which is what makes a `dev` purchase reach the database when its webhooks land at `staging`.
  
  A subscription writes two rows, as on Lemon Squeezy: a `role = 'state'` row keyed on `sub_…` carrying access, and a `role = 'charge'` row per `txn_…` carrying the money. A subscription's transaction is born `expired` — a closed, paid billing period — so it credits a `grants` clause and never outlives a cancellation. A one-off transaction is `active` and never expires.
  
  `pithy_payments_sync_cursors` is new, and it is the whole state the events sweep keeps: one opaque resume token per stream, no customer, no amount, no event body. The sweep walks `GET /events?order_by=id[ASC]` filtered to the event types the map acts on — the filter is in the query, because the account-wide stream carries `client_token.created` whose token Paddle does not redact — and projects each event through the same map a webhook uses, writing through the same webhook-events table so a swept event already delivered is a no-op. Its cursor advances only past events fully projected, and a cursor older than Paddle's 90-day retention reports a gap rather than restarting from the beginning. This is the repair `refresh` cannot make: a purchase with no local row is invisible to `refresh` forever.
  
  Three places the API disagreed with the design and the API won. There is no `data.mode` field distinguishing sandbox from live — Paddle Billing partitions by account, so `paddle.environment` decides it. `transactions.create` refuses **account-wide** until a default payment link is set in the dashboard, not only in hosted mode, so `pithy doctor` asks first. And the portal's links are 24-hour bearer tokens carrying subscription-update and transaction-create scopes, not the single-use links they were described as — never cached, never persisted, never logged.
  
  Paddle enforces `^[a-zA-Z0-9]{1,32}$` on a discount code where this package's `DiscountCode` is wider. The shared schema is unchanged — narrowing it would refuse codes the Stripe and Lemon Squeezy rails accept today — so the Paddle rail refuses what it cannot mint and names the two characters, because Paddle's own refusal is the string `"Invalid request."` with no field named.

- [`953ff0e`](https://github.com/pithy-sh/pithy/commit/953ff0e3939024c1c00beb95fcb900a9ac22497a) Thanks [@kingmesal](https://github.com/kingmesal)! - A secret's entry in `secrets.jsonc` is the payload its destination receives.
  
  Nothing wraps it, nothing unwraps it, and no secret is an exception. The file stated a `{ currentVersion, versions }` envelope for every secret, including `SECRETS_ENCRYPTION_KEYS` — whose binding is read before any envelope decoder exists, so the seeder took the envelope off again on the way out. One concept with two `currentVersion` fields, carrying no information, and reported as file corruption by two readers in a row.
  
  `SECRETS_ENCRYPTION_KEYS` is now stated as a bare `EncryptionConfig`. `bindingValue()` is gone, along with the `bootstrap` branch it existed to switch on: there is no asymmetry left. `devSecretPayload` is the one reading of an entry, and it answers every form anything downstream needs — the payload, the string a binding carries, the envelope a D1 row holds, the current value. The registry entry decides which shape a name takes, so a reader determines any secret's shape without a special case.
  
  **The reader shipped before the writer**, which is the one thing the earlier review of this was right about: the old wrapped shape still reads, so a project that has not upgraded is not broken by a newer reader. `pithy seed` — and so `pithy dev` and `pithy add` — restates a wrapped entry in place and says which one it moved. The binding a Worker receives is byte-identical across the upgrade; migrating is not a key rotation, and a key rotation here orphans every secret encrypted under the old one.
  
  `loadDevSecrets` takes the registry when a caller has one, and `pithy secrets edit` now resolves and passes it — an edit is judged against the payload each secret's destination takes, where before no reader of that file could judge a shape at all. Without a registry the file is still checked as JSONC, because the project whose config will not load is exactly when somebody reaches for that command.
  
  `defineSecretRegistry` refuses `bootstrap` beside `devValue`. Nothing may mint the value every other secret is read through.

- [`3609c2a`](https://github.com/pithy-sh/pithy/commit/3609c2a56e7388e1931dcb52be74390df38d6472) Thanks [@kingmesal](https://github.com/kingmesal)! - A global secret has one value in every environment, or provisioning stops.
  
  `mintDeclaredSecrets` dispatched `ensure` — write when absent, skip silently when present — once per environment. That is a per-environment answer to a cross-environment question, and it broke the property it was written for. A run that wrote staging and lost prod, re-run, minted a **second** value, found staging present, skipped it, and wrote the second value into prod. Two environments, two values, no error, and every link signed by one refused by the other. `global` exists so a link signed in staging verifies wherever the recipient's click lands; that is precisely what it stopped doing.
  
  The decision moves in front of the writes. `runWriteSecret` takes `probe` instead of `ensure` — a store read that writes nothing and answers `present` or `absent`, in the manager, because a `d1` value is sealed under a master key the CLI never holds. `SecretProbe` is the CLI seam for it, separate from `SecretDispatcher` because a read and a write are opposite contracts and folding one into the other is how a check becomes the write it was meant to gate. Every target is asked, then one decision is taken: all present, nothing happens; all absent, one value for a `global` secret and a fresh one per environment otherwise; **split, and the run fails**, naming the secret and both sides. Repairing a half-written signing key is a choice with consequences that differ by secret, so the tool does not make it.
  
  The writes are `create`, which raises on a name already there. Probing narrows the race between two concurrent runs; `create` closes it — the loser is refused at its first write instead of fanning its own value into the environments the winner has not reached. `ensure` is gone: a mode whose whole behavior is to be quiet had no safe caller.
  
  `mintSecretValue` is now called only for environments known to be empty. It used to run for every declared secret on every run, before absence could be known, so a nightly `pithy secrets provision` generated fresh 256-bit key material for already-provisioned secrets and deposited it, unused, in retained Workflow instance params. On a provisioned project nothing is generated at all.
  
  The write Workflow returns what it did. `pithy secrets provision` says `created in staging, prod` or `already in staging, prod` rather than the unfalsifiable `ready`, and the CLI decodes that output through Zod — an answer it cannot read stops the run, because "unreadable" defaulting to "absent" is the one wrong answer that mints over a live key.
  
  `pithy provision --env` and `--feature` still create no `d1` secret: they run before the managers are necessarily deployed, and only a manager can answer for one. They now say so. A run names the secrets it is leaving absent and the command that makes them, from the same predicate the creator uses, so a capability that declares an arbitrary secret tomorrow is named without anyone maintaining a list.

- [`cd5c150`](https://github.com/pithy-sh/pithy/commit/cd5c1504739fbf39513cd5b0dc469093007df903) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy secrets rotate` — a secret declared how it rotates, and now something rotates it
  
  [#322](https://github.com/pithy-sh/pithy/issues/322) landed the declaration: `rotation.kind` of `local`, `provider` or `manual`, per secret, crossing into `pithy.manifest.json` so any client can branch on it. Nothing acted on it. `pithy secrets` had `create`, `update`, `rm`, `ls`, `edit`, `provision` and `deprovision`, and a management client could not honestly draw a rotate control over a command that did not exist.
  
  ```
  pithy secrets rotate <NAME> --env <env> [--dry-run] [--json]
  ```
  
  **Built around the one failure it cannot undo: a provider roll succeeds and the store write fails.** The old credential is dead at the issuer, the new one exists only in the process that received it, and rolling again issues a third value and loses the second — so the retry meant to save it is what destroys it. The ordering is the design. Every refusal happens before anything is called; the value is produced exactly once; the store is retried three times against that same value and never reaches back for a fresh one.
  
  That state is reported as its own outcome, with the secret named and the environments still holding the retired credential named beside it, and it exits **3** — distinct from `1`, which means the previous value is still live and the command can simply be run again. It carries its own error code, `secrets/rotation_unrecorded`.
  
  **The value is discarded when the store will not take it, and the failure says so.** Printing it would leave a live production credential in shell scrollback, in the CI log, and in whatever recorded the session — permanently. The failure instead names the issuer, its documentation page, and the `pithy secrets update` that records a value rolled by hand, all composed from the declaration [#322](https://github.com/pithy-sh/pithy/issues/322) added. The rotation result has no field that could carry a value, so this is structural rather than a habit.
  
  - **`local`** re-mints from the same recipe that created the value. **`provider`** calls a rotator attached to the registry entry — the seam `rotation/valueRotator.ts` declared inert and this makes live. **`manual`** prints the console, the page, and the command that records the result, calls nothing, and never prints `Done.`
  - **`--dry-run`** resolves the declaration and stops. No account, no credentials, nothing rolled.
  - **No `--all`.** A fleet rotation wants more than one confirmation *and* an audit entry naming the operator, and a CLI audit records `system, actorResolutionFailed` when no Cloudflare token names one. The act most certain to be reviewed afterwards would be recorded as *somebody with the token*. `pithy secrets ls` and a shell loop force the operator to see the list first.
  - `SECRETS_ENCRYPTION_KEYS` is refused by name: it is the key every other secret is read through, and it rotates on its own axis inside the manager.
  - Rotations are audited as `secrets/rotated`, `critical` on the unrecorded state, carrying the name and the environments and nothing else.
  
  Driven end to end with the real binary against a local stand-in for the Cloudflare Workflows API, including the forced roll-succeeded-store-failed path — asserting the rotator rolled exactly once across three store attempts, and that no value it issued reaches either stream or any file the CLI writes.

- [`9cc7a04`](https://github.com/pithy-sh/pithy/commit/9cc7a04edaf54eb4620c30ef7091c25d150a492d) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy doctor`'s eleven probes each keep their own failure, and none of them can take the report.
  
  Eleven checks contribute to a doctor report. **Five could take the whole thing down** — a throw from the Cloudflare probe, the project-name check, the worker-name check, the environments check or the dev-login check propagated out of `buildDoctorReport`. **Six were caught into `null`**, which in this payload already means *the question does not arise here*, so a check that failed was filed as a check that did not apply. The inconsistency was the worse half: the file read as though the question had been considered.
  
  Every probe is guarded now, and every failure lands as a `state` **on the value**.
  
  - `projectName`, `workerNames`, `environments`, `origins`, `workflows` and `secretBindings` use the `could-not-check` member their own types already carried.
  - `CloudflareAccess` gains `probe_failed` — deliberately not `not_checked`, which is the caller having *said* not to look. A diagnostic that blames offline mode for a credentials file that will not parse has sent the reader to unset a variable that was never set.
  - `DevPreferencesCheck` gains `could-not-check`, which is not `absent` — that is the documented default and reads as "everything is as it should be".
  - `devSecrets`, `devSecretsFile`, `devVarsLocal` and `devVars` have no discriminant of their own, so their payloads sit behind one. Their finding fields are unreachable without narrowing, and a bag of empty lists can no longer be read as an all-clear.
  
  **`null` still means the question does not arise**, and that is what keeps the two apart: a project composing no `secrets` has no dev-secrets question; a project whose registry would not load has one nobody answered. A probe's own `null` is preserved rather than wrapped.
  
  **The guards are `try`/`catch`, not `.catch()`, and that is not style.** Every probe is an injectable seam, and a seam that throws *before* returning a promise is not a rejected promise — `.catch()` never sees it, and the report dies exactly as it did before the guard was written.
  
  No new state fails the exit. A check that did not run established nothing, which is the standard this report already holds `unconfigured`, `not_checked` and `could-not-check` to. Every one of them keeps the report verbose, on the rule `Alias: unknown` follows: "I could not check" is information.
  
  **Nothing from a throw travels.** Every guard takes no binding. These probes read config files, `.dev.vars` and Cloudflare credentials, so what they throw names paths, account ids and sometimes a value.

- [`a29e28b`](https://github.com/pithy-sh/pithy/commit/a29e28b3f602f7168a992a7e0e016da8cc753abc) Thanks [@kingmesal](https://github.com/kingmesal)! - A database whose ledger will not read costs its own entry, not the project's.
  
  `readProjectLedger` fanned out over every database an environment declares and summed what it found. One unreachable D1 — a revoked token, a database deleted out from under a `wrangler.jsonc` — threw out of that loop, and the whole comparison was lost: every other database's pending count and every undeclared migration it had already found went with it. `pithy doctor`'s migrations line, `pithy upgrade`'s plan, and `pithy deploy`'s schema-is-behind warning all read that one call.
  
  Each database is read under its own guard now, and a database that will not answer is **named** rather than absorbed into a smaller sum.
  
  Guarding the loop was only half of it. A sum over four databases out of five is not the same number as a sum over five, and `{ pending, undeclared }` had no way to say so — so `pending: 0` about a project whose D1 was unreachable read exactly like a project that was level. `ProjectLedger` is a three-state value now: `read` carries the counts flat, `partial` nests them under `counted` beside the databases it could not include, and `unavailable` carries no number at all. The states share no field, so `ledger.pending` does not compile without narrowing and a short sum cannot be read as a whole one.
  
  Enumerating the databases stays load-bearing and still throws. `contextFor`, `scopedGroups` and `driverFor` decide *what* the aggregate is over, so their failure is not one contributor missing — it is there being nothing to aggregate.
  
  **Nothing from the failure travels.** The guard takes no binding, and an unreadable database is recorded as its name and its binding — the two facts an operator can act on. What a D1 read throws names an id, a token, or a query.
  
  `pithy upgrade --json`'s per-Worker plan replaces `pendingMigrations` with `ledger`; `pithy doctor` prints which databases went unread and says that every number beside them excludes those.

- [`4c4a992`](https://github.com/pithy-sh/pithy/commit/4c4a9923a5326bdd0fdc0bc889cf4d0c23486e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - A Worker that could not be checked stops erasing every other Worker's health.
  
  `buildProjectHealth` built one reconcile plan per Worker in a bare loop. A plan reads that Worker's own `pithy.config.ts` and `wrangler.jsonc` and, through the ledger, its databases — so any of it can fail for reasons belonging to one Worker. The throw propagated, and `pithy doctor` lost every *other* Worker's config, bindings, migrations, entitlement and prerequisite lines. That is the command whose whole job is saying which part of a project is broken.
  
  **The asymmetry is the point.** This function's manifest half was degraded per package under [#184](https://github.com/pithy-sh/pithy/issues/184) and its per-Worker half never was. The fix was agreed in this file; it had been applied to one loop and not the other.
  
  `WorkerHealth` is a two-state value now. The five checks live behind `checked`, and `unavailable` carries nothing but the Worker's name — no `ok`, no empty drift lists, no `0 pending` to mistake for a clean bill. The state rides on the value, so an unchecked Worker cannot be rendered as a checked one.
  
  It still fails the exit, on the standard [#184](https://github.com/pithy-sh/pithy/issues/184) set: a check that did not run established nothing, and calling a project healthy around a hole is the under-report both exist to prevent. That is also what the behavior already was — the throw reached `pithy doctor`'s catch and drove a non-zero exit — so the CI gate does not weaken, it only stops taking the rest of the report with it.
  
  The manifest scan is deliberately not guarded here. It is read once at the project and every plan is built from it, so it is the loop's input rather than one of its contributors.
  
  **Nothing from the throw travels.** The guard takes no binding. The Worker's name is the actionable fact, and `pithy doctor` already prints it.

- [`7b0cd47`](https://github.com/pithy-sh/pithy/commit/7b0cd4726c753fa2c92ba2563a0982593a07862c) Thanks [@kingmesal](https://github.com/kingmesal)! - A reconcile plan keeps its four other answers when one contributor throws.
  
  `buildReconcilePlan` gathers five contributions per Worker — the capability manifests, the config source, the wrangler stanzas, the migration ledger, and the entitlement scan. Three of them had degraded per contributor since they were written. Two had not: the ledger read and the entitlement scan both threw straight out of the plan, so an unreachable D1 or a source tree that would not walk cost `pithy doctor` and `pithy upgrade` the whole report for that Worker — including every capability's binding and config drift, which was already in hand.
  
  Both are guarded now, and neither is load-bearing: a plan is a report, and a report is what an adopter reads to find out why something is wrong.
  
  **Each failure is a state on the value, not an empty list.** `ledger` gains `unavailable`, which carries no count for a caller to render as `0 pending`. `entitlementGap` becomes `entitlements`, a two-state value whose file list lives behind `read` — because an empty array said "no gap" and "no scan" in the same two characters, and only one of those is good news. `pithy doctor` prints the difference; a check that did not run no longer reads as a check that passed.
  
  **Nothing from either throw travels.** Both guards take no binding. `readLedger` reaches a customer's D1 and the entitlement scan walks their source tree, so both throw with ids, queries and absolute paths in them — and this plan is what `pithy upgrade --json` prints.
  
  `pithy upgrade --json`'s per-Worker plan replaces `entitlementGap` with `entitlements`.

- [`d98af1b`](https://github.com/pithy-sh/pithy/commit/d98af1bcada805907e7dffe8b1865ac5c1410fbe) Thanks [@kingmesal](https://github.com/kingmesal)! - A feature teardown that failed partway says what it destroyed.
  
  `deprovisionFeature` deletes real Cloudflare infrastructure one resource at a time, with no transaction across them, and the list of what went is the whole product of `pithy feature destroy`. A throw from the fourth delete took the record of the first three with it: the databases were gone and nothing anywhere said so, on a command that runs headlessly in CI.
  
  The report is carried on the failure now, through `partialWriteReport` — the mechanism [#324](https://github.com/pithy-sh/pithy/issues/324) built for exactly this and which lives next door. `deletedBeforeFailure(error)` reads back every resource deleted, by `kind`, `name` and `id`. `destroyFeature` moves it onto its own report and `pithy feature destroy` prints it before rethrowing, with `"interrupted": true` under `--json`.
  
  **The manifest is now removed only on a clean pass.** It is the record of what is left to delete, and a teardown that failed partway is precisely when a re-run needs it. The local half — freeing the port block, pruning the worktree — deliberately does not run either: the worktree is where the re-run happens from.
  
  **Nothing from the throw travels.** The three recorded facts are the ones an operator finishes the teardown by hand with.

- [`e1f23ba`](https://github.com/pithy-sh/pithy/commit/e1f23ba86eb318690528a284a78d162a26ca95ce) Thanks [@kingmesal](https://github.com/kingmesal)! - A migration run that dies partway says which databases it already moved.
  
  `runGroups` is `pithy migrate`'s write half — the one loop every entry point that changes a schema comes through, in the file whose *read* half [#371](https://github.com/pithy-sh/pithy/issues/371) fixed. It visited one database at a time with no record surviving a failure: the third database's pass threw, the first two were already ahead of it, and the per-Worker report that would have named them died with the throw. That record is the thing you need most when a run dies mid-fan-out.
  
  The run still stops at the first failure and still throws — a pass that failed for a reason belonging to the whole run should not carry on writing to the databases behind it. What changed is that the report rides out on the failure, through the same `partialWriteReport` channel `mintDeclaredSecrets` carries its minted secrets on ([#324](https://github.com/pithy-sh/pithy/issues/324)). `migratedBeforeFailure(error)` reads back three things that share no entry: `migrated`, the per-Worker rows for every database whose pass completed; `failed`, the one it died on; and `unreached`, every database it never opened. An empty `unreached` means the failure was on the last database, never "nothing was scanned".
  
  `pithy migrate` prints that to stdout before rethrowing, so the failure line on stderr, the exit code, and the report agree — `--json` carries `"interrupted": true` beside `failed` and `unreached`.
  
  `scopedGroups`, `claimGroups` and `assertLedgerDeclared` stay unguarded. They decide what the run is over and whether it may write at all; `claimGroups` in particular is the choke point that refuses another project's database, and a guard around it would be a guard around the refusal.
  
  **Nothing from the throw travels.** The guard takes no binding, and a database is recorded as its name and its binding — what a migration throws names a statement, a table, or an id.

- [`f5aac23`](https://github.com/pithy-sh/pithy/commit/f5aac2348386df0135f99c7c5d1c4cde68e29ddc) Thanks [@kingmesal](https://github.com/kingmesal)! - A Worker that could not be reconciled stops erasing every other Worker's upgrade.
  
  `runUpgrade` fanned out over `apps/*` building and applying one plan per Worker, in a bare loop. A plan reads that Worker's own `pithy.config.ts` and `wrangler.jsonc` and, through the ledger, its databases; an apply **writes** those files and, with `--migrate`, runs that Worker's migrations. Any of it can fail for reasons belonging to one Worker, and the throw propagated — so a five-Worker project lost four Workers' reports to the fifth's broken config, *after* some of those Workers' files had already been rewritten. Infrastructure changed, record gone.
  
  This is `buildProjectHealth`'s defect at its twin, and worse for that reason. [#371](https://github.com/pithy-sh/pithy/issues/371) fixed the one and not the other.
  
  `UpgradeWorkerResult` is a three-state value now. `reconciled` carries the plan and what applying it changed. **`unplanned` carries the Worker's name and nothing else** — nothing was read about it and nothing was written for it, so there is no plan to mistake for an empty one. **`unapplied` carries the plan and no applied record**, because that Worker's files *have* been opened: its `wrangler.jsonc` may hold part of the plan and under `--migrate` its schema may have moved, and telling an operator to re-run against it as though it were untouched is the report this state exists to refuse.
  
  Either failure still **exits 1**, on `pithy doctor`'s standard: a Worker that was not reconciled established nothing, and exiting 0 around it would be a weaker gate than the throw it replaces. Every *other* Worker now reports in full.
  
  Resolving the Worker set stays unguarded on purpose. It decides *what* the run is over — the loop's input, not one of its contributors — so a `pithy.config.ts` that will not import still fails the whole run.
  
  **Nothing from the throw travels.** Both guards take no binding. `pithy upgrade --json`'s `workers[]` entries lead with `state`.

- [#408](https://github.com/pithy-sh/pithy/pull/408) [`abf5e6f`](https://github.com/pithy-sh/pithy/commit/abf5e6f26c825b49ed9e6bd5e2196c463b63bd53) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy --help` groups its commands: Project, Develop, Operate, Capabilities, Toolchain.
  
  The root screen listed every command in declaration order under one heading, behind a `USAGE` line that alternated all of them before a single description appeared — a line already wider than a terminal, and one that grew with every capability that landed. Nothing on it said `email`, `media` and `turnstile` are the same kind of thing and `deploy` is not. The `USAGE` line is now `pithy <command> [OPTIONS]`, because the alternation was never information.
  
  **The grouping is display only.** `pithy email provision` is still `pithy email provision`. Putting the group in the command path would rename nine commands, add a segment to every doc page and every agent's call, and buy a screen what a blank line already buys it.
  
  **The group is declared on the command, so it cannot be forgotten.** The obvious spelling — a table of names per group — is a second list of the command set, and the drift has a bad direction: a command added to the tree and missing from the table would not fail, it would *vanish* from the one screen whose job is to say what the CLI can do. So `main.ts` holds one record with `group` as a required field typed to the five names, and `subCommands` is projected from it. An omitted group is `TS2741` and a misspelled one is `TS2820`. There is no catch-all group and no gate, because there is no state to catch.
  
  **Only the root screen moved.** `pithy add --help`, every group screen, and the screen after an unrecognised name one level down are still citty's `renderUsage`, byte for byte. The root screen keeps citty's shapes on purpose — the same right-aligned name column, the same four-space gutter, the same closing pointer — because the two sit one keystroke apart and a root screen that repainted itself would read as a different program.
  
  `pithy nonsense` prints the grouped screen too. citty reaches its own `showUsage` for an unresolved name with no parent, so the override is handed to `runMain` as well as to the usage walk; wired one way only, the CLI would ship two root screens that drift, and the second reachable only by making a mistake.
  
  Group headings are bold basic-16 magenta through `terminal/style.ts`, which is what makes piped help plain and `FORCE_COLOR` help colored — the seam every other colored character already flows through. Not saffron: a heading carries structure, and saffron carries meaning. `docs/CLI.md` §4.3 now states which screen is whose, and names the one divergence it leaves standing — with `CI` set on a terminal Pithy calls color-capable, the root screen carries color and citty's screens do not, because closing that would mean deleting `CI` from the environment of every process the CLI spawns.

- [#417](https://github.com/pithy-sh/pithy/pull/417) [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy dev` runs every Worker your project composes, and mail sent from localhost is delivered for real.
  
  Signing in with a magic link against `pithy dev` wrote a row, called `sender.create(...)` on a Workflow binding naming a Worker that was not running, swallowed the throw on purpose, and left the job `pending` forever while the screen said "Check your inbox." The safety net that justifies the swallow is a cron on the same absent Worker. A developer's first conclusion is that their Cloudflare Email Service setup is wrong, and they go and check it, because the product told them the mail was sent.
  
  **It was never an email problem.** Nine capabilities ship a committed host-Worker template — email, media, payments, storage, support, testers, vector, secrets and leaderboard — and `discoverWorkers` enumerates `apps/*` and only `apps/*`. No capability host had ever run under `pithy dev`. Email is simply the one with a symptom a person notices, because a magic link is the first thing anyone tries.
  
  **A host Worker is now an ordinary member of the dev set:** a pinned port, a label and color in the terminal and `logs/dev.log`, an entry in `.dev-state.json`, reaped with everything else. One `wrangler dev` per Worker — the process model did not change.
  
  **Pithy wires the dispatch; wrangler does not.** `<STEM>_PORT` and `<STEM>_ORIGIN` were already how a Pithy Worker reaches a sibling, so a Workflow dispatch travels that wire in three shared pieces in `@pithy-sh/core/src/workflow/`: a dispatch route a host mounts, which starts an instance against its own same-script binding and is **refused outside `dev`**; a loopback dispatcher satisfying the one-method seam by posting to `<STEM>_ORIGIN`; and a host env contract. Deployed environments keep the cross-script binding untouched.
  
  **A host states what it is missing, at boot.** `EmailWorkerEnv` is fourteen fields and nothing validated any of them: a missing `BASE_URL` became a link to `undefined/…`, an unparseable `EMAIL_THEME` threw inside a render step, a `SCHEDULER_BATCH_SIZE` somebody typed as `"fifty"` became `NaN` and the scheduler claimed nothing, quietly, forever. Every one of those was discovered as a mail that did not arrive. Now it is a Zod object with a `.describe()` per field, validated at startup, logging each missing value beside the binding, var, command or config key that provides it.
  
  **`enqueue` stopped reporting a send it knows cannot happen.** A structurally absent dispatcher is a configuration fact known at compose time, not a transient error, so the row is born `undispatched` and the result says so. A dispatcher that is present and throws keeps exactly its old behavior — the safety net is real then. `undispatched` is not a dead end: the scheduler claims those rows beside `pending` under the same grace window, because a tick running at all is the host existing.
  
  **`dev` sends for real by default** — `"remote": true` on the host's `send_email` binding, the same pipeline and DKIM as `prod`. When there is no usable Cloudflare login or the sending domain is not onboarded, that is said before somebody is waiting on an inbox, and the session falls back to the local simulator with one line in the banner rather than dying or going quiet. The simulator is also reachable deliberately, which is what CI and a plane want.
  
  The feature port block widened from 10 to 20, pinned against the host count, because eight hosts plus a two-Worker scaffold filled a block of 10 exactly and a third Worker threw.

- [#417](https://github.com/pithy-sh/pithy/pull/417) [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy doctor` checks that your capabilities' settings work, not only that they are wired.
  
  Config drift, required bindings, the migration ledger, project name, worker name, environments, dev vars, secret bindings — every check `doctor` had was a question about presence. None was a question about the value. So a project could be entirely green while `fromAddress` named a domain nobody onboarded, the link-signing key was never created, `BASE_URL` was staging's URL in production's config, `EMAIL_THEME` did not parse, or the suppression database did not exist. The option key was there, the binding was declared, the migrations were level, and no mail arrived.
  
  A capability now declares a settings check on its `Capability` object, beside `health`. **Discovery keys on the capability instance and never on `pithy.manifest.json`** — `@pithy-sh/matchmaking` and `@pithy-sh/rating` are published capability packages that ship no manifest, and a manifest-keyed rule silently skips both. That is the same trap the version stamper documents, and it is not walked into twice.
  
  **One schema, two readers.** The local tier validates through the same Zod object the capability's host Worker validates at boot: the Worker refuses to serve without it, `doctor` reports it before anything is deployed, and neither can drift from what the code actually requires — which is the failure a hand-written doctor check has every time.
  
  **Two tiers, and three outcomes.** Local is pure and offline and always runs. Account costs a Cloudflare call. Both are faults: a local finding makes the project unhealthy and `doctor` exits non-zero, and an account finding does the same *when the account was reached*. When it cannot be reached, the account tier is reported as **skipped** — never as passed, and never as the account's fault when the failure was local. A check that never ran keeps the report verbose rather than letting silence read as a pass.
  
  Every finding renders as a problem line and an action line naming the `pithy` command, config key or one-time account action that resolves it, and every finding and every skip appears in `--json`. The check never writes anything.
  
  `@pithy-sh/email` declares the first one. A `Local delivery:` block joins it, backed by the same `deliveryPreflight` call `pithy dev` decides with, so the two commands cannot disagree about whether mail will go out. It never gates the exit — running the simulator is a choice — and it prints even in the terse report, because silence there reads as "of course it sends".
  
  `secretBindings` and `devVars` are untouched. The account tier is simply where "does the store entry exist" is finally asked, which `secretBindings` deliberately refuses to.

- [`4ef5951`](https://github.com/pithy-sh/pithy/commit/4ef595178dddfc38e128f16c560cb9aa7769f1ae) Thanks [@kingmesal](https://github.com/kingmesal)! - A Durable Object class the config names is exported by the entry, so the project deploys.
  
  `pithy add multiplayer` wrote both halves of the wrangler config for a Durable Object — the `durable_objects.bindings` entry naming a `class_name`, and the `new_sqlite_classes` migration tag registering that class against the script — and neither half says where the class *is*. wrangler resolves `class_name` against the entry's module `main` names and refuses the deploy when nothing there exports it:
  
  ```
  Your Worker depends on the following Durable Objects, which are not exported in your entrypoint file:
  MultiplayerSession.
  ```
  
  The scaffolded entry is `export default createEntrypoint(config);` and nothing else, and `createEntrypoint` returns a value — a value cannot add a named export to the module holding it. So the last line was left to a human whose only prompt was a sentence of manifest prose. `pithy add multiplayer` and `pithy add matchmaking` produced projects that did not deploy, three classes between them, and the failure arrived at `wrangler deploy` rather than at the command that caused it.
  
  **The module is now the capability's to state.** `BindingSpec` gains `classModule` beside `className`, required for a `durable_object` binding and refused as a bare word — it is written into generated TypeScript, so it is validated as a module specifier rather than trusted as a JSON string. Every writer that touches a binding now writes the matching export: `add`, `remove`, `upgrade` and `--eject`. `pithy upgrade` had the identical defect and is fixed with the rest of them; a capability added by one command and reconciled by another cannot have two answers.
  
  **Reported, too, and not only written.** `pithy upgrade`'s plan carries `missingEntryExports` per capability and `pithy doctor` fails on it under `bindings` — a Durable Object is one binding written in two files, and a check that read only the `wrangler.jsonc` half called a project healthy that `wrangler deploy` refuses. That is the same defect one level up, so the plan reports what the apply writes.
  
  **The gate derives the rule instead of listing the classes.** For every manifest the repository ships, it takes the classes the real writer put in `durable_objects.bindings` and the exports the real scaffolder wrote into the entry — parsed with oxc, honoring `exportKind` so a type-only export does not count — and requires the second to cover the first. Neither side is enumerated, so a fourth class added tomorrow is covered by a test nobody has to remember to update. Watched failing against all three classes before any writer existed, and again with a `classModule` pointed at a module that does not exist.

- [`1bdf2c8`](https://github.com/pithy-sh/pithy/commit/1bdf2c894ecd16abc44e4d086d497fc221d10f59) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy dev` names the worker that started and never became ready.
  
  `wrangler dev` does not exit when a build fails. It prints the error and keeps running. So the child stayed alive, never matched its ready signal, and every mechanism `pithy dev` had was watching for the wrong thing: the banner waited for a set that would never complete, and the exit handler tears a session down when a child *dies*. This one does not die. The error was real and it was in the scrollback, above forty lines of other workers' startup, and then the session carried on looking healthy.
  
  That is how [#426](https://github.com/pithy-sh/pithy/issues/426) reached an adopter. Three capability workers had been failing to build, the support classification Workflow was not running, and what eventually surfaced it was a person reading a warning above an error in a log.
  
  Each worker now gets a deadline, and missing it prints who has not arrived, by name:
  
  ```
  Still waiting on: support.
  ```
  
  **Still waiting, not failed** — the orchestrator does not know which it is, and a worker this line names may be one bundle away from the banner. The deadline is ninety seconds, longer than any healthy cold start measured here, because a line that cries wolf teaches you to scroll past the one line that was ever going to reach you. It repeats every thirty seconds while the set is non-empty, because a single line at the deadline scrolls away exactly like the error did. `docs/commands/dev.md` states both numbers and a test pins the prose to the constants.
  
  **The line names the mechanism, never a cause.** A build error is what prompted this and is not the only thing it catches — a startup that hangs, a port that never binds, a binding that never resolves, and a `dev.command` worker where wrangler is not in the picture at all. What all of them share is the property that made the session look healthy: the child is alive, so nothing else in the run was ever going to mention it. The line says that, and points at the worker's own output for the reason, which is the only place the reason exists. It also says to restart, because a `wrangler dev` whose first build fails does not rebuild when you fix the file — measured against wrangler 4.123 — so editing and waiting is the one thing that cannot work.
  
  Under `--json` the report is a record rather than the sentence, so an agent driving `pithy dev --json` gets a machine-readable signal instead of a session that silently never emits its ready line.
  
  **And `pithy dev --json` now writes JSON to stdout and everything else to stderr.** Every line a person is told — the `Starting …` line, the delivery verdict, and the workers' own output, which is the bulk of the stream and every line wrangler and Vite print — used to share the descriptor with the machine-readable one, so `pithy dev --json | jq` choked on the first thing wrangler said. The rule is now one a consumer can apply: every line on stdout is one object. Both halves still reach the terminal, and `logs/dev.log` carries the lot in either mode.
  
  The deadline is measured from the moment the last worker is spawned, and the page says so. It used to say *after startup*, which charged a cold project's port verification, secrets and `.dev.vars` to a worker's budget — tens of seconds of a number an adopter reads to know when to expect the report.

- [`6b739f8`](https://github.com/pithy-sh/pithy/commit/6b739f877fb9155dc6cb9569228acc1cb7698439) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy doctor` lists the dev-port registry, not just its address.
  
  The `Ports:` line printed a path in `~/.config` and stopped there, so "why is this project on 8847" had no answer short of `cat`. It now prints what is in the file: this checkout's blocks first and unqualified, then every other checkout on the machine, each named by the path that holds it.
  
  Ranges, never block indices. A block's ports are `base + index × size`, so the index is the whole answer only while every entry is the same width — and a registry written before the width changed keeps its old entries verbatim. `8807–8826` is legible across both, and it is the form the question arrives in: the port you are looking at is the one `pithy dev` just refused to bind.
  
  `← not on disk` is the one line here anybody can act on. Pruning cannot tell a deleted checkout from a moved one, so a renamed repository has its blocks freed by the next allocation any project makes, and nothing anywhere reported that it happened. This row is taken before the sweep.
  
  Which blocks are yours is `registryRootFor`, the one function `pithy dev` allocates under — `git rev-parse` first, the project's own canonical path where there is no repository. Two derivations of that key is a report that calls your own block somebody else's, which is what a machine with no `git` used to get.
  
  Nothing new is recorded to support any of it — the registry was already `root → branch → block`. Nothing here can fail the exit either: every line reports a location, and a stale root is information, not drift. `--json` carries the whole registry, absolute paths, on `portsRegistry.entries`.

- [`1071ace`](https://github.com/pithy-sh/pithy/commit/1071aceaad8a9d9e4acc9ac8b14c239cdc6ffe31) Thanks [@kingmesal](https://github.com/kingmesal)! - Pithy speaks Spanish. Compose `i18n`, and every screen, error and email answers in the reader's language.
  
  **The seam is in `@pithy-sh/core`, and it is always there.** `c.var.t` is on every request whether or not you compose anything — a translator over the English each composed capability contributed through the new `Capability.messages` — so a capability writes `c.var.t.t("auth/invalid_token")` with no null check and no config, exactly like `c.var.log`. `@pithy-sh/i18n` replaces it with one that negotiated the reader's locale and merged the catalogs behind it. **A project that never composes it is byte-identical to one from before this landed**: same strings, same bytes, no negotiation. That property is what the whole design is arranged around, and it is why `Translator` lives in core while the capability stays optional — your own module can type against the seam whether or not you ever opt in.
  
  **Two locales, and only one of them falls back.** `catalogLocale` is the locale whose words answered, and it falls back: an `es-AR` reader reads `es`, because `es` is what somebody wrote. `formattingLocale` is what goes to `Intl`, and it does not: that reader gets `es-AR`, which `Intl` supports natively whether or not a translator ever did. So Buenos Aires gets Spanish sentences and Argentine dates, from one translator, with nobody writing an `es-AR` catalog. Collapsing the two is the bug the pair exists to prevent.
  
  **A catalog key is `<domain>/<path>`, and a capability may only write under its own name.** That is the `pithy_<capability>_<table>` rule and the `auth/invalid_token` rule for the third time, enforced by `composeMessages` for the same reason: the domain segment is what makes two capabilities' contributions incapable of colliding, so merge order stops being something anyone reasons about. It binds the adopter's own `app` capability identically — `board/nav.settings` is theirs, `auth/sign_in.title` is not. **Overriding** a kit key is always allowed and is one entry; **declaring** a new key under a kit domain is refused. Lookup is per key across the layers, never per catalog, which is what makes an override a merge rather than a fork.
  
  **The server never localizes an error, and that is a deliberate refusal rather than a gap.** `ErrorPayload.message` stays English permanently: it is simultaneously the operator's diagnostic in the log line and the audit row, and the fallback for every client that cannot do better, so translating it would lose the first to gain the second. The payload gains one optional `params` beside `message`, and a translating client renders `t.maybe(payload.code, payload.params) ?? payload.message`. **For an error the key is the code** — `auth/invalid_token` is a catalog key and an error code and the same string — so there is no second identifier to keep in sync and `KitErrorCode` is the exact checklist a locale has to cover. The schema edit is one line into `publicFields`, which is spread into all 120 kit members; `params` is optional and absent, so a body a client already receives is unchanged byte for byte, and `clientError`'s arity does not move.
  
  **A person's locale lives in exactly one place: `pithy_auth_users.locale`.** It is the one kit field on the user table declared `input: true` — a reader's own preference is the opposite of a device id, and refusing client input would leave an admin route as the only way to store one. What makes that safe is the validator, not the type: Better Auth runs the same `Locale` schema on the write that guards every read, so a caller cannot poison a row every listing then parses. It is nullable, and **null is not `en`** — it means nobody chose, which is what makes the server fall through to `Accept-Language`. Do not add a second home for it in a preferences table: display formatting is one fact and language is another, and two homes is a magic-link email in the wrong language with nothing failing to say so.
  
  **An email is rendered twice, so the locale rides on the row.** The subject renders at enqueue, inside a request that knows the reader; the body renders at send, inside a Workflow with no request on it at all. `pithy_email_jobs.locale` is what makes those two agree, and what lets an operator reading a send log see why a subject read the way it did. The seven templates whose words the kit writes are translated with it. The five whose words arrive as payload are not — their **shell** follows the job's locale and their copy is yours, so a notice at `es` reads its severity in Spanish and its summary in whatever the caller wrote. That is the right behavior and it is a surprise unless stated, so `docs/I18N.md` states both halves and says what to do about it.
  
  **The screens keep the only catalog that survives being copied.** Every seeded screen renders through `t.t(key)` now, and the English those keys resolve to sits in a `satisfies MessageCatalog` block inside the same file — because the file is yours from the moment it is written, and the English cannot live in a package you might never install. The translations are the other half and are **never copied into your tree**: they ship inside `@pithy-sh/i18n`, so a typo fix or a new language reaches you as an upgrade rather than as a merge. With a provider mounted the baked catalog goes **last** — your catalog, then the kit's translation, then the file's own English — and `useTranslator` never throws for want of one.
  
  **Coverage is a `pithy doctor` check, not a `pithy i18n` command.** For every locale you serve, every key reachable in the default locale must be reachable in that one too; a gap names the locale and the missing keys and already fails `doctor`'s exit code. That is the whole of what the command would have been, at none of its cost — no new page in `docs/commands/`, no row in the five exact-count and byte-pinned CLI gates a new command moves. There is no account tier: nothing about language is a question for the Cloudflare API.
  
  **Four gates, because every one of these properties is only true as a set.** `ci/catalogCoverage.test.ts` is repo-wide and derives the English side from the three places a kit sentence actually lives — the templates' baked blocks, `EMAIL_MESSAGES.en`, and `KitErrorPayload.options` — then compares it against `KIT_CATALOGS` in both directions, because a Spanish key no English key answers is a typo that is invisible forever. `ci/errorArgs.test.ts` exists because `params` landed in seventeen of eighteen throw-sugar arg types and the one that was missed compiled, linted and tested green. `ui-react/src/templateCopy.test.ts` sweeps the templates for prose outside a catalog, as a text sweep rather than a GritQL rule, because `JsxText()` never sees an `aria-label` and the sign-in screen's provider buttons carry their copy there. And `plugins/no-z-config.grit` bans Zod's global error map outright: a Worker isolate outlives the request, so a locale written there renders the next request's validation failure in the last request's language.
  
  **What stays English is a decision, and it is written down.** Operator surfaces — CLI output, `renderTerminal`, `--json` lines, logs, audit rows — are English permanently, so they stay greppable and keep matching the docs; `action` is the operator's field and names commands and bindings, which do not translate. **Zod's field-level `issues[]` also stay English in v1**, and that limit is stated in `docs/I18N.md` rather than left to be discovered: Zod 4.4.3 has exactly the right primitive in its per-parse error map, but `@hono/zod-validator@0.9.0` calls `safeParseAsync(value)` with no third argument and its `validationFunction` hatch receives `(schema, value)` and never the `Context`, so reaching it needs `AsyncLocalStorage` and is out of scope.
  
  **The Spanish is 242 messages and it says so about itself.** 120 error codes, 71 screen strings, 51 email strings, and every file in the locale directory carries `// LOCALE es — an unreviewed first pass. Not American English by design.` in its head. Two facts in one line, both load-bearing: the American-English census reads the tag rather than a path list, so it still reads a file declaring `en`, and a first pass that claims to be finished costs more than one that says what it is. The exact spelling is published in `docs/I18N.md` so an adopter's own prose census can teach it ours instead of inventing a second one.
  
  **`pithy_auth_users` gains its `locale` column by amendment, not by a second migration.** `auth_0001_init` is amended in place under CONTRIBUTING.md's pre-publish rule — every package is `0.0.0`, nothing is published, and no database anywhere holds a row a `0002` would have to carry across. `0001_init` *is* the schema. The day a version is cut this inverts, and the column becomes history that a migration adds rather than one the baseline declares.
  
  **One declaration of the kit's Better Auth columns, because two of them were already wrong.** `makeAuth`'s live options and the schema baseline `pluginSchemaDelta` subtracts each adopter plugin from were both written out by hand, each with a comment saying it must match the other and a test claiming to hold them together — a test that compared the baseline against the `User` schema and never imported `makeAuth` at all. There is one `KIT_USER_FIELDS` / `KIT_SESSION_FIELDS` now, imported by both, and nothing left to disagree with. Leaving a kit column out of that baseline is not cosmetic: `pluginSchemaDelta` reports it as something an adopter's plugin brought, and an adopter plugin also declaring a user `locale` then emits `ALTER TABLE … ADD COLUMN locale` against a table that already has one — a duplicate-column failure part-way through a migration D1 cannot roll back, because it has no transactional DDL.
  
  **Every other package here gains one optional `params` field on its throw sugar and nothing else**, which is why they take a patch: no behavior moves for anyone who does not pass it, and passing it changes only what a translating client can render.
  
  **Two additions to core's seams are worth knowing about even if you never compose `i18n`.** `Translator.maybe(key, params?)` answers `null` on a miss where `t()` answers the key, which is what makes `t.maybe(payload.code, payload.params) ?? payload.message` fall back at all — written against `t` it never does, because `??` sees a string and takes it. And `AuthContext` gains `locale`, published from the user row the session lookup already loaded, so a reader's stored language outranks their device's `Accept-Language` at no extra query.

- [#76](https://github.com/pithy-sh/pithy/pull/76) [`dd224b1`](https://github.com/pithy-sh/pithy/commit/dd224b1aeffcb0bc9b0c105015acc5b460817d94) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/storage` — general file storage in your own R2 bucket, with an owner, a quota, and a link you can take back. Uploads never proxy through the Worker: the client PUTs straight to a presigned URL, and anything past 100 MiB becomes resumable parts, so a 40 GiB file costs one request and not one byte of transfer. Downloads deliberately do stream through it, because a presigned GET is bearer-equivalent the moment it leaves your process — it cannot be re-authorized per request, cannot be revoked, and cannot carry a `Content-Disposition` you chose. So `GET /storage/:id` is a real request with `Range`, `If-None-Match`, `ETag` and 206/304/416 handled properly, and `GET /storage/:id/url` is the throughput escape hatch for callers who would rather have the bandwidth than the control. Those bytes are a user's and that origin is yours, so the serve path treats every object as hostile: `nosniff` and `default-src 'none'; sandbox` on every response, an active type (HTML, SVG, anything `+xml`, script) forced to `application/octet-stream` and `attachment` whatever was stored, and a `Content-Disposition` the server derives rather than replays. A declared `contentType` is a hint either way — a presigned PUT cannot sign one, so completion reads the type back from R2 and records that instead. Keys are server-derived `obj/<uuid>` and never appear in a response; the client supplies a logical path, and that path is what gets stored, indexed, and listed by prefix — so there is no traversal, no collision, and no contention on R2's one-write-per-second-per-key limit. A share link is a row rather than a signature, which is the only way "take it back" can exist; a withdrawn link answers `storage/share_revoked` and one that aged out answers `storage/share_expired`, because one is worth asking about and the other is worth re-requesting. Quotas count uploads still in flight, since a check that only counted completed ones would let ten concurrent 1 GiB uploads all pass a 1 GiB limit. A daily Workflow reconciles both directions of divergence between the bucket and the table — rows holding a reservation for bytes that never arrived, and bytes nobody is billed for — and it is a dispatch target as well as a cron, because a sweep you cannot run on demand cannot be tested in staging. The `ObjectStore` seam it is built on imports no D1, no route, and no storage config, so a second capability points it at its own bucket under its own credential name and inherits none of storage's tables or key policy. `@pithy-sh/media` is that second capability, today: its presigned uploads and downloads run through this seam against `MEDIA_BUCKET` under `media-r2-credentials`, so media builds no R2 client and never handles an R2 key pair — its reads and deletes stay on the bucket binding, where a credential would buy nothing. That split moves the R2 pair out of `media-storage-credentials`, which now carries only the Images and Stream token, and into a new per-environment `media-r2-credentials` declared through storage's `r2CredentialsRegistry` factory — one factory, so every declaration of a name agrees on every axis, which is what `aggregateSecretRegistries` demands before two capabilities may share one. `pithy media provision` writes both, and takes an `--r2-api-token` for the token that rides alongside the key pair. Re-run it after upgrading; it is idempotent, and a worker reading the old single secret has nothing to presign with. `pithy storage provision` creates the buckets, writes the credentials, and deploys the sweep worker; `pithy add` still touches no Cloudflare account. The R2 S3 access-key pair is supplied by the operator — Cloudflare exposes no API for minting one, and the manifest says so rather than promising otherwise. `pithy storage deprovision --storage` and `pithy media deprovision --storage` empty the bucket before deleting it — aborting any multipart upload left in flight, then draining every key — because R2 refuses to delete a bucket that is not empty, which is every bucket anyone has actually used; emptying one is an S3 operation, so both take the same key pair `provision` did, and both resolve it before a single worker comes down.

- [#86](https://github.com/pithy-sh/pithy/pull/86) [`0ee382b`](https://github.com/pithy-sh/pithy/commit/0ee382b9c6eafbbe42f79fd9ac225ed11bbfb03f) Thanks [@kingmesal](https://github.com/kingmesal)! - New seam: entitlements. `@pithy-sh/core` now owns what an entitlement is, how a request resolves the caller's, and `requireEntitlement("pro")` — the gate that belongs on a paid route's line beside `requireAuth()`. **The uncomposed default denies**, which is the one deliberate difference from the audit seam: a missing audit write cannot grant anyone access, but a missing entitlement check can, so a Worker with no provider composed holds nothing and every gate 403s. The gate lives in core rather than in the provider for the same reason `requireAuth()` is copied into each capability instead of imported from `@pithy-sh/auth` — a gate that arrives with a package fails open when that package is absent. Denials are audited through the `emit()` seam as `entitlement/denied`, and the reason (genuinely unentitled, or nothing wired) rides in `detail`, where an operator sees it and a client never does. Runtime denial is the backstop, not the primary defense: `pithy doctor` and `pithy dev` now compare the `requireEntitlement()` calls in a Worker's own source against whether any composed capability declares that it provides entitlements, and report the gap — so a Worker gating on entitlements with nothing to resolve them reads as a composition error at development time rather than as production 403s that are indistinguishable from a user who has not bought anything.

- [#86](https://github.com/pithy-sh/pithy/pull/86) [`0ee382b`](https://github.com/pithy-sh/pithy/commit/0ee382b9c6eafbbe42f79fd9ac225ed11bbfb03f) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/payments` — three payment rails (Apple, Google, Stripe) resolving to one cross-rail entitlement, in the adopter's own Worker and D1. Buy Pro on iOS, be entitled on the web, with no hosted data plane holding the purchase history. The load-bearing distinction is that a product is not an entitlement: `pro_monthly` and `pro_annual`, across three stores' catalogs, grant one key — `pro` — and gating code names the key through core's `requireEntitlement("pro")`, never a SKU. The catalog lives in `pithy.config.ts` rather than in D1, because an entitlement mapping is policy and belongs in git; a new SKU costs a deploy, which is the correct trade. Every write converges on one idempotent projection keyed on `UNIQUE (rail, providerTransactionId)`, so a client submission, a provider webhook, and a reconciliation pass produce the identical row — a dropped client call costs nothing and a replayed webhook changes nothing, and a replayed transaction returns 200 with the existing purchase rather than an error. The projection is monotonic on the provider's own event time: providers do not guarantee delivery order, and last-write-wins would let a stale `expired` arriving after the `renewed` that superseded it silently revoke a paying subscriber. The rule cuts both ways, so a client submission is dated by the provider rather than by us whenever what it read is a snapshot instead of live state: a completed Stripe Checkout Session reads `paid` for ever, refund or no refund, and dating it now would let a buyer re-post the session id from her success URL and outrank the refund already recorded against that payment intent. `expired` and `never_paid` are likewise two different endings, and only one of them credits — a period we were paid for that has lapsed still fulfills its `grants` clause, while a purchase that terminated before any money cleared grants nothing and credits nothing, because there is no payment to claw back either. `in_grace` carries a date as well as a status, because grace only grants while `expiresAt` covers the retry window and the paid period has already ended by the time a store reports grace at all: Apple's window lives on the renewal info beside the transaction, so the Apple rail verifies that payload too and carries the later of the two dates — reading the transaction alone would record a billing retry and revoke the subscriber in the same commit. Every purchase carries its store environment, so a sandbox StoreKit transaction can never grant a real entitlement. Entitlements are read from a materialized D1 row per request — no KV cache, no token claims, so a revocation is immediate — and the row's `expiresAt` is rechecked on every read, because a subscription can lapse with no notification arriving; the stored flag is an optimization, the timestamp is the truth, and a read never writes. Webhook authenticity is genuinely verified on all three rails: Apple's JWS against its pinned public certificate chain — every link signed, every window checked, every certificate above the leaf required to be a certificate authority, and Apple's own marker extensions required on the leaf and its issuer, so a chain assembled out of a developer's own Apple-issued certificate is refused rather than believed; Google's Pub/Sub push OIDC token resolved by `kid` from Google's published keys and checked for audience, because Google signs every project's push tokens with the same keys and the audience is the only claim that makes one ours; Stripe's HMAC verified rather than compared, inside a timestamp tolerance that is the replay window. A cron Workflow re-verifies subscriptions the webhooks missed, audits the drift it finds, and fulfills what it repairs — because webhook-only systems rot silently, repeated drift means the webhook path is broken, and whoever discovers a billing period is the only one who can still pay for it. A refunded one-time Google purchase revokes its entitlement even though Play's voided-purchase notification names no product and its one-time lookup demands one: an order id is what a Play purchase is keyed by, so the stored row supplies the product the store would not. A period a renewal has replaced is settled once and counted apart from drift, since every rail answers about a subscription's current transaction whichever row it is asked about: comparing an ended period against its own successor always disagrees, and left as drift it would have made the webhook-health signal measure how long a catalog had been selling. Ledger fulfillment is opt-in per product and reached through a guarded optional import, with a ref derived from the purchase and the currency so double-crediting is prevented by a `UNIQUE` constraint rather than by careful handler code; clawback on a refunded consumable is opt-in too, and a failed clawback is a recorded, queryable `payments/clawback_failed` rather than an exception, because routing around the ledger's overdraft guard would mean a negative balance or a silent write-off. Manual grant and revoke ship default-denied behind a control-plane scope and are audited, since they are the only way an entitlement appears without money moving. A grant is held against the projection, so a support comp of a key the catalog also sells survives the user's next renewal instead of being quietly re-derived away; a revoke releases the hold, which keeps it from becoming a permanent block on a user who later pays. Ending a paid entitlement is a refund through the store, because that is the record the projection reads. A catalog edit is a write too: dropping a key from a product's `entitlements` would otherwise leave every holder of it entitled forever, so the projection clears every non-manual key a user holds that no current product grants, on that user's next purchase event. And the derivation stays inside D1's hundred-parameter cap whatever the catalog does — it names its candidate products once, as a CTE, and binds them as one JSON parameter `json_each` expands back into rows, because a statement over the cap shares the purchase write's batch and would mean no purchase touching that key could be recorded at all.
  
  The client surface is headless in the package — `useEntitlement`, `usePurchase`, `useSubscription`, `useCheckout`, over a framework-free fetch layer, with `react` as an optional peer and neither module exported from the package entrypoint — because a scaffolded paywall is written once and never rewritten, and store rules move under it. `@pithy-sh/ui-react` gains the paywall and subscription screens that render those hooks — the subscription screen reads each entitlement's `granted` before its date, because the server applies the expiry on every read and a refunded purchase comes back granted-false with nothing wrong with its timestamp, an entitlement route guard a route module opts into with one export, and the `virtual:pithy/payments` projection carrying only what a browser may know. The CLI adds payments to the capability catalog, offers its screens from `pithy ui add`, and gains `pithy payments provision` and `pithy payments reconcile` — the second doubling as the support tool for "my subscription isn't showing up". `pithy seed` writes the shared example cast three purchases, one per rail and one per product type. Setup is the genuinely hard part, so the package ships a numbered console walkthrough per rail. Licensed MIT.

- [#88](https://github.com/pithy-sh/pithy/pull/88) [`fcb9502`](https://github.com/pithy-sh/pithy/commit/fcb950247371ca44c978b600d5bc1bdbd72b93b9) Thanks [@kingmesal](https://github.com/kingmesal)! - The `control-plane` seam: inbound, adopter-authenticated admin access to your own Worker, with no data plane in between.
  
  `control-plane` has been a declared strategy with nothing behind it. Now it is real, and it ships present-and-denying: a Worker that composes it and has never been connected answers every control-plane route with 403, and there is no flag that changes that. `pithy dashboard connect --env production` is the deliberate second step; `pithy dashboard disconnect` is a row you delete, immediate and needing nothing from anybody else.
  
  The credential is asymmetric. A management client holds an Ed25519 private key; you hold, rotate, and revoke the public one. Nothing secret of yours ever leaves your infrastructure, so a breach on their side is not a breach on yours — which a shared HMAC secret could never have offered. Each call carries a 60-second, single-scope token bound to a digest of its own body, checked against a replay set, and audited under its own actor kind, so what a management client did is answerable separately from what your users did.
  
  Rotation is append, prove, then expire — never replace. A rotation that fails leaves the old key working rather than locking anyone out. Proof is by use: the call that retires a key must itself be signed with the successor, because naming a live key is not evidence you can sign with it. The Worker refuses an expiry that names a key other than the one that signed, and refuses one that would leave no live key at all. Lockout is the one failure mode with no recovery path, so it is rejected rather than trusted not to happen.
  
  Revocation comes at two sizes. `pithy dashboard disconnect` removes the connection; `pithy dashboard revoke-key` pulls a single leaked key and leaves the rest standing. Both are writes to your own D1 and need nothing from the client — revocation that required the other side's cooperation would not be revocation.
  
  A control-plane call creates no user and no session. A management client is not a user of your app, so it lands on `c.var.controlPlane` and never on `c.var.auth` — otherwise every `requireAuth()` in every capability would pass for it.
  
  Capabilities contribute their own admin routes behind `requireControlPlane(scope)`, and those routes deny in a Worker that never composed the seam. `@pithy-sh/payments` is the first: manual entitlement grant and revoke now sit behind a real credential instead of the interim scope check they shipped with.
  
  They also **describe** those routes. `GET /control-plane/manifest` reports every composed capability with its admin routes — full path, method, and required scope — so a management client composes its calls from the Worker rather than from a route table it ships with. That matters because `basePath` is configurable: an adopter who mounts payments at `/billing` gets a manifest naming `/billing/entitlements/grant`, where a client assuming the default would have 404'd. Each route's scope against the connection's grants is what lets a client gray out what it may not do instead of discovering a 403. A capability with no management surface reports an empty list, because "composed but nothing to administer" and "not installed" are different facts. The declarations are checked against the router that actually mounted, so a manifest cannot quietly drift into lying.
  
  The minting side ships too. The seam is MIT and never gated by tier, so building your own management client against your own Worker is a real option, and `pithy dashboard connect --public-key` registers a key with no dashboard involved at all.

- [#96](https://github.com/pithy-sh/pithy/pull/96) [`1f6afb8`](https://github.com/pithy-sh/pithy/commit/1f6afb89661b03639018c6854616d8a26931d24b) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/support` — an inbound support inbox that lands mail in the adopter's own D1, classifies it on their own Workers AI binding, and links each sender to the account and purchases their app already knows about. Support is the employee a solo developer cannot hire, and every piece needed to build one was already in the catalog; nothing composed them.
  
  Mail arrives through Cloudflare Email Routing at the Worker's single `email()` entry. Support claims what is addressed to it on the SMTP envelope recipient, never on a `To:` header — anyone can put a support address in a header on a message routed elsewhere. From there the guard bounds it, `postal-mime` parses it including multipart and attachments, the HTML is sanitized through the runtime's own parser, the raw MIME goes to R2 unchanged, and the row lands in D1. Only then is classification dispatched, as a Workflow: an inbound handler has a tight CPU budget, and a model that is slow or briefly down must never take the persistence of somebody's support request with it. Threading is on `In-Reply-To` and `References`, never on the subject.
  
  Classification produces three axes from one call — category, priority, sentiment — because together they make a sortable inbox rather than a labeled one. The inference lands on the adopter's bill, and their customers' support mail never leaves their infrastructure. Model output is validated against the declared enum and falls back to `uncategorized` on a miss, because a text model always produces a plausible-sounding label and an invented one silently poisons every filter downstream. The model id and confidence are stored with every classification and the history is append-only, so a reclassification pass after a model upgrade can tell which rows came from which model. The taxonomy is federated: eight categories ship, chosen to map to action rather than topic, and an adopter adds their own with `defineSupportCategories`.
  
  Everything is derived from immutable mail. A wrong classification is recomputed, not repaired. There is no assignment and no status workflow — a status field is a state machine, and state machines attract SLAs, escalation, and reporting, which is a ticketing product and explicitly not this. Two exceptions: per-viewer read and snooze flags, which nobody coordinates around, and `archived`, one shared boolean meaning done, audited so that who marked a thread done is answerable from the trail rather than from an ownership column.
  
  Replies go out through `@pithy-sh/email`'s durable send path so they carry the adopter's domain and DKIM and set `In-Reply-To` and `References` correctly — only the Worker holds the chain, and implemented dashboard-side, threading breaks in the customer's mail client and every conversation fragments. Alongside it ships a federated catalog of canned replies: starting points a human picks, edits, and sends. They are body text rather than email templates, and nothing is ever sent automatically.
  
  `From:` is treated as a claim and stays one. Under Cloudflare Email Routing there is no sender verdict a Worker can trust — Cloudflare evaluates DMARC, since its `reply()` API requires a valid result, but does not reliably hand it to the Worker (`Authentication-Results`, `Received`, and `DKIM-Signature` are all reported missing from the delivered message), and once the MTA's own header is absent a header the sender wrote is indistinguishable from one an MTA wrote. So the match still happens — a sender resolves to an account, because that is the useful part — while the claim never does: `sender.authenticated` is false unless the adopter has set `guard.trustAuthenticationResults`, and purchases, entitlements, and the account's own `emailVerified` are withheld on an unverified match. A name beside an address is a guess an operator can sanity-check; an itemized purchase history is what somebody issues a refund on. Verifying DKIM inside the Worker is the real answer and is deliberately left for follow-up.
  
  The admin surface is `control-plane` only and default-denied, across five scopes rather than one admin flag — reading an inbox exposes every customer's private correspondence, while replying sends mail to a real person under the adopter's domain, and those are not the same permission. Listing is cursor-paginated on `(receivedAt, id)`, never offset, because mail arrives at the front of the order the list is sorted by.
  
  Search is keyword search: people look for a word they remember, not a concept. The default is an unindexed `LIKE` scan, adequate for an inbox measured in thousands of messages. FTS5 is available behind `search: { fts: true }` and is off by default for a reason worth stating — `wrangler d1 export` refuses to dump any database containing an FTS5 virtual table, failing outright rather than skipping it, and the check runs server-side across the whole database, so enabling it costs the adopter the export of every other table in their project too.
  
  The index itself is **not a migration**. It holds nothing that is not derived from `pithy_support_messages`, and `reindexThread` rebuilds it on demand, so `pithy support provision` creates and drops it to match the config — a provisioned resource like the bucket and the routing rule. That is what makes the flag safe to toggle: composing it conditionally into the migration set meant turning it off removed an already-applied migration, which Kysely reads as corruption and which blocks `pithy migrate` for **every** capability sharing the database, not just support. Until a re-provision catches up, a configured-but-absent index falls back to the `LIKE` scan rather than failing the inbox route.
  
  `@pithy-sh/email` gains three columns on `pithy_email_jobs` — `replyTo`, `inReplyTo`, and `references` — plus the enqueue inputs that set them and a `supportReply` template. They are folded into `email_0001_init` rather than added as a second migration: nothing is published yet, so an unreleased migration is code rather than a contract, and a project that has already migrated has nothing to reconcile. A column per field rather than a generic headers bag: a bag would let any caller set `Bcc` or `From` on a message the adopter's domain signs. `@pithy-sh/core` gains the six `support/*` error codes. `@pithy-sh/cloudflare`'s `CloudflareEmailRoutingManager` gains `removeWorkerRoute`, matched on the rule name rather than the address so a teardown cannot delete a rule an operator wrote by hand for the same mailbox, and its rule listing now pages to exhaustion — a truncated list reads as "no such rule", which would make provisioning duplicate a rule on every run and a teardown report mail stopped while it kept arriving. The CLI gains the catalog entry and `pithy support provision`, which creates the bucket, deploys the classification worker per environment, and creates the Email Routing rule last — creating it first would deliver real customer mail to a Worker whose classifier is not deployed yet.
  
  Cloudflare Email Routing takes over a zone's MX, so a support address belongs on a subdomain and never on the apex. That is said in the README, the manifest scaffold, and the config description, because it must be known before anything is run rather than discovered afterwards.
  
  Licensed MIT.

- [#97](https://github.com/pithy-sh/pithy/pull/97) [`c645d19`](https://github.com/pithy-sh/pithy/commit/c645d190022da1bde420d1f03c30bbd98f007234) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/testers` — the roster, the invitations, and the fourteen-day clock for the closed test Google Play makes every new personal developer account run.
  
  Twelve testers, opted in for fourteen continuous days, before production access is granted. Google says the days must be consecutive, so losing one tester on day nine effectively restarts the clock. There is no screen anywhere that tells a developer where they stand, and that absence is the whole problem this solves.
  
  **Pithy's count is an estimate from your own invite records. Google's count is authoritative and no API exposes it.** That sentence is not a disclaimer bolted on afterwards; it is the shape of the package. The Play Developer API's tester resource holds one field — a list of Google Groups — and cannot read an email roster, the opt-in count, the continuous-day streak, or a tester quietly opting out. `docs/store-apis.md` sets that out with citations, because the most valuable thing this capability can tell an adopter is what it cannot do.
  
  So the honesty is structural rather than advisory. Every figure derived from opt-in records is named `estimated`, so `estimatedHeldDays: 9` reads as a claim about our own records where `optInStreak: 9` would read as a fact about Google. The estimated half and the observed half are separate objects with literal `source` discriminators, so a developer cannot reach the number without typing the word `estimated`. The disclaimer is a required, non-nullable field on every cohort and on the envelope, so the spread-into-a-card path still carries it. `successProbability` is nullable, because "we cannot see this cohort at all" has to be representable rather than faked as a plausible 0.5 — and it is capped below one, because nothing here is ever certain. A meta-test enforces all of it, on the reasoning that the person who reads "this is an estimate" and the person who writes `if (heldDays >= 14) applyForProduction()` are the same person on different days.
  
  The clock is replayed from an append-only event log rather than stored as a counter. A counter can only be overwritten, which destroys both the old value and the evidence that it changed; replaying makes a correction an insert, and every snapshot written beforehand survives as an accurate record of what Pithy believed on that day — which is exactly what a trend chart claims to show. Only four things move a tester's state, and inactivity is not one of them: the moment a cron may lapse someone for going quiet, the count stops being a record of who confirmed and becomes a guess dressed as a record. Days are counted in UTC and the response says so, because Google's boundary is undocumented and may not be ours.
  
  **The half that is fact is activity, and it is the part nobody else has.** Because `@pithy-sh/auth` owns sessions and the device registry, a tester's invited address resolves to their user and from there to when they last opened the app. A tester dark for eight days is the one most likely to have quietly gone, and that is actionable on day eight rather than on day fourteen when the count finally moves. Activity is never treated as opt-in continuity — someone who confirmed and never opens the app still counts toward Google's twelve. Testers who never sign in report `never_linked` rather than `inactive`, and their health is `null` rather than a low score: absence of evidence is not evidence of risk, and an app whose test flow needs no sign-in would otherwise render entirely red.
  
  The forecast reports reaching the target and holding it separately, because multiplying them destroys the only actionable information in the pair — "62%" tells a developer nothing, while "you will reach twelve but hold it 65% of the time" tells them to invite four more people this afternoon. The hold half is an exact Poisson-binomial over each tester's own survival probability: deterministic, exact in the tail where the answer lives, and explainable in one sentence. The survival priors are numbers we chose rather than values fitted to anyone's data, every one of them is a config field, and the API says `calibration: "default"` out loud.
  
  A daily Workflow writes one snapshot per cohort per UTC day, and that table is what makes the trend chartable at all. The opt-in figures could always be replayed; activity could not — sessions expire and rotate, and a tester who was quiet on the ninth but active on the eleventh leaves no trace on the twelfth that they were ever quiet. Each snapshot carries its own precomputed deltas and a one-sentence trend reason, so a summary card renders from one row and cannot disagree with the chart drawn from the same series.
  
  Every nudge carries the tester's own way out, on every kind rather than only the marketing-shaped ones. A testing program repeatedly asks one person for something over a fortnight, and someone being chased must be able to stop it. Withdrawing takes a confirmation rather than a link-follow, because it rotates the tester's token and cannot be undone without a fresh invitation. Chasing also stops on its own after three unanswered messages — the cooldown bounds how often a tester is mailed, and without a ceiling on how many times, a person who never answered would have been contacted every three days for the life of the cohort.
  
  Nudges ship default copy for every kind, because a capability whose mechanism works only if you buy a dashboard is a capability that does not work. A per-tester cooldown is enforced server-side on every path including the daily pass, since a nudge trigger with no guard is a button that mails the same twelve people repeatedly. A control-plane caller may override the words and only the words: a subject and a plain-text body, wrapped in this capability's own envelope. **There is no field that accepts HTML, and that is a security boundary rather than a style preference** — supplied content goes out over the adopter's own DKIM signature, so unconstrained markup would turn a leaked dashboard credential from a disclosure problem into a phishing platform running from a domain those testers already trust. The body renders as an array of HTML-escaped paragraphs, so markup arrives as visible text structurally rather than by filtering, and the subject is stripped of control characters because the threat there is header injection instead.
  
  **A tester's journey is two emails, and the order is forced by the store rather than chosen.** A store opt-in page only works once that address is already on the tester list — and adding an address to a Play email list is precisely what the Play Developer API cannot do, so it is a manual step in the console. Sending the store link first produces `App not available`, which reads to a tester as a broken app. So the first email asks whether they will help and records their answer, `pithy testers pending` prints who is waiting to be added, and the second email carries the link once they are. That split also keeps the count honest: agreeing to test is consent, not enrollment, and counting it as one would inflate the estimate with people who said yes and never joined. `accepted` and `opted_in` are separate states for exactly that reason, and signing in to the app moves neither — that is activity, and it belongs entirely to the observed half.
  
  The store's own opt-in link is configuration rather than something a developer has to keep finding: pasted once with `pithy testers create --store-url`, frozen onto the cohort, and carried by the email. Pithy will not derive it from a package name, because Google documents no format for it. And the second link **renders** that URL rather than redirecting to it — a 302 would make the adopter's Worker a redirector, and it leaves nowhere to put the two instructions that prevent most failures: open it in a browser rather than the store app, and sign in with the address the email reached you at.
  
  The confirmation link is a high-entropy token on the tester's own row rather than a signature, on a `public` route, because a tester must be able to answer from an email on a phone with no account — requiring a sign-in would mean the one event the whole count rests on happened only for the subset willing to create an account first. Holding it in a row rather than a signature buys three things: removing a tester **revokes** their link where a signed one could only expire, no secret is read anywhere, and `pithy testers invite` therefore builds a working invitation against any environment rather than only against local dev. It is idempotent, which is a requirement rather than a nicety: email clients prefetch links and people click twice, and a second visit that re-stamped the opt-in date would reset a tester's streak on entirely ordinary behavior. An unknown token and a revoked one return identical words, so the route is not an oracle for which cohorts or testers exist.
  
  Read, write, and send are three separate control-plane scopes. A single `testers:admin` flag would mean a credential issued to read a roster could also mail every person on it, and mailing is the operation whose blast radius reaches outside the adopter's own systems.
  
  `pithy testers provision` deploys the prebuilt daily-pass Worker per environment and writes the `TESTERS_DAILY` binding the app Worker cannot write itself — wrangler demands a `name` and a `class_name` on every `workflows` entry and the deployed name is per environment, so `pithy add` emits none and this completes it. The provisioner is unusually small, and that is the point: no bucket, no index, no secret, no master key. What is left is a template, a deploy, and a binding.
  
  `pithy testers` covers the whole flow — provision, deprovision, create, list, invite, pending, roster, status, remove, close, and run — each non-interactive and `--json`, so a closed test is runnable from a terminal with no dashboard involved. `run` enqueues real mail: `enqueueEmail` writes a row into `pithy_email_jobs` and the email worker delivers it, so the CLI needs no sending domain of its own and no secret to build a link. `@pithy-sh/core` gains the eight `testers/*` error codes; `@pithy-sh/email` gains the one envelope template this capability sends everything through.
  
  Every knob in the config is read by something. `snapshotHourUtc` sets the deployed cron rather than sitting beside a schedule hardcoded elsewhere; `maxNameLength` bounds a name on the route and on both CLI paths. A `--store-url` that is not a store URL is refused where it is written rather than accepted and then silently disagreed about by the pass and the route — the disagreement mailed every tester a link that enrolled nobody while the opt-in estimate climbed on the way through.
  
  The daily pass runs one Workflow step per cohort, so a cohort that fails loses its own day rather than every later cohort's — the darkness histogram cannot be recomputed after the fact, so a lost day is lost for good. A pass re-run on a day it has already covered adds to that day's send record rather than replacing it, and a deployment with no `baseUrl` skips nudging and says so rather than throwing partway through and taking the snapshot with it.
  
  A day is corrected once it has actually ended. The pass runs at 05:00 and writes a row keyed to a day it is five hours into, so everything that happened in the other nineteen hours was missing from it — and nothing went back. The next morning's pass now replays the finished day and rewrites the opt-in half of that row, marking it `backfilled`: the clock replays exactly, the activity figures cannot be reconstructed after the fact, and that split is what `backfilled` tells a chart. Without it the stored series contradicted the replay it claims to record, and every post-05:00 opt-in plotted a day late, permanently.
  
  A closed cohort sends nothing further, on every path rather than one. `closedAt` was consulted by a single filter, so invite, resend, nudge and `run --cohort` all carried on mailing a finished program. The chase cap is the same shape: three unanswered messages stopped the daily pass and nothing else, so a dashboard could chase an unresponsive address every three days for the life of the cohort. Both are now enforced where every path converges.
  
  **A withdrawal is the tester's own decision, and it is durable.** `lapsed` has exactly one producer — the opt-out route the tester followed themselves, having been shown a page that says they will not hear from the test again — so unlike `removed` it is never a state the developer chose. Re-inviting a withdrawn address is refused. Every other send path already refused one; `invite` was the exception, it sends by default, and it is the path a routine contact-list re-import takes. Removing a tester stays reversible, because that is the developer's own act on their own roster and undoing it takes nobody's consent away.
  
  Write scopes do not confer read. The three control-plane scopes exist so a management client can mail or manage a roster it was never granted permission to read — the nudge preview returns ids rather than addresses for exactly that reason, and `resend` and `remove` now do the same. The address still reaches the audit trail, which is where it belongs.
  
  Licensed MIT.

- [#103](https://github.com/pithy-sh/pithy/pull/103) [`c58405e`](https://github.com/pithy-sh/pithy/commit/c58405ef35bf57cbd0ddf70c5f8651bba90d6b4f) Thanks [@kingmesal](https://github.com/kingmesal)! - Everything between the control-plane seam and a management client that can actually address a project and read something from it.
  
  **A Worker's address is declared once.** `domains: { prod: { pattern, zone } }` in a Worker's own `pithy.config.ts`, per environment, and the `routes` entry with `custom_domain` and `vars.BASE_URL` are generated from it. Three commands used to reconstruct that address three different ways — `pithy env` scraped the first route, `email provision` and `turnstile` read a hand-set `BASE_URL`, and `deploy` scraped whatever URL wrangler last printed — and nothing noticed when they disagreed. One resolver replaces all three, preferring the declaration, falling back to a route and then to the var, so a project that predates this keeps working and is never told to migrate. `pithy init` and `pithy worker add` ask for it against the account's **real Cloudflare zones**, so a typo fails at `init` with a list of what exists rather than at `deploy` with a Cloudflare error to decode; the prompt is skippable, and it degrades to free text when the account is unreachable.
  
  **`pithy deploy` proves the Worker it shipped is the one answering.** `GET /health` now reports the running build, and deploy probes the *declared* domain and asserts the version matches what it just shipped. A liveness check would not catch the failure worth catching — the old version answering happily at the declared domain while the deploy landed somewhere else. It retries through propagation, and reports a gradual rollout as inconclusive rather than failed.
  
  **`CF_VERSION_METADATA` is finally bound.** The logger has always read it and `docs/LOGGING.md` has always documented it, but no template declared the binding, so the `version` field was absent in every scaffolded project and nobody could correlate a log line to the deploy that produced it. Both scaffolds now emit it, `pithy upgrade` adds it to an existing project, and a parity test holds the two generators together — two unsynchronised producers is *how* it went missing. The id reaches five consumers: every log record, every audit event, the control-plane manifest, a `pithy-worker-version` header on every control-plane response, and the deploy check.
  
  **The manifest reports both version axes.** The Cloudflare build id says *which build* — the answer for forensics. The composed `@pithy-sh/*` versions, per capability and never aggregated, say *which features* — the answer for "should this customer upgrade" and "who is exposed to what we just fixed". A Worker cannot read its own `package.json`, so each package's version is stamped into a committed constant with a CI check against drift.
  
  **Registration is self-sufficient.** `pithy dashboard connect` resolves the Worker URL itself instead of demanding `--worker-url`, names its Worker and refuses ambiguity in a multi-Worker project, and sends the seam's `basePath` — the one address a client cannot discover, because it *is* the manifest's address. Without it an adopter who mounted the seam at `/admin` registered cleanly, passed the ping at the assumed path, and then 404'd on every call.
  
  **Admin routes on the capabilities that shipped before the seam.** `@pithy-sh/auth` (find and read users with sessions and devices; revoke a session, sign a user out everywhere, revoke a device — no impersonation), `@pithy-sh/audit` (page the trail, read one event in full), `@pithy-sh/email` (jobs by status and in detail, retry, the suppression list), `@pithy-sh/ledger` (balances and history, read-only). Least-privilege scope per operation, audited including reads, keyset pagination on every list through one shared core helper, and each declaration drift-tested against the router that actually mounted.
  
  **The replay guard holds.** A control-plane token is now spendable exactly once, claimed with `INSERT … ON CONFLICT DO NOTHING` on the `jti` primary key — strongly consistent, wherever the requests land. The KV guard it replaces had no compare-and-set and was eventually consistent across colocations, so a replay arriving at a different colo inside the propagation window passed. Narrow is not harmless: a nudge sends real people a second email. KV stays selectable behind the same interface with the race stated; the D1 default needs no KV namespace at all.

- [#102](https://github.com/pithy-sh/pithy/pull/102) [`5668f08`](https://github.com/pithy-sh/pithy/commit/5668f0874a8df0fa9ad8477f3e1b48b46c181054) Thanks [@kingmesal](https://github.com/kingmesal)! - Every audit event now records the project, environment, and Worker it came from, so a shared database and an exported log both stay attributable.

- [`e92f107`](https://github.com/pithy-sh/pithy/commit/e92f107a61fdd0e94c733f21bbc50fdb477f4047) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add <capability> --eject` copies a capability's source into your repo and rewires it to the local copy — fork and own it, accepting it no longer upgrades with the package.

- [`14ea4eb`](https://github.com/pithy-sh/pithy/commit/14ea4ebc48d29c0ee4bce102998afdadba39458f) Thanks [@kingmesal](https://github.com/kingmesal)! - Audit logging is wired into every CLI command that changes something real, not just `pithy token`. `deploy`, `secrets` (set/rotate/remove and provisioning), `remove` (including the `--drop` that destroys tables, and a declined confirmation recorded as `denied`), `add`, `turnstile`, `email`, `provision`, `feature destroy`, and a `seed --redo` schema reset all record what happened, to what, and under which token — with destructive actions at `warning` or `critical`. Secret **names** are recorded; values never are.
  
  One shared helper (`createCliAudit`) replaces the bespoke copy that lived in `pithy token`, and it returns an **always-callable** emitter rather than an optional one, so a call site never guards — matching core's in-Worker `noopEmit` seam. Auditing stays entirely optional: when the project does not compose `@pithy-sh/audit`, the package will not resolve, the environment's audit database is unresolvable, or credentials are absent, the emitter is inert and costs nothing (the capability check short-circuits before any file read or client construction). Writes are non-fatal — a dropped audit event is logged, never allowed to break the command it was recording.

- [#37](https://github.com/pithy-sh/pithy/pull/37) [`a4ab423`](https://github.com/pithy-sh/pithy/commit/a4ab423f07fd8d77061930c602444d5e9562d208) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add <capability>` now installs the package, wires your config and bindings, and runs its migrations in one step — you pick the mount path, the handlers stay in the package.

- [`0ada38f`](https://github.com/pithy-sh/pithy/commit/0ada38fdf7c4f32ae14cc2760b4a57e2642927f1) Thanks [@kingmesal](https://github.com/kingmesal)! - `@pithy-sh/cli`: the `pithy` binary lands — `init` scaffolds a deployable Worker, `add` wires capabilities, `migrate` runs the registry. Full flags and `--json` everywhere; humans and agents drive the same commands.

- [`6f31178`](https://github.com/pithy-sh/pithy/commit/6f311786f8e2784d4fae7d95c9070e16e37e48c5) Thanks [@kingmesal](https://github.com/kingmesal)! - Seed any test environment from your own Zod-typed fixtures — local or live — with `pithy seed`. Author a `defineSeed` set once and it composes library-before-app, exactly like a migration, validating every row against your real table schemas before a single insert runs. D1 and KV writes are idempotent and never destructive; media assets upload to Images or Stream once and record their UUID for every run after. Production stays opt-in twice over: a set must list it explicitly, and the command still refuses without an exact confirm phrase.

- [`288848e`](https://github.com/pithy-sh/pithy/commit/288848e849f2aadf1f9444b3db03d94b781a0e1b) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy migrate --env` now promotes migrations to staging and production over the D1 API, and `pithy deploy` ships your Workers to Cloudflare — both runnable by hand or in CI. The migration bookkeeping tables move to `pithy_migrations` / `pithy_migrations_lock` so they never collide with an adopter's own Kysely migrations.

- [`d74ce14`](https://github.com/pithy-sh/pithy/commit/d74ce140f5c19848eb7415d6b6ee86815107f83c) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy remove <capability>` cleanly reverses `add` — unwiring config and bindings and uninstalling the package — leaving your data untouched unless you opt in with `--drop`. It is a manual, interactive-only command.

- [`14ea4eb`](https://github.com/pithy-sh/pithy/commit/14ea4ebc48d29c0ee4bce102998afdadba39458f) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy seed --redo` rebuilds an environment's data from scratch: roll every migration back, run them all forward again, then seed. Seeding is deliberately non-destructive — D1 is `INSERT OR IGNORE`, KV skips an existing key — so editing a fixture's values and re-seeding silently did nothing. `--redo` is the way to make edited fixtures actually land. Because the schema comes back empty, the ordinary writes just work.
  
  **It is destructive: every row in every table the migration registry owns is gone, hand-inserted data included.** So it carries its own gate, stricter than the seed gate. `--yes` means "this is not dev" and was designed to authorize an additive write; it does not authorize a drop. Any non-`dev` reset needs the exact phrase `yes, i really want to reset <env>`, passed as `--confirm-reset` or typed at a prompt that states the loss first. The phrase names its environment, so one env's cannot be pasted at another. `dev` stays free. CI still automates it by passing the flag. Every reset is audited before the drop begins, at `critical` severity off `dev`.
  
  Adds `resetMigrations` to `@pithy-sh/core`, and `resetProject`/`previewReset` to the CLI's migration layer — the same plan and driver as `migrate`, so a reset works against local Miniflare and remote D1 alike.

- [#75](https://github.com/pithy-sh/pithy/pull/75) [`3dab85f`](https://github.com/pithy-sh/pithy/commit/3dab85fea342ac3938a15b8953139a7f5148b9a3) Thanks [@kingmesal](https://github.com/kingmesal)! - Ship the six missing standard commands from `docs/CLI.md` §1.1: `worker`, `dev`, `env`, `upgrade`, `alias`, and `doctor`.
  
  - `pithy worker add|list|remove` — manage the project's Workers under `apps/<name>/`, each with a co-located `pithy.worker.jsonc` manifest (a file you own; `wrangler.jsonc` stays wrangler's). Discovery keys on the manifest, so a non-Worker process (a Vite frontend) can join the dev set. Adding a worker reconciles the feature's pinned ports without moving any existing worker.
  - `pithy dev` — the multi-worker local orchestrator. Verifies each worker's pinned port on both `127.0.0.1` and `::1` and reports a conflict rather than drifting, labels and tees output to `logs/dev.log`, wires workers to each other over localhost (`*_ORIGIN`), and tears down the whole process subtree cleanly.
  - `pithy upgrade` — reconcile installed, non-ejected capabilities with their current manifests: add missing bindings to `wrangler.jsonc` per environment and missing options to `pithy.config.ts`, never rewriting an adopter-changed value. `--dry-run`, `--migrate`.
  - `pithy doctor` — toolchain state, an update check, and (inside a project) config/binding/migration health that exits non-zero on drift so CI can gate on it. Ships the update notifier: 24-hour cache, per-installer upgrade command, and three opt-out paths.
  - `pithy alias` — install/remove the `p.` shortcut across bash, zsh, fish, PowerShell, and nushell, idempotently and marker-wrapped.
  - `pithy env` — a read-only inventory of every environment's bindings, resolved ids, provisioned state, and dashboard deep links.
  
  All six are non-interactive with `--json`.
  
  **One `pithy.config.ts` per Worker.** `apps/<name>/` is now the only place a Worker lives — there is no root Worker. Each Worker owns its `pithy.config.ts` (`{ capabilities, app }`), `wrangler.jsonc`, and `pithy.worker.jsonc`, because everything capabilities drive is per-Worker: the composed route tree, the bindings written into that Worker's wrangler config, and Durable Object class migrations, which register a class against a specific script. The root `pithy.config.ts` keeps only what cannot be per-Worker — `name`, `tokens`, and `seed.productionEnvironments`.
  
  - `add` and `remove` take `--worker <name>`; with one Worker it is optional, with several the CLI prompts at a terminal and fails with an actionable error under `--json` rather than guessing.
  - `migrate`, `seed`, `upgrade`, `doctor`, and `env` fan out over every Worker and accept `--worker` to narrow.
  - Workers share a resource by declaring the **same binding name** — feature resource names carry no Worker segment, so two Workers that both declare `DB` are backed by one D1, and Workers sharing a database migrate it once. Locally, `dev`, `migrate`, and `seed` persist Miniflare state at the project root so a shared database is genuinely shared.

- [`af1871b`](https://github.com/pithy-sh/pithy/commit/af1871b7e467d4e69e287038deaa0023e9c94ac3) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy token mint` creates scoped, least-privilege, account-owned Cloudflare API tokens for each job and stores them where you point it — no hand-crafting tokens in the dashboard. One `ci-system` credential covers your CI pipeline and grows as capabilities declare what they need; worker-consumer tokens (like the secrets manager's) land in the CF Secrets Store. Mint, list, rotate, and revoke, all non-interactive and `--json`.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - Press `l` to open a signed-in browser, instead of pasting a cookie
  
  `pithy dev` no longer prints a session cookie. The ready banner used to hand over a live credential as text —
  `document.cookie = "better-auth.session_token=…"` — to paste into a browser console. A working session token
  rendered on a terminal is a working session token at rest, in a scrollback, in `logs/dev.log`, and in every
  screenshot of either. The seed already flagged that artifact as sensitive; printing it was the one place the
  rule was suspended by design.
  
  Now the banner names the user and offers a keypress: `Dev login: ada@example.com — press l to open a signed-in
  browser.` Pressing `l` opens `http://localhost:<port>/__pithy/dev-login` in whatever browser is default. The
  Worker sets the cookie and redirects to `/`. The value travels from the Worker to the browser and lands
  nowhere else.
  
  `@pithy-sh/auth` registers that route behind **two independent gates, both at registration**: the composition's
  `ENVIRONMENT` must be `dev`, and `CI` must be unset or blank. A route that mints an authenticated session with
  no credential presented cannot be allowed to reach staging or production, and CI runs `dev` compositions
  constantly, so neither gate implies the other and neither is folded into the other. A `staging` composition, a
  `prod` composition, and a `dev` composition under CI each carry no such route at all.
  
  `CI` is now read in one place, `@pithy-sh/core`'s `env/ci.ts`, with `PITHY_OFFLINE`'s rule: any non-blank value
  is set, blank is no override. `pithy dev` forwards it into each Worker as a var, because the host environment
  does not otherwise cross into workerd.
  
  A non-TTY `pithy dev` — CI, a pipe, `--json` — never enters raw mode and never waits for input; the banner
  prints the URL instead. `l` with no seeded session says so and names `pithy seed` rather than opening a URL
  that 404s. A project where several Workers compose auth prints the choices instead of guessing which origin
  to sign in on.

- [#188](https://github.com/pithy-sh/pithy/pull/188) [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy doctor` notices a Worker that is getting nothing.
  
  An upgraded project could have every dev value in its root `.dev.vars`, every generated `apps/<worker>/.dev.vars` written with a header and no values, and a clean `pithy doctor`. The first thing that said otherwise was a 500 from a running Worker: `Missing required bindings: …`. Since [#154](https://github.com/pithy-sh/pithy/issues/154) the root file is not a source for the generated one, so an upgraded project's values sit one file away from everything that would use them — and nothing said so.
  
  Three things are reported now, all of them from local files, none of them fatal to the exit:
  
  - **A Worker whose generated `.dev.vars` carries no values**, by name. A Worker in that state cannot serve a request, and it was one `stat` and one parse away from being detectable.
  - **A registry secret in the root `.dev.vars`, whatever its backend.** The check reached `backend: "d1"` only, on the grounds that `CLOUDFLARE_API_TOKEN` has no local Secrets Store to live in — true of that one name, not of the backend, so `cf-secrets-store` secrets sat there unreported. Backend decides where a *seeded* value lands; it never decided which file a value belongs in. `CLOUDFLARE_ENV_KEYS` — the list the CLI's own readers use — is what decides that now, in one place both checks call.
  - **A key in the root `.dev.vars` that nothing reads**: not a Cloudflare credential, not a registry secret, not declared by anything this project composes. A key the project *does* compose — `SECRETS_ENCRYPTION_KEYS` above all — is named as stranded rather than as deletable, because "nothing reads this" cannot be said safely without knowing what does.
  
  Every key in that file is classified, and the classification is total: a key belongs to exactly one of those states, and the two silent ones are named rather than defaulted. That is the gate — the previous check failed by having a class of key that reached no branch at all.
  
  Reported, never fixed. [#154](https://github.com/pithy-sh/pithy/issues/154) said migration is reported rather than automatic and that is still the right call; reported now means reported.

- [#48](https://github.com/pithy-sh/pithy/pull/48) [`e5b8a60`](https://github.com/pithy-sh/pithy/commit/e5b8a6072612d8e0a331833c0bc6e2b7c86b9ce4) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/email` — D1-backed email jobs with immediate, scheduled, and per-timezone sends, themeable Handlebars templates, and built-in open/click/bounce/unsubscribe tracking.

- [`14ea4eb`](https://github.com/pithy-sh/pithy/commit/14ea4ebc48d29c0ee4bce102998afdadba39458f) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy feature` stands up a branch's isolated environment in one command each — `create` for a seeded local backend, `provision` for its live Cloudflare one, `destroy` to tear it all down. `create` (local, automatic) cuts the `feature/<issue>-<slug>` worktree, reserves a non-overlapping port block and pins one port per worker into the worktree's `.dev.config.json` — fixed for the life of the feature, so N features run at once with no startup race for a free port and every worker has a stable address to wire to — links `.dev.vars` to the repo's one shared secrets file, and migrates + seeds the local Miniflare backend. `sync` (run from the worktree, no arguments) makes an existing worktree ready whatever state it is in: it gives a newly added worker the next free port from the feature's own block without moving any existing worker, and — for a colleague who just pulled the branch — creates the whole machine-local setup (`.dev.config.json`, a port reservation on their machine, the `.dev.vars` links) and migrates + seeds their local backend. `provision` (remote, explicit, run from the worktree) creates one ephemeral CF resource per binding the enabled capabilities declare — named under a branch-first `<project>-f<issue>-<slug>-<resource>` prefix — records each id in a per-feature manifest, writes them into `wrangler.jsonc`, then migrates + seeds; it is idempotent and resumable, so an interrupted run picks up where it left off. It also gives every Worker its environment-scoped script name and retargets each `service` binding at the feature's own deployment, so worker-to-worker RPC in a feature environment stays inside that feature instead of reaching production. Because every name derives from the branch, CI recomputes the same wiring on each push and recovers already-provisioned ids by name — none of it has to be stored or committed. `destroy` deletes the manifest's resources, reconciles the feature's expected names, frees the port block, and prunes the worktree the Linux-safe way. All three run non-interactively with `--json`. Adds KV-namespace and R2-bucket control-plane provisioners (and a D1 `listDatabases`) to `@pithy-sh/cloudflare`, and a `service` target field to `BindingSpec` in `@pithy-sh/core`.

- [#46](https://github.com/pithy-sh/pithy/pull/46) [`1e8c8c7`](https://github.com/pithy-sh/pithy/commit/1e8c8c7f80ca5f3b96ad48c859c90ac264c6c3f3) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy secrets provision` now mints the secrets manager's own scoped Cloudflare API token and writes it straight into the Secrets Store. No more hand-created `.dev.vars` token. `@pithy-sh/cloudflare` gains a reusable account-token client — mint, roll, and delete account-owned tokens from a set of permissions — and the manager token is its first use. The bootstrap token needs `Account API Tokens Write`; a token that lacks it fails fast, with the reason.

- [#213](https://github.com/pithy-sh/pithy/pull/213) [`0ff0cd5`](https://github.com/pithy-sh/pithy/commit/0ff0cd54cb926a015b3bac7383976a36729788d4) Thanks [@kingmesal](https://github.com/kingmesal)! - A project names its Cloudflare account, so one machine can hold several.
  
  `<config>/cloudflare.json` is account-scoped because one account holds many projects. That reasoning is right and incomplete: it assumed one account per *machine*. A developer working across two companies has two, and every project on the machine read the same file — so switching accounts meant editing that file in place, every project silently followed, and the next deploy authenticated successfully against the wrong tenant with nothing anywhere disagreeing.
  
  The root `pithy.config.ts` now says which account a project belongs to: `cloudflare: { accountName: "leed", accountId: "a1b2c3…" }`.
  
  `accountName` selects `<config>/cloudflare.<name>.json`. Absent resolves `cloudflare.json` exactly as before — a single-account machine is untouched, and there is nothing to migrate. It must be a bare token, and that is enforced by the config's own schema rather than where the path is built: the name becomes a file name in the config directory, which sits outside every checkout where `ensureScaffoldPath` and the atomic writer never reach it. `../../etc/passwd`, `a/b`, empty, and a control character are all refused on load, naming the config and the value.
  
  `accountId` is a pin, not a credential. The nickname means whatever each machine says it means, so two developers on one repository can both have that file pointing at different accounts and nothing in the repository would disagree. With the pin, every command that resolves credentials compares the resolved `CLOUDFLARE_ACCOUNT_ID` against it and refuses on a mismatch, naming both ids and the file — including when the id came from the `process.env` overlay, which is CI configured for the wrong account and the one place that deploys to production. An account id is an identifier rather than a secret, so it is safe in a repository, including a public one. Optional, and it earns its keep the moment more than one person deploys.
  
  `pithy init` writes all three at one moment. It asks for the token first, lists the accounts that token can see (`listCloudflareAccounts`, new in `@pithy-sh/cloudflare`), and uses the account's own name, slugified, as the default nickname — one visible account is a confirmation, several are a picker, and choosing the account supplies both the id and the name, so `init` no longer takes an account id on trust. The pin is written by default and can be declined. A slugified name goes through the same schema as a typed one, and a name that slugifies to nothing is asked for rather than guessed at. A token too narrowly scoped to list accounts falls back to asking, as before. A non-interactive `init` writes no `cloudflare` block and resolves `cloudflare.json`, unchanged.
  
  `pithy add secrets` records `SECRETS_STORE_ID` into the file the project selected. `pithy doctor` names the resolved file on every run — including the terse all-green report, which is the run most likely to be followed by a deploy — and reports a pinned mismatch as its own state, decided before anything reaches the network, so a wrong-account run never authenticates even to be verified. It fails the exit, and `--json` carries `configPath`, `accountName` and `accountMismatch` beside the existing fields.
  
  **Which account a resolution is for is now an argument, not an ambient.** `cloudflareEnv`, `resolveCloudflare`, `cloudflareConfigPath` and `writeCloudflareConfig` take a required `account`; `projectCloudflareAccount(projectDir)` is where a value comes from, and it loads the project, so the ordering that would otherwise be implicit is the `await` in front of it. The first shape of this kept the selection in a process-wide holder that `loadProject` published into, and six call sites resolved credentials before it had — including the pair handed to `wrangler deploy`, where the failure is a successful deploy to another company's tenant. Omitting the account is a type error now; `null` is the deliberate "this project names none", and `cloudflare/accountArgument.test.ts` holds every `null` in shipped source to a written reason.

- [#225](https://github.com/pithy-sh/pithy/pull/225) [`128f0d3`](https://github.com/pithy-sh/pithy/commit/128f0d32907cbcc3856c38dc4b2d590e1423b156) Thanks [@kingmesal](https://github.com/kingmesal)! - Give the CLI a way to say no ambient credentials, and make `doctor` say where its credentials came from.
  
  `PITHY_CONFIG_DIR` relocates the config *file*. It never touched the `process.env` overlay, and that overlay is right — CI supplies `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as environment variables and has no file at all. The consequence was that redirecting the config directory looked like isolation and was not: `pithy doctor` in an empty scratch directory reached a real Cloudflare account off a token the shell had exported hours earlier, and reported `reachable (token active)` about an account nobody in that session had named. Twice.
  
  `PITHY_OFFLINE=1` is the word that stops it, and `pithy doctor --offline` is the same word at a prompt. Pithy stops reading the credential pair out of the environment, and `doctor` reports **not checked** rather than probing. It never fails the exit — nothing was established — and the version lines say `skipped` rather than blaming a registry nobody asked. An adopter on a plane gets a full report and a green exit.
  
  It is a variable rather than a flag on every command because it bites in the one function all of them resolve credentials through, and because a variable is inherited by a spawned `pithy`, `wrangler`, or test runner. It gates the environment and not the file: a credential you wrote down is not one you forgot you exported. So `PITHY_CONFIG_DIR=/tmp/scratch PITHY_OFFLINE=1` resolves nothing at all, which is the guarantee people already believed the first variable gave them.
  
  `PITHY_CONFIG_DIR` was not made to imply it. That conflates *read config from here* with *do not use the environment*, and CI legitimately means the first without the second.
  
  Separately, and for when a call is made anyway: the `Cloudflare:` line now names **where the credentials came from**, not only which file was resolved. In CI those are different answers — the resolved path holds nothing and the environment does the authenticating — and `; from ~/.config/pithy/cloudflare.json` was the report naming a file it had not read. `credentialSource` in `--json`, beside a new `offline`.
  
  The overlay itself is unchanged, and CI with environment credentials and no file is tested to stay exactly as it was.

- [#83](https://github.com/pithy-sh/pithy/pull/83) [`b84ec9e`](https://github.com/pithy-sh/pithy/commit/b84ec9ec2b785d4756067f6fdc8c4780bf978e1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add react` scaffolds a React 19 front end into a Worker and wires it end to end — HMR against real bindings in dev, one origin in production, and passwordless sign-in already working when auth is composed. Every route Pithy provides now declares its params, query, and body on the route itself, validated by one mechanism.
  
  Two edges change what a caller sees. Free-form params — `userId`, invite `id`, room `code`, media and session ids, email tokens — are now shape-checked and can answer 400 where they previously reached a store. And a validator on the route line runs before the handler, so a request that is both malformed and unresolvable now returns 400 where it used to return the domain's 404.
  
  One more is a behavior change worth knowing about: a **repeated** query parameter is now a 400 on any validated query. `?window=a&window=b` previously resolved to one value silently; `@hono/zod-validator`'s `query` target hands the schema an array, which a scalar field rejects.
  
  Two more become correct rather than merely different. A body Hono cannot parse at all is now a 400 instead of a 500. And `turnstile()` reads the response token off a clone of the request, so a request that passes the humanity check still reaches the handler behind it — previously the gate consumed the body and only worked when it denied.

- [#100](https://github.com/pithy-sh/pithy/pull/100) [`0bb29e2`](https://github.com/pithy-sh/pithy/commit/0bb29e26617e3003ea1229415b623e0bb658f205) Thanks [@kingmesal](https://github.com/kingmesal)! - Every resource, secret, and token Pithy provisions is now named for your project, so two projects in one Cloudflare account can never quietly share — or destroy — each other's data.

- [#188](https://github.com/pithy-sh/pithy/pull/188) [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy secrets edit` opens the dev secrets file wherever it lives.
  
  Since the file moved to `<config>/<project>/secrets.jsonc` it is outside every checkout — nothing to gitignore, nothing a `git add -A` reaches, nothing an `npm pack` carries. It also stopped being something you could open, and "resolve the path yourself" is not a workflow. A symlink back into the project would have fixed that and undone the move: a link is exactly what `tar`, backup software, a Docker build context and `npm pack` follow.
  
  The command resolves the file, opens it, validates what comes back, and writes it atomically at `0600`.
  
  **The edit is never the thing that is lost.** Your editor opens on a draft beside the real file, so the real file is only ever replaced by text that has already parsed and validated. An edit that does not parse is reported and handed straight back to you *with your text in it* — re-opening the file would silently discard everything you typed, and what you were pasting may be the only copy of that value in existence. An edit that still will not validate, that your editor abandoned, or that lost a race with a `pithy add` in the next terminal is kept in a file the error names.
  
  **The editor is resolved in one place**: `$VISUAL`, then `$EDITOR`, then `notepad` on Windows and `nano` (else `vi`) elsewhere. A known GUI editor given no wait flag is refused by name with the flag to add — `EDITOR=code` returns the moment the window opens, so waiting on it validates a file nobody has touched yet. Without a terminal at all, the command refuses and prints the path instead of hanging on an editor CI will never close. A test fails the build if a second module ever resolves an editor for itself.
  
  Nothing it prints or throws carries a secret value — not the notice, not the `--json` payload, not a validation error, and not the `detail` behind it. There is a test that says so.
  
  A broken dev secrets file no longer tells you to run `pithy seed`. Every command reads that file and the seed is rarely the one that failed; the message names the file and says what is wrong with it, and leaves the command to whoever ran it.

- [#45](https://github.com/pithy-sh/pithy/pull/45) [`20c4f6c`](https://github.com/pithy-sh/pithy/commit/20c4f6c55b628318a700840ca9584b433eeaca3d) Thanks [@kingmesal](https://github.com/kingmesal)! - Secrets-manager workers now read the Cloudflare API token from the Secrets Store, and every secret — master keys included — is stored in one versioned format.

- [#53](https://github.com/pithy-sh/pithy/pull/53) [`3a65e71`](https://github.com/pithy-sh/pithy/commit/3a65e71641d23d34a73d0b73128c7c02f0e65410) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/turnstile` — stackable humanity-check middleware plus automated CF widget provisioning, with test keys wired automatically in dev and staging. Core drops `turnstile` from the `VerificationStrategy` union (it is composable middleware, not an identity strategy), adds the `turnstile/*` error codes, and gains a `dependsOn` peer-capability seam enforced at `createBackend` assembly. `@pithy-sh/cloudflare` Turnstile widget creation takes a mode (managed/invisible); the `pithy turnstile` command provisions and tears down widgets.

### Patch Changes

- [`5367798`](https://github.com/pithy-sh/pithy/commit/5367798875f200a46ec7e7a51c223e39a8b83380) Thanks [@kingmesal](https://github.com/kingmesal)! - A live suite that skips now says which fixture it wanted, and where to make it.
  
  Some suites need a real thing a human makes once in a console — a Turnstile widget on a `workers.dev` hostname, a zone with Email Routing on it, an OAuth client. Until now each one gated itself on whatever `process.env` read its author happened to write, and a run with nothing configured printed "skipped" and nothing else. Two failures hide in that silence, and both have cost this repository time: a gate that throws on a missing fixture turns "you have no credentials" into "the kit is broken", and a run where everything skipped is indistinguishable from one where everything passed.
  
  `LIVE_FIXTURES` in `@pithy-sh/cloudflare/src/test-utils/fixtures` is the estate, declared once. `fixtureReady("turnstile-widget")` is the boolean a `describe.skipIf` negates, and `docs/FIXTURES.md` is the document every skip line points at — with a test that fails if a fixture cites a section nobody wrote.
  
  **Absent means skip, never fail.** A checkout with no credentials runs the whole suite green. The report is what makes the skip visible: it runs from `globalSetup`, once per run, before a single suite is collected, and **before the credentials are read** — a contributor with no account is exactly who needs telling why the run went quiet, and gating that explanation on the thing it explains is how it goes silent for them. It never throws, exactly as the debris sweep beside it does not.
  
  **Three outcomes skip, and only one of them is fine.** `absent` is nobody having configured anything. `declined` is a switch deliberately off. `malformed` is somebody who tried and failed — an empty string from a CI job exporting an unset secret, whitespace, or the literal text `undefined` from a shell that interpolated nothing. Each is non-empty enough to pass a `Boolean(value)` check and reach Cloudflare, which answers 401 three frames later. None of them fails the run; all of them are named. That is [#323](https://github.com/pithy-sh/pithy/issues/323)'s distinction one layer up: "not set" is a claim, and it is made only when nothing was set.
  
  `PITHY_LIVE_DEPLOY` moves onto the helper and becomes a word rather than a non-empty string: `1`/`true`/`yes`/`on` arms the secrets deploy round trip, `0`/`false`/`no`/`off` declines it, anything else is malformed and skips. It deploys real Workers and deletes them again, so `0` had to mean no.
  
  A value never appears in a line, in any outcome, and a test plants one and proves it.

- [#133](https://github.com/pithy-sh/pithy/pull/133) [`270be6e`](https://github.com/pithy-sh/pithy/commit/270be6e9f8ea8f8c44b6bbea67f3c6ba61e67f64) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add secrets` wrote a config that could not load.
  
  `@pithy-sh/secrets` shipped no `src/index.ts`, so the import `pithy add` writes — `import { secrets } from "@pithy-sh/secrets/src/index"` — resolved to nothing, and every later `pithy` command failed on the config rather than on the cause. The package now has an entrypoint: the capability factory, the registry helper and its schemas, the two accessors, the table map. Nothing else. `pithy eject secrets` was broken by the same gap and works now too.
  
  A test in the CLI checks every catalog entry against the package it names — the file exists, and it exports the factory. The defect was invisible to both packages because each only ever looked at its own tree.
  
  `add`, `remove`, and `eject` now read the config's imports through one set of rules instead of three hand-built strings. The import is found by the name it binds and acted on by where it comes from: the package, any deeper path into it, or an ejected copy. `add` refuses, before writing anything, when the name is already bound to something else — it used to wire the registration anyway and let the adopter's own module answer as the capability.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - A scaffolded project can run its first `bun install`.
  
  `pithy init` wrote `"@pithy-sh/core": "^0.0.0"` into `apps/<worker>/package.json`. Nothing under `@pithy-sh/*` is published, so the first command after scaffolding 404'd — and the link script an adopter would fix it with runs on `postinstall`, which is the install that just failed. The kit dependency is now stamped from core's own version, and while that version is `0.0.0` — the marker for "not released" — no range is written at all. The package resolves from a linked checkout either way; only the range fails. The first release makes the range real with no change here.
  
  `pithy init` says where the kit comes from while it is unpublished, rather than leaving a 404 as the introduction.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add` names the worker by its directory.
  
  A Worker has two names: it deploys as `<project>-<worker>` and it lives at `apps/<worker>`. `pithy ui add` took the first and wrote it where the second belongs, so a project scaffolded `--name replay --worker board` got `./apps/replay-board/tsconfig.client.json` in its root solution file — a reference to a directory that has never existed. `bun run typecheck` stopped on TS6053, and Vite, which resolves a worker's config through that same file, could not load `apps/board/vite.config.ts` at all: `pithy dev` left a dead server on a project the adopter had not yet touched.
  
  Everything the flow names is a path or a `--worker` value, and both are the directory — the solution file's references, the client's `tsBuildInfoFile`, the actionable errors, and the `worker` field of `--json`. The deployed name belongs in `wrangler.jsonc` and nowhere else.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy init` wires the worker's `.dev.vars`.
  
  The kit's convention is one `.dev.vars` at the project root, symlinked into each `apps/<worker>/`. `pithy worker add` has always made that link; `pithy init` never did. So a plainly scaffolded project had a root file the runtime never opened, and every secret `pithy add` mints into it reported as *absent* — the value present, unreachable, and the adopter hunting for something they already had.
  
  `pithy init` now seeds the shared `.dev.vars` from the example it already ships and calls `wireFeatureDevVars`, the same implementation `pithy worker add` uses. One convention, one implementation, called from both places that make a worker.
  
  `.dev.vars` is gitignored, so the link cannot be committed: a fresh clone of a scaffolded project still makes its own.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy worker add` produces a worker that installs, and leaves nothing behind when it cannot.
  
  The literal `"@pithy-sh/core": "^0.0.0"` that `pithy init` stopped writing was still live in the second Worker producer, so every worker after the first 404'd on the install this command runs. Three failures came out of that one line, and all three are fixed.
  
  The range is now `kitRange(PACKAGE_VERSION)`, the same rule `pithy init` follows — nothing written while the scope is unpublished, the real range the day it is.
  
  The install runs **last**. It used to run first and throw, and the `.dev.vars` wiring below it never ran — so every added worker was missing the symlink `pithy init` gives every worker. Ordering settles it: by the time an install can fail, there is nothing left for it to skip.
  
  A failed run rolls `apps/<name>` back. `pithy worker add` refuses a directory that holds anything, so a half-made worker blocked its own retry and `rm -rf` by hand was the only way out. It is all-or-nothing now, and the same command works on the retry.
  
  The added worker's `package.json` also matches the starter's again: Node floor, `deploy:staging` and `deploy:prod`, `@cloudflare/workers-types@^5.20260729.1` and `wrangler@^4.115.0` — a major and sixteen minors behind, in the producer nobody re-reads. `scaffoldParity.test.ts` now covers `package.json` as well as `wrangler.jsonc`, which is what will catch the next drift.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy dev` makes the `.dev.vars` link a fresh clone cannot inherit.
  
  The project keeps one `.dev.vars` at its root and links it into each `apps/<worker>/`. Both the file and the link are gitignored, so neither can be committed. `pithy init` makes the link once, for the developer who created the project. Every developer after them clones, writes the `.dev.vars` the example tells them to, and wrangler reports every secret in it absent — the value present at the root, unreachable, and nothing in the project re-making the link.
  
  `pithy dev` now re-makes it on every run, before anything reads a variable. It is the command that runs *after* the file exists — a `postinstall` runs before it, since the usual order is clone, install, then write `.dev.vars`, so the install that would have wired it had nothing to wire. It is idempotent, a no-op when the project has no `.dev.vars` at all, and it replaces nothing but a symlink: a worker holding a real `.dev.vars` of its own keeps it and is named in the output.
  
  A scaffolded project no longer needs a `postinstall` script of its own for this.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add` writes a `@pithy-sh/vite` range the registry can resolve.
  
  The stub hardcoded `"@pithy-sh/vite": "^0.0.0"`. It was dropped only for a project that linked the package in from a checkout — resolved from outside `node_modules`. Every other adopter kept the line, and their next `bun install` 404'd, on a command days away from the one that planted it.
  
  Publication would not have fixed it. The literal never moves, so the release that made every sibling range correct would have left this one at `^0.0.0`, alone and still wrong. The range is now `kitRange(PACKAGE_VERSION)`, the same rule the starter template's kit dependency follows: a real version writes the range, `0.0.0` writes nothing at all. A stub may now declare a `null` range for any package, meaning "needed, but there is no version to name yet".
  
  Found by replaying an adopter sequence from an empty directory against a registry-style install, not by a test — 1704 of those were green.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - A real `.dev.vars` is never replaced by a link.
  
  `wireFeatureDevVars` deleted whatever it found at a target and symlinked over it. Every caller wires *every* worker it discovers, so a command touching one worker rewrote the `.dev.vars` of all of them: `pithy worker add web` in a project whose `apps/board/.dev.vars` held a secret of its own replaced that file with the root file's contents, exited 0, and said nothing. `.dev.vars` is gitignored, so what went was the only copy anywhere.
  
  The policy is now the one the file deserves. A symlink is replaced freely — that is what makes re-running idempotent and re-points a worktree after a rename, and a link holds nothing that is not in the file it points at. A regular file is left exactly as it is and reported back in `kept`, so the adopter is told rather than robbed.
  
  `pithy init` reached the same loss by a second route: the two `.dev.vars` paths it writes were invisible to its collision check, which is walked from the template, and the template ships only `.dev.vars.example`. A pre-existing `apps/<worker>/.dev.vars` is now named as a collision and the run refuses before writing anything.
  
  Two more things about that file, both found in the same review:
  
  - It is created `0600`. `cp` copies the template's mode, so the project's one credential file landed `0664` whatever the umask said — before `pithy add` and `pithy token mint` write `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS` into it.
  - The link is relative wherever one can reach. An absolute link dangles under `mv`, `cp -a`, rsync or a Docker build context, and wrangler then reports every secret absent while the file sits right there.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - A published `@pithy-sh/cli` carries the starter template it scaffolds from.
  
  `pithy init` resolved `templates/starter` four levels up, at the repo root — outside the package. That
  path exists in a checkout and nowhere else. `npm pack` listed 289 entries, 0 of them a template and 147
  of them the CLI's own tests, so the first command an adopter runs could not work. The docstring already
  admitted the gap and nothing implemented it.
  
  The template stays a single copy at the repo root, vendored into the package by `prepack` and removed
  by `postpack`. A committed second copy drifts from the one the tests hold to the kit's rules, and a
  symlink into a sibling directory does not survive `npm pack`. `files` now allows `src` and `templates`
  and excludes tests: 157 entries, 19 of them the starter, 0 of them a CLI test.
  
  Resolution tries the packaged layout first and the workspace second, and says which install is broken
  when neither is there. The test packs the tarball, extracts it, and asserts against *that* — the same
  question asked of the checkout is the blindness that let this ship, green, for months.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - The `--json` `worker` field is the `apps/` directory in every command, and the deployed script name has its own field, `deployedAs`.
  
  It used to mean the directory in `init`, `ui add` and `ui sync`, and the deployed name in `add`, `remove`, `upgrade` and `worker sync` — one field, two meanings, with nothing in the payload saying which. The two coincide whenever a project and its worker are named alike, which is what kept it hidden.
  
  `ReconcilePlan` gains `deployedAs`; its `worker` is now the directory its own schema always said it was.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - Vendoring publishes what is committed, and nothing else.
  
  `prepack` copied `templates/starter` recursively with no filter, and `files` overrides `.gitignore`.
  Against the real packer, with a maintainer's working tree: `templates/starter/.dev.vars` and an
  untracked scratch file both went into the tarball. That file is where `pithy add` and
  `pithy token mint` write `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS`. Publishing is
  irreversible.
  
  The allowlist is now the git index — `git ls-files --cached`, copied file by file, never the
  directory. An exclusion filter was the other option and it is the weaker one: a filter has to predict
  the next artifact somebody drops in that directory, and nobody predicted this one. A file ships
  because it was committed, reviewed and pushed. Symlinks are refused, and a failed copy takes the
  half-written `templates/` with it rather than leaving it to shadow the repo root.
  
  `bun run pack:verify` is the post-condition the mechanism lacked. `files` does not fail on a missing
  path, so a pack with lifecycle scripts disabled shipped a CLI with no template at all — silently,
  exit 0, the very defect `prepack` was added to close. No script the manifest declares can run during
  a pack that refuses to run scripts, so the check sits on the artifact instead: it holds a tarball to
  the index, and CI runs it on every commit. `files` carries `scripts/` now, because a published
  manifest naming `prepack` and `postpack` has to carry what they run — and both are no-ops outside a
  checkout, so neither can delete the template out of an installed package.
  
  Template resolution prefers the checkout and reaches the packaged copy second, and it will not leave
  the package to find one. Four levels up from `src/project` is the repo root in a checkout and
  `<node_modules>/templates/starter` in an install — a path owned by any dependency named `templates`.
  It is now reachable only when this module really sits under a repo root's `packages/cli`.
  
  The packaging test asserts the tarball holds *nothing* beyond the committed template, packs a
  throwaway checkout whose working tree is deliberately dirty, and no longer packs the live package
  underneath the suites scaffolding from it. The old assertion was a superset with a secret inside it,
  and it passed.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - An atomic write keeps the file's permissions, and its link.
  
  `writeFileAtomic` wrote a `.tmp` sibling and renamed it over the target. A rename replaces the target completely, so everything the target *was* had to be carried onto the temp file first. Two things were not, and both failed in silence.
  
  **Its mode.** `pithy init` chmods `.dev.vars` to `0600`. The first `pithy add` or `pithy token mint --store dev-vars` wrote through here and handed it back the temp file's `0664` — at exactly the moment it started holding `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS`. The mode of an existing target is now kept, and `writeFileAtomic` takes the mode to *create* one with; every `.dev.vars` this CLI creates is `0600`. The temp file is created restricted rather than widened after the write, so the secret is never on disk world-readable, not even briefly.
  
  **Its link.** `apps/<worker>/.dev.vars` is a symlink at the project's shared file. A rename over a symlink does not follow it — it deletes it and leaves a private regular file holding a stale copy. That made this the third producer of the loss [#142](https://github.com/pithy-sh/pithy/issues/142) was filed about, and the one that survived the fix: the wiring afterwards correctly sees a regular file, reports it `kept`, and never repairs it, so the worker silently stops seeing every secret the shared file gains. Links are now resolved and written *through*; a dangling one has its destination created rather than the link replaced, and a chain that loops is refused.
  
  **One policy for a symlink that points somewhere else.** The wiring replaced any link it found, which `pithy dev` — running it on every start since [#139](https://github.com/pithy-sh/pithy/issues/139) — turned into a daily silent undo of a link a developer deliberately pointed elsewhere. Nothing that reaches a real file is replaced now, a link no differently than a file: a link decides which secrets a worker runs with, and swinging it back is the same substitution by another route. A link is re-pointed when, and only when, it reaches nothing — the dangling case, which is the one the wiring exists to repair. A link already reaching the shared file is left alone rather than re-created, which closes a window where the worker had no `.dev.vars` at all.
  
  `kept` carries which of the two it was, and where a link goes. `pithy dev` names both. `pithy worker add` was dropping the list entirely, so a sibling keeping its own `.dev.vars` went unmentioned by the command that found it; it is in the report now, and in `--json`.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add` and `pithy worker add` say what `pithy init` says when the kit range is dropped.
  
  Both silently omitted a `@pithy-sh/*` dependency and then exited 0 — `worker add` over a `src/index.ts`
  importing `@pithy-sh/core`, `ui add` over "Install the packages: npm install", which succeeds and then
  fails the build on the missing Vite plugin. One function decides that wording for all three commands.
  
  `@pithy-sh/core` and `@pithy-sh/vite` are now a Changesets `fixed` group, which is what makes the
  `@pithy-sh/vite` range `pithy ui add` derives from core's version honest after the first release.
  
  The `wrangler` pin has one home instead of three, and the two Worker producers are held to the same
  dependency key *sets* rather than to a few named keys.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy worker add` no longer scaffolds through a symlink at `apps/<name>`.
  
  The gate read the directory with `readdir`, which follows links, so a link pointing at an empty
  directory anywhere on disk answered "empty" and the whole worker — plus a `.dev.vars` link — was
  written outside the project, exit code 0. It now asks `lstat` about the path itself, and asks before
  the directory is made, so a refusal creates nothing and the rollback has nothing to unlink.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - A change to the starter template runs the tests that guard it.
  
  CI plans its test matrix by mapping changed paths to workspace packages. `templates/starter` belongs
  to no workspace and is not repo-wide, so a PR touching only the template resolved to nothing: zero
  packages, `any: false`, every test job skipped. Measured before the fix, on a one-line edit to
  `templates/starter/pithy.config.ts` — `count: 0`. The regression test holding a published CLI to the
  template it scaffolds from never ran on the PRs that change that template.
  
  The template is `@pithy-sh/cli`'s asset — the CLI scaffolds from it, and the CLI's suite is the only
  one that reads it — so a `templates/` change now plans that package. Not the whole repo: this is a
  narrowing the affected calculation was missing, not a repo-wide file.
  
  It could not be written as `--affected --filter=@pithy-sh/cli`. Turbo intersects those two, and on a
  templates-only diff the intersection is empty — the same silence, arrived at by a longer route. The
  affected set is spelled as a filter so it unions with the CLI's, and the two forms return identical
  package lists on a templates-only diff and on a `core` diff that cascades to all 21.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add` says which Worker its minted value did not reach.
  
  `writeDevVars` grew `shadowed` and `undelivered` so a run stops reporting a delivery that did not
  happen. Both of `pithy add`'s direct writes then took `.refused` off the result and dropped the rest,
  so the defect survived at the caller: `pithy add secrets` printed "Minted a dev master key" while the
  Worker answered `Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS`.
  
  One renderer now turns a write's result into lines, shared by `pithy add`, `pithy seed` and
  `pithy dev`. A caller gets every list by taking the only thing there is to take.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - A seeded dev secret is injected into `.dev.vars` as well, so a fresh project still resolves it.
  
  `secretsStore` resolves **every** secret from its injected binding in dev, whatever its registry `backend` — only the deployed branch routes by backend. Moving `auth-session-secret` into the dev secrets file and the local `SECRETS` D1 therefore put it somewhere dev never reads: `pithy init` + `pithy add auth` + `pithy dev` answered `secrets/not_found` on the first sign-in, with the row sitting seeded and unread.
  
  So both. The file is the source of truth, it is seeded into the store, and the value is also injected into `.dev.vars` as the encoded envelope — the shape the store holds, keeping every version rather than collapsing to the current one. `pithy add` carries a value it has just minted across itself, because a project that has not composed `secrets` yet has no registry for the seeder to consult.
  
  This is a transition, not the design. [#153](https://github.com/pithy-sh/pithy/issues/153) routes dev's read path by backend, collapses the two branches into one, and deletes the injection in the same commit.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - Six corrections to how the dev secrets file is read, written, and seeded.
  
  **An unreadable file is not an absent one.** The read answered `{}` for every errno. `ENOENT` is the only one that means "no secrets yet"; an `EACCES` or `EIO` merged into an empty base, and the file's real contents went with the next write. Both the read and the write path now refuse, naming the path and the errno and never a byte of the file.
  
  **A zero-byte file is no secrets.** It hard-failed `pithy add` with exit 1 while the write half of the same module was deciding empty content meant `{}`. One state had two answers.
  
  **Nothing is stored before it is persisted.** A minted value written to D1 before it reached the file was a row nothing explained: the next run found the file still without it, minted a different value, and overwrote the row — for a session secret, every live session invalidated on every `pithy dev`, for as long as the file write kept failing. Minting now happens in one exported place, the file is written, and only what landed is seeded.
  
  **`pithy add` seeds against the config it just wrote.** The run held the module it imported before rewriting `pithy.config.ts`, so the registry it seeded against was the composition from before the add and the secret it had just minted never reached the store. It re-imports past the cache. Under Bun the query busts the cache on a path specifier and not on a `file://` URL — the difference is why this looked fixed and was not.
  
  **A JSONC syntax error carries no cause.** `comment-json`'s `SyntaxError` quotes the source it choked on — the whole file, OAuth client secrets included — and it was attached as `cause`. The line and column are kept; nothing else is.
  
  **`Object.hasOwn`, not `in`.** Four lookups walked the prototype chain: a `currentVersion` of `toString` passed the loader and failed later inside the store, a stale name matching an `Object.prototype` key never reported as undeclared, and a secret so named was silently dropped from a write the caller was told had landed.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - Three corrections where one of two siblings had the rule and the other did not.
  
  **the dev secrets file is narrowed like `.dev.vars`.** The mode was set by the write, and every caller filters out what is already in the file first — so a re-run of `pithy add` reaches the writer with nothing to add and the mode was never touched. A file created at the umask by an older pithy, an editor, or a `cp` stayed world-readable forever, holding the OAuth client secrets `.dev.vars` only carries a copy of. It is now narrowed on every path through the writer, including the one that writes nothing. Narrowing only: a deliberate `0400` survives, and a file that is not a regular file we own is left alone. One implementation, shared by both files, because the rule is about the contents and not the name.
  
  **An unreadable `.dev.vars` no longer reads as an empty one in `pithy add`.** Two sites decided "is this secret already here?" with `readFile(...).catch(() => "")`, so an `EACCES` answered "no" and `add` minted a second value into the dev secrets file. The project then held two different values for one secret, one per file, with nothing to say which had signed what. Both sites now use the writer's own reader, where only `ENOENT` means absent.
  
  **`pithy turnstile provision` says which Worker its value did not reach.** The third call site discarded the whole delivery report, so a Worker with a `.dev.vars` of its own got no sitekey and no secret while the command reported the test secret wired. It goes through the same renderer `pithy add` uses, to stderr, so `--json` output stays one line.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `.dev.vars` is read honestly, written at 0600, and never widened.
  
  Four faults in the one file that holds the dev master key and every injected session secret.
  
  An unreadable `.dev.vars` read as an absent one: `EACCES`, `EISDIR` and `EIO` all came back as "no
  file", so the next write was built from an empty base and renamed over a file full of values the
  process never saw. Only `ENOENT` means absent now; anything else is an error naming the path and the
  errno, and no line of the file.
  
  `pithy turnstile deprovision` widened the file it wrote. An atomic write is a rename, so the mode
  that lands is the temp file's, and `removeDevVars` passed none — deleting one key handed the whole
  file back at the umask default.
  
  A file already at 0664 was never tightened, because the only thing that set the mode was a write the
  no-op guard correctly skipped. The group and other bits now come off on every run. Narrowing only: a
  deliberate 0400 survives.
  
  And a symlink chain that never ends was followed to the bound and then written through, replacing the
  link with a private file and reporting the value delivered. It is refused out loud.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy token mint --store dev-vars` no longer writes a live Cloudflare token world-readable.
  
  The sink had its own copy of the `.dev.vars` upsert, and the copy called `writeFileAtomic` with no mode. An existing target keeps its own permissions and a file that does not exist yet has none, so creation fell through to the umask: minting for an environment with no `.dev.vars.<env>` yet put a **production** Cloudflare API token on disk at `0664`. Every test covering this wrote into a file the fixture had already created, which is exactly why it survived the mode fix that went in with [#146](https://github.com/pithy-sh/pithy/issues/146).
  
  The sink now goes through `upsertDevVars` — the one thing that should ever be writing one of these files, and the one that already applies `0600` on create. The duplicate is gone with it, along with a second, worse line-matcher: it kept a line's original text when only its indentation differed and never dropped a duplicate key, so a file with the same key twice could be rewritten and still read back the stale value.
  
  Every other `writeFileAtomic` caller was checked. `wrangler.jsonc`, `pithy.config.ts`, `pithy.worker.jsonc`, `package.json`, `.dev.config.json`, `.dev-ports.json`, `.dev-state.json`, `.pithy-feature.json` and the notifier's state file write configuration and local state, no credentials, and are left at the umask deliberately. `.dev.vars` and its per-environment siblings were the only secrets, and had the only two producers.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - An atomic write can no longer be redirected by a file planted at its temp path.
  
  `writeFileAtomic` wrote to `${target}.tmp` and renamed it over the target. The name was fixed, so anyone who could write to the project directory could work it out and put a symlink there first. Every write then went through that link: `.dev.vars` — `CLOUDFLARE_API_TOKEN`, `SECRETS_ENCRYPTION_KEYS`, OAuth client secrets — was written and chmod'd at the planter's chosen path, and the rename afterwards moved the *link* over the target, so every later write followed it too. Nothing to race and nothing in the output to notice: exit 0, `Done.`
  
  The temp file now carries 64 bits of randomness in its name and is created with `O_EXCL`. There is no path to plant at, and anything already at the one chosen fails the open rather than being written through. Two things fell out of the same change. The file is always brand new, so the mode it is created with is the mode it is born with — a leftover from a crashed run used to keep its own permissions through `O_CREAT`, which ignores the mode of a file that already exists. And the failures are `PithyError`s naming the path, not raw `node:fs` errnos: a dangling link into a directory that does not exist used to throw an `ENOENT` straight past the contract `--json` callers parse.
  
  `*.tmp` is gitignored, here and in the starter template. A write interrupted by SIGINT leaves a temp sibling holding the full plaintext, and `.dev.vars.*` only ever covered the one secret file whose name it happened to match.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - An atomic write holds the descriptor it opened, and stops normalizing a path it is about to hand to a
  syscall.
  
  The uid-ownership rule closed the escape. Three holes sat around it.
  
  **The chmod was an arbitrary-chmod primitive.** The exclusive create closed the *write* half of the temp
  path and left the *chmod* half open: `chmod(tmp, mode)` resolves the name a second time, so swapping the
  temp file for a symlink after the open put the mode on the link's destination — any file the invoking user
  owns, set to whatever the write asked for, which at 0666 is a disclosure. Reproduced: a 0600 private key
  came back 0666. `fchmod` and the write now both go through the descriptor, so there is no name left to
  redirect. The `rename` stays path-based because Node offers no descriptor-relative form of it, so the inode
  at the name is checked against the inode the bytes went into first — a narrower race, not no race.
  
  **The walk collapsed `..` past a component that does not exist.** The early return handed the remainder to
  `join`, which normalizes lexically: `missing/../apps/.dev.vars` came back as `apps/.dev.vars`, a path the
  kernel would have refused, rewritten into one it walks — and the surviving components were then traversed
  by the open with the ownership gate never asked about any of them. Reproduced against the real CLI: a live
  `CLOUDFLARE_API_TOKEN` landed outside the project through an `apps` link nothing had checked. Past the
  first missing component the walk resolves nothing and lets the syscall judge the path it was given.
  
  **The adopted mode was not checked for ownership.** Keeping the target's mode is what respects an adopter's
  deliberate 0640, and it is also an instruction read out of a file. Pre-creating `.dev.vars` at 0666 is one
  line of work for whoever can write the project directory and cannot read the 0600 file in it — the position
  every attack here is launched from — and the freshly minted secret landed world-readable with nothing
  reported. A mode is adopted only from a file we own. Deliberately stricter than the link rule, which allows
  root: a root-owned link sends a write somewhere root chose and root reads our files regardless, but a
  root-owned 0666 gives the file to everybody else.
  
  The tripwire that was meant to stop a sixth producer was got past three ways on the first try — `renameSync`,
  a `.tmp` literal spelled any other way, and the same code one directory outside `packages/cli/src`. It
  asked which idiom a file used, which is a guess at intent, and intent is what an evader controls. It now
  asks which modules can reach a rename at all, across the whole repository. That is a fact about a module's
  imports rather than a guess about its meaning, the answer is four files, and a fifth has to be written down
  with a reason. Still a scan over source text, and said so in place: TypeScript 7 ships no parser API, and
  Biome's `noRestrictedImports` with a per-path override is where the rule belongs when the chance comes.
  
  Refs [#151](https://github.com/pithy-sh/pithy/issues/151)

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - An atomic write follows a symlink only when we could have made it, and reclaims what a killed run leaves.
  
  Making the temp file unguessable moved the exfiltration one step earlier instead of closing it. Plant a
  symlink at `.dev.vars` rather than at its temp file and `writeFileAtomic` followed it, adopted the
  destination's mode, and renamed onto it. Reproduced against the real CLI: `pithy add secrets` minted
  `SECRETS_ENCRYPTION_KEYS` straight into a directory outside the project and printed `Done.`
  
  Containment cannot be by location. `apps/<worker>/.dev.vars` links to the project's shared file and a
  worktree's links to the **main checkout's**, outside the tree entirely — the same shape as the attack and
  the opposite answer, so refusing by destination would put [#146](https://github.com/pithy-sh/pithy/issues/146) back. It is by **owner**: `symlink(2)`
  stamps the creating uid on the link and only root may change it, so a link made by the developer running
  the command is distinguishable from one planted by whoever else can write the directory. Every component
  of the path is walked, not only the last — a link three directories up carries a write out of the project
  just as completely.
  
  The random temp name also leaked. Every interrupted run left a distinct `.dev.vars.<rand>.tmp` holding the
  whole plaintext credential file, where the old fixed name was at least overwritten by the next run. A
  finished write now sweeps its target's stale siblings — its own name shape, regular files, ours, and older
  than a minute.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - Say what a failed delete left behind, and stop a write from widening a file it did not create.
  
  A recursive delete that could not finish threw the raw `node:fs` errno and its stack through the `PithyError` contract — unparseable for a `--json` caller — and said nothing about the half-emptied tree it had already made. Reachable by accident: a directory the adopter chmod'd, a file another process holds open. `pithy worker remove board` now exits 1 with "Could not finish deleting apps/board. 8 paths are still there: …", and the errno stays in `detail`, where the codec strips it.
  
  `writeFileAtomic` keeps the mode of a file it rewrites, which is how an adopter's deliberate 0400 survives a token write. It kept a *wider* one too, so a `.dev.vars` pre-created at 0644 handed a freshly minted `CLOUDFLARE_API_TOKEN` to every account on the machine, with nothing reported wrong. The mode a caller asks for is now a ceiling: tighter is adopted, wider is not. A caller that names no mode names no ceiling — those files hold no credential.
  
  And the path walk stopped collapsing `..` above a component that exists and is not a directory. `package.json/../escaped.txt` is ENOTDIR to the kernel every time; the walk rewrote it into a path the caller never named and never checked, and the write landed there. A typo reaches it. The syscall judges the path it was given, and ENOTDIR now names the component in the way instead of telling the adopter to check that the file is writable.
  
  Refs [#151](https://github.com/pithy-sh/pithy/issues/151), [#158](https://github.com/pithy-sh/pithy/issues/158).

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - The gate that was meant to stop a fifth symlink escape banned two probes out of five, and missed it.
  
  `stat`, `statSync` and `existsSync` follow a symlink exactly as completely as `access` does. The test
  added with the last fix banned only `access` and `accessSync`, so it was green on `capabilities/eject.ts`
  — which asked with `stat`, and was the fifth producer. The tripwire had the blind spot of the sweep that
  missed the bug.
  
  The rule is the whole class now, and it names every writing module in the package. Two were unrouted.
  `pithy add <cap> --eject` copied a capability's entire source through a link at `apps/<worker>/capabilities`
  and printed "Done." — reproduced. `pithy ui add react --worker board` wrote ten files of a React front end
  outside the project through a link at `apps`, because `scaffoldFiles` bounded the walk at the worker and
  put `apps` and `apps/<worker>` above it; the walk starts at the project root now. Five other modules follow
  a link on purpose — a mode, an mtime, a `node_modules` path a package manager linked — and each says so in
  one line the test holds it to. An unlisted follower fails the build; so does a listed one that stopped.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy init` from a checkout copied the maintainer's `.dev.vars` into the adopter's new project.
  
  `cp(templateDir(), targetDir, { recursive: true })` had no filter, so the starter arrived as it sits on
  the machine running the command — gitignored files included. Reproduced: a `.dev.vars` holding a live
  `CLOUDFLARE_API_TOKEN` landed in a brand-new project at mode 0664, because `cp` copies the source file's
  mode, and `seedDevVars` then found a `.dev.vars` already there and left it exactly as it was. `git status`
  said nothing, because the file is ignored.
  
  [#145](https://github.com/pithy-sh/pithy/issues/145) read the git index to decide what the published tarball carries, and stopped at the packer.
  `pithy init` is the other reader of the same directory. Both ask `committedFiles` now — one module, in
  `src/`, importing nothing but `node:child_process` and `node:path`, which the packing scripts reach by
  rooting their program one directory higher. The collision gate reads the same allowlist, so `pithy init`
  never refuses over a file the copy would not write. An installed CLI has no index beside its vendored
  template and copies it as it stands: `prepack` built that copy from this same list.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - One gate decides whether a path is safe to scaffold into, and `pithy ui add`, `pithy worker add`, and
  `pithy worker rename` all ask it.
  
  Three more gates followed symlinks. `pithy ui add` wrote six files of the front end outside the project
  through a link at `apps/<worker>/src`, exit code 0. `pithy worker add` did the same with a link one level
  up at `apps` — the level the previous fix never looked at. `pithy worker rename` cleared its own gate on
  a dangling link and died on a raw `node:fs` ENOTDIR, through the error contract `--json` callers parse.
  
  `ensureScaffoldPath` now walks every directory between the project and the target, `lstat`s each one, and
  refuses a symlink or a file with an actionable `PithyError`. A test fails the build if a module that writes
  to the filesystem probes with `access` again.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - Dev resolves each secret from the backend its registry entry names, exactly as deployed does.
  
  `secretsStore` had two branches. Deployed routed by `backend` — a `d1` secret from the encrypted per-environment row, a `cf-secrets-store` one from its binding. Dev routed by nothing: **every** secret came from an injected `.dev.vars` string whatever the registry said. `ENVIRONMENT` was what picked between them.
  
  There is one branch now, and `ENVIRONMENT` decides nothing about resolution. Which environment's values a worker reads was already settled by which `SECRETS` D1 and which master key it is bound to; routing on the var as well was a second answer to a settled question, and it cost three things.
  
  **`.dev.vars` stops carrying application secrets.** [#149](https://github.com/pithy-sh/pithy/issues/149)'s dual-write is deleted in this commit. The file goes back to what wrangler says it is: env bindings, `UPPER_SNAKE`, one namespace. A kebab registry name sitting in it taught every adopter that one of the two conventions was a mistake. `pithy add`, the seeder, and `pithy turnstile provision` each wrote a copy there; none of them does now. The master key and the public Turnstile sitekeys stay, because those genuinely are env bindings, and a `cf-secrets-store` secret stays because there is no local Secrets Store and the binding is the only place a Worker can read one.
  
  **Dev stops being a shape production never sees.** A `.dev.vars` value was decoded leniently, so a rotated secret collapsed to whichever version was current and `pithy secrets rotate --env dev` exercised a path only staging ran. Dev reads the same envelope the row holds, versions and all.
  
  **A `d1` secret with no row but a binding of its own name is named, with the fix.** That is the one shape an upgrade produces — an adopter's pre-[#149](https://github.com/pithy-sh/pithy/issues/149) `.dev.vars` line, or a Workers-runtime test injecting a `d1` value as a bare string. Reading it would put the asymmetry back; answering "not provisioned" about a value sitting right there is no better. It is `validation/invalid_input`, it names the secret, and it says to put the value in the dev secrets file and run `pithy seed`.
  
  `cf-secrets-store` keeps accepting a plain string, permanently. `pithy token mint` writes a raw token, and an entry made by hand or by `wrangler secrets-store secret create` is a plain string too — there is no envelope to find there, and that is not a gap.
  
  **The cost, stated plainly:** a Worker with any `d1` secret now needs its `SECRETS` D1 and a dev master key in dev too. `pithy add secrets` mints both, and a project composing a capability that declares a `d1` secret already needed them to deploy.
  
  A registry secret still sitting in an adopter's `.dev.vars` is inert rather than competing, so the seeder and `pithy add` mint and seed beside it instead of standing down — standing down would leave the Worker with no session key at all. Nothing rewrites their file; `pithy doctor` names the stranded line every run, as a duplicate when the value has already moved and as the migration notice when it has not.
  
  **`writeDevVars` gates every directory it writes beside, through the shared `ensureScaffoldPath` ([#167](https://github.com/pithy-sh/pithy/issues/167)).** The directories come from `discoverWorkers`, which builds `apps/<name>` from a `readdir` that follows whatever `apps` is — so a symlink at either planted a `.dev.vars` link, pointing at the project's shared credential file, inside a directory outside the project, and reported it as `linked`. The sibling in `feature/devVars.ts` documented that defect and had the gate; this module did not import it at all. One rule, one implementation, and a refused directory is reported as `undelivered` rather than thrown — by that line the project's own file is already written, and a planted link in a directory no Worker of theirs owns must not stop `pithy dev`.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - Each Worker's `.dev.vars` is generated. The shared symlink is gone.
  
  `.dev.vars` was one file at the project root, symlinked into every `apps/<worker>/` because that is where wrangler reads it, and symlinked again from a worktree back to the main checkout. That single decision produced four defects — [#137](https://github.com/pithy-sh/pithy/issues/137) (`pithy init` never wired the link, so every minted secret was unreadable), [#139](https://github.com/pithy-sh/pithy/issues/139) (a fresh clone has no link and nothing re-makes it), [#142](https://github.com/pithy-sh/pithy/issues/142) (wiring the link deleted a real file, losing gitignored secrets with no copy anywhere), [#146](https://github.com/pithy-sh/pithy/issues/146) (an atomic write detached the link into a stale private copy) — plus a standing question about a link an adopter pointed somewhere deliberately.
  
  Each was fixed on its own terms. **None of them exists any more**, because none of them can happen to a file that is generated: there is no link to wire, dangle, delete, or detach. They are closed by removal, not fixed again.
  
  `pithy dev` and `pithy seed` now write `apps/<worker>/.dev.vars` from the machine-local bootstrap set and the `.dev.vars.local` overrides. This is cheap only because [#153](https://github.com/pithy-sh/pithy/issues/153) landed: `.dev.vars` no longer carries application secrets, so what is generated is the bootstrap set — the master key, `cf-secrets-store` values, public vars. Two or three lines.
  
  **Never overwrite a file a human wrote.** The generated file opens with a `Generated by pithy` header. A `.dev.vars` without it is the adopter's: the run refuses, names the path, and points at `.dev.vars.local`. It does not overwrite and it does not merge, and `pithy seed` exits non-zero. That is [#142](https://github.com/pithy-sh/pithy/issues/142)'s lesson, built in from the start rather than found a third time in a file every adopter has.
  
  **`.dev.vars.local`, at two scopes.** The root's reaches every Worker; `apps/<worker>/.dev.vars.local` reaches that one and wins. Hand-authored, gitignored, never generated, merged last — so overriding one value for an afternoon needs no edit to the source of truth and is not blocked by the generator. It is for **overrides, not variables**: anything that should exist in production belongs in `wrangler.jsonc`'s `vars`. `pithy doctor` names any `.local` key that is neither a registry secret nor declared there — "this exists only in dev" — and any that shadows a registry secret. Visible, not forbidden.
  
  **A run that changes nothing writes no bytes**, decided by comparing content and never mtime. The header check already has the file in memory, so the comparison costs a string equality; mtime lies in at least five ways, and one of them is not a file at all — upgrading a capability can add a secret to the registry with nothing in the project changing. What it buys is not CPU but watcher churn: wrangler watches this file.
  
  Where the values live: the dev master key and every `cf-secrets-store` value are recorded in `<config>/<project>/dev.json`, as a second tenant beside the dev-login preferences [#131](https://github.com/pithy-sh/pithy/issues/131) put there. A generated file cannot be its own source of truth. A key already in a pre-[#154](https://github.com/pithy-sh/pithy/issues/154) project's `.dev.vars` is adopted rather than re-minted — replacing it orphans every secret encrypted under it.
  
  Also removed: the `vars:local` turbo task and its `ln -sf` in every package manifest, and the `.dev.vars` half of `scripts/worktree.ts`. `pithy init` writes no `.dev.vars` at all. A fresh clone runs `pithy dev` and works, with no postinstall and nothing to remember.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - Dev secrets leave the repository. They live at `<config>/<project>/secrets.jsonc`.
  
  `.dev.vars` sits in the worker's directory because wrangler reads it there — the location is not ours
  to choose. Nothing but our own CLI reads the secrets file, and the CLI resolves its own paths. So it
  does not need to be in the project; it needs to be found.
  
  Everything that followed from having it there followed from that one assumption. A mint into a file the
  project did not ignore. A `.tmp` sibling one SIGINT from a published tarball. A worktree with no secrets
  at all, which then minted a second set and diverged in silence. An `rm -rf` on a checkout taking every
  dev credential with it. Each was patched where it appeared; moving the file removes the class.
  
  No symlink either. A link puts the file back in the field of view of every tool that follows one.
  
  `<config>` is `$PITHY_CONFIG_DIR`, else `%APPDATA%\pithy`, `$XDG_CONFIG_HOME/pithy`, or
  `~/.config/pithy` — the directory `~/.config/pithy/<project>/dev.json` already lives in, resolved by the
  resolver that already existed. The override is required rather than convenient: CI has no home directory
  worth writing to, and without it every test scaffolding one project name writes to one real file.
  
  The directory is `0700` and the file `0600`, held there on every write rather than only on creation.
  
  What goes with it: the gitignore guarantee for the secrets file, because there is nothing in the
  repository to ignore — `.dev.vars` keeps its lines, and `.dev.secrets.example.jsonc` stays, committed,
  as documentation. The worktree link, because every worktree of a project resolves the same path with no
  wiring. Every refusal a write could return, because there is nothing left to refuse.
  
  Because the file is no longer in your file tree, `pithy doctor` prints its resolved path on every run,
  and every error naming it names it absolutely. The path is keyed on your project's `name`, so a rename
  leaves the old directory behind with your values in it — doctor names that too rather than leaving you a
  mystery.
  
  Delete the whole checkout and re-clone: the secrets are still there.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy worker remove` and `pithy remove` no longer `rm -rf` through a symlink.
  
  Both built a path out of a name — `apps/<name>`, and `apps/<worker>/capabilities/<cap>` for an ejected
  capability — and handed it straight to a recursive delete. Reproduced with the real CLI: a project
  scaffolded `--name replay --worker board`, `apps` replaced with a link to a directory outside it, then
  `pithy worker remove board`. The link's destination and everything under it was gone, and the command
  printed "Removed replay-board." and "Done."
  
  Every other escape in this series writes a file somewhere it should not, and recovery is deleting the
  file. These remove a tree, and there is nothing to recover.
  
  `removeScaffoldPath` is the one answer, and the `rm` lives inside it so no caller can route around it. Its
  gate is stricter than the write gate: every component between the project and the target must be a real
  directory, **and** the path must still resolve inside the project once the kernel has walked it — which
  catches a bind mount, a hard-linked directory, and a link swapped in after the check. The project root is
  never a valid target. Refusals are `PithyError` with an action that names a delete, not a write.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - The two seed writers go through the atomic write, and the exemption list is empty.
  
  `writeSeedArtifact` puts the **live dev-login session cookie** on disk. It used a plain `writeFile`: the
  file landed at whatever the umask allowed — world-readable on a default one — and a foreign-owned symlink
  at `logs/dev-login.json` carried it out of the project entirely. It is written owner-only now, through the
  primitive that owns the link-ownership rule; a file already there keeps the mode the adopter gave it.
  
  `seed/media.ts` rolled its own temp-file-plus-rename for the asset-id sidecar: no exclusive create, no
  ownership check, no mode, no sweep of what a killed run leaves. The payload changes what that costs, not
  whether it is the same shape.
  
  `seed/media.ts` was on the rename gate's list with a note saying to route it and delete the line. That is
  this. Nothing is exempted now because nobody got to it yet — every entry left names a rename that is a
  rename.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - Two more escapes, and a tripwire that can see the shapes it was missing.
  
  `pithy worker add` wired a `.dev.vars` symlink through a symlinked `apps/<worker>`. The wiring runs over
  every worker *discovered*, not just the one being added, and discovery reads `apps/` through whatever is
  there — so a link planted at `apps/other` put a `.dev.vars` inside a directory outside the project.
  Where the shared file lives outside the tree, that link is written absolute and points straight at
  `CLOUDFLARE_API_TOKEN`. Reproduced with the real CLI. `pithy dev` runs the same wiring every time.
  
  `pithy init` read "git could not answer" as "this is the vendored template" and fell back to copying the
  directory as it sits. That is right for an installed package and puts [#145](https://github.com/pithy-sh/pithy/issues/145)'s leak straight back on a real
  checkout where git is missing or the repository is broken — `.dev.vars` and all, silently. The two states
  are now told apart by which layout the template resolved from, which the resolver already knew.
  
  The tripwire itself had two blind spots, both self-reported. It defined "a module that writes" as one
  importing `node:fs`, so `ui/flow.ts` — which probes with `access` and writes through `scaffoldFiles` —
  was never examined; this package's own writers now count the same. And nothing anywhere noticed a
  recursive `rm` on a path built out of a name, which is exactly what [#158](https://github.com/pithy-sh/pithy/issues/158)'s two producers were. Both are
  gates now, and each exemption has to be written down.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - Dev secrets cannot reach a managed environment, whatever the caller asks.
  
  the dev secrets file holds minted random dev values. Seeding it into staging or production would not
  set some secrets — it would rotate every one at once: every session invalidated, every signed link
  broken, every OAuth credential replaced with a value the provider has never seen, and no undo, because
  the values it overwrote were the only copies.
  
  The rule was a conditional in one caller out of six. It is now in the seeder. No signature in the
  dev-secrets path accepts an environment — `env` is typed `never`, so a caller that tries to pass one
  does not compile — and the seeder asserts the destination rather than the intent: the store must be
  the project's own local Miniflare-backed dev store, by the path it persists to. A store that will not
  say where it writes is refused too. Permissive-by-default was the bug.

- [#162](https://github.com/pithy-sh/pithy/pull/162) [`2d676e3`](https://github.com/pithy-sh/pithy/commit/2d676e3d9a1f4942462c354f4c7e510700a00ba8) Thanks [@kingmesal](https://github.com/kingmesal)! - A failure that cannot answer says so, dev secrets stop at dev, and a credential file is never rewritten unread.
  
  A failed delete told the adopter the opposite of the truth. `survivorsOf` read "the scan threw" as "the target is gone", and an unreadable directory fails the `rm` and fails the scan for the same reason — so the one case where the whole tree survived printed "Nothing of it is left." Reproduced with the real CLI: `pithy worker remove extra` against a `-wx` directory, six files still on disk. There are three states now, and only one of them is nothing: `pithy worker remove` says "Pithy could not read it back, so what is left of it is unknown. Check it." when it cannot tell, and still lists the survivors when it can. Both errnos stay in `detail`, where the codec strips them.
  
  `devSecretReader` read the project's `.dev.vars` in every environment. `.dev.vars` sits on the operator's disk under every `--env`, so `pithy seed --env prod` handed a prepared set a live local dev secret and wrote it into production rows. [#159](https://github.com/pithy-sh/pithy/issues/159)'s rule is absolute and the adopter cannot opt out, so it lives in the reader: outside `dev` the reading closure is never built, the file is never opened, and a set that asks is refused by name. Provably dev, not merely not-prod — an unknown or misspelled environment refuses too, because the permissive default is the whole bug.
  
  And `upsertDevVars` destroyed the file it could not read. Every read failure was treated as an empty file, and the atomic write then landed a `.dev.vars` holding only the keys being upserted — every other secret gone, with no copy anywhere because the file is gitignored. `EACCES` on a file that plainly exists is enough; no attacker is involved. Only `ENOENT` means absent now, for `removeDevVars` too, which had the same shape and the quieter failure: it returned early and its caller printed success while the credential sat in the file untouched.
  
  Refs [#159](https://github.com/pithy-sh/pithy/issues/159), [#160](https://github.com/pithy-sh/pithy/issues/160).

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add` writes every option the capability requires.
  
  `pithy add` renders one `key: default` per manifest option, and a manifest could only state a JSON scalar. `SecretsConfig.registry` is neither optional nor a scalar, so no manifest could declare it and `pithy add secrets` wrote `secrets({ rotationIntervalDays: 30 })` — a registration missing a required property. `bun run typecheck` on a freshly scaffolded project then failed `TS2741` before the adopter had touched a file, and secrets is the first capability most projects add, because auth, email and payments all read their credentials through it.
  
  An option's manifest value may now be an empty object or an empty array, and `@pithy-sh/secrets` declares its `registry` as one. The contents stay the adopter's — `add` cannot invent a secret — but the key is present, the config compiles, and the comment above it says what belongs inside. `pithy upgrade` reports and writes the same option into a project that composed secrets before this. Neither `--set` nor the interactive prompt will touch such an option: both carry strings, and a registry is not a string.
  
  `scaffoldGates.test.ts` now runs `pithy init` → `pithy add secrets` → `tsc -b` against a real scaffold, which is the sequence that was never run end to end.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy worker rename` gates its source, and the rule stops enumerating verbs.
  
  The destination was gated and the source was not. A symlink at `apps/<from>` was moved as a link, so `apps/<to>` arrived still pointing outside the project — and the `wrangler.jsonc` and `package.json` rewrites that follow the move then went through it. Reproduced against a canary directory: the command reported success and left the canary's two files renamed. The source now goes through `ensureScaffoldPath` as well, with a refusal that describes a move rather than a scaffold, because "the files would land outside the project" is the one sentence an adopter acts on and it was about the wrong command.
  
  That was the seventh producer of one class, and its third verb: **write** ([#147](https://github.com/pithy-sh/pithy/issues/147), [#151](https://github.com/pithy-sh/pithy/issues/151), [#152](https://github.com/pithy-sh/pithy/issues/152)), **delete** ([#158](https://github.com/pithy-sh/pithy/issues/158)), now **move**. The two tripwires guarding it enumerate verbs — one names five link-following probes, the other names `rm` — so both were green on a `rename`. Adding `rename` to a list buys nothing; the eighth producer is `copyFile`, or `link`, or `truncate`.
  
  So there is a third rule, and it asks about the **path**: a mutating filesystem call on a path composed from a name the adopter typed must go through the gate. `node:fs`'s mutating surface is a closed set and all of it counts. It is a heuristic over source text, and it says in the source exactly what it can see — a module's `const` initializers, to a fixpoint — and what it cannot: parameters, a fresh name appended to an already-gated path, a re-export.
  
  Two holes in the older rules closed with it. The rename rule's static-import regex hardcoded `node:fs`, so `import { rename } from "fs/promises"` — the same module, one prefix short — passed it. And both scaffold rules walked `packages/cli/src` alone; they now walk every package's shipped source, with the repository's own build scripts and test harnesses left out deliberately and on record, since none of them ever runs against an adopter's project.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - A delete that did not happen no longer reports success.
  
  `removeScaffoldPath` read every `realpath` failure as "nothing there", and `ensureScaffoldPath` read every `lstat` failure as "missing, and so is everything below it". Neither is true for `EACCES`, `ELOOP`, or a mount that went away. A `chmod 0600` on `apps/` — readable, not searchable — was enough: the gate cleared a path it had never seen, the function returned having removed nothing, and the caller printed success.
  
  Through `pithy remove <cap>` on an ejected capability it is worse. Config and wrangler are unwired first, so the run ended with the capability unwired, its source entire on disk, and an audit record saying `capability/removed`, `outcome: "success"`. A false audit record is the one failure this project cannot treat as cosmetic.
  
  The rule was already written down nine lines away, in `survivorsOf`: only `ENOENT` means gone; anything else the probe cannot answer is unknown. It is now one function all four sites share, so it cannot be true in one of them and forgotten in the others. A path nothing could be established about stops the command and says which errno stopped it, in `detail`, where the HTTP codec strips it.
  
  The root's own resolution gets its own sentence too. Swallowed, its failure printed "it isn't inside the project" — advice to treat a path as hostile, about a target nothing had established anything about, because the project directory could not be resolved.
  
  Tested with a non-searchable **ancestor**. The existing tests chmod the target to 0500/0300, which leaves it reachable through its parent, so both probes succeed and it is the `rm` that fails — which is exactly why this survived a suite that already chmods.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add` seeds a worked example where an empty one would not load.
  
  Three capabilities still left a project that could not typecheck. `ledger` omitted `currencies`, `multiplayer` omitted `games`, and `leaderboard` omitted `boards` behind a `serverAuthoritative` defaulted to the string `"true"` against a boolean field. All three failed `tsc` on a scaffold the adopter had not touched.
  
  [#161](https://github.com/pithy-sh/pithy/issues/161)'s empty literal is the wrong fix here, and that is the whole of this change. Each of the three puts `.min(1)` on its collection with a message saying why — *"A ledger with no currencies does nothing."* An empty seed compiles and then throws `too_small` on the first config load, which `pithy upgrade` reports as "Could not load pithy.config.ts / Install the project's dependencies". That names the wrong cause and is worse than the type error it replaced.
  
  So a manifest default may now be a complete, minimal, working example, and each of the three states one. `ledger` seeds `chips` — one currency, the schema's own first example of a unit that is plainly not money. `leaderboard` seeds an all-time board where the highest score wins: the smallest board that works and the one shape that needs no rank worker. `multiplayer` seeds tic-tac-toe — the built-in `connect-n` model on a 3x3 board, two players, no wagering — the smallest game that actually plays. The comment above each says to replace it. The adopter edits one line instead of inventing a shape from a type error.
  
  `ConfigOptionValue` widens to any JSON value but `null`, stated recursively rather than as `unknown` contents, so a null buried three levels down is now rejected instead of rendered into someone's config file. Rendering is no longer `JSON.stringify`: that quotes every key, and Biome rewrites `{"code":"chips"}` to `{ code: "chips" }` and fails the scaffold's own lint gate. `renderConfigValue` prints the shape Biome would have printed, on one line.
  
  Each of the three capabilities now checks its own manifest against its own factory — the rendered options are type-annotated, so a shape the factory would reject fails the compile, and the factory call is what proves the seed survives the `.min(1)`.
  
  All fifteen addable capabilities now go `pithy init` → `pithy add` → `tsc -b` → `biome check` clean, and fourteen of them load the config they were written into. `multiplayer` is the exception, for an unrelated reason: its entrypoint re-exports the Durable Object, so importing its config outside workerd fails on `cloudflare:workers`. That is its own defect.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - One renderer for a manifest default, one gate for the line it lands on.
  
  [#168](https://github.com/pithy-sh/pithy/issues/168) replaced `JSON.stringify` with `renderConfigValue` so a generated `pithy.config.ts` would already be in the shape Biome prints. It replaced one of two. `pithy upgrade` kept its own copy, so the same manifest produced `[{ code: "chips", name: "Chips" }]` from `pithy add` and `[{"code":"chips","name":"Chips"}]` from `pithy upgrade` — and only the first survived the `biome check` a scaffolded project runs on itself. Both commands now render through `renderConfigOptionLine`, which is the whole line and not just the value, and a test asserts the two commands agree rather than asserting a string. That is what stops a third producer.
  
  The one-line rule was a docstring. Biome breaks any literal past 120 columns and explodes it across a dozen lines, which fails `biome check` on a project the adopter has not touched — the defect [#161](https://github.com/pithy-sh/pithy/issues/161) and [#168](https://github.com/pithy-sh/pithy/issues/168) were both about. Nothing checked it, and the margin was thinner than it looked: multiplayer's seed is 98 columns of 120, and a `battle` game with a two-move catalog reaches 135. It is now a test over every manifest the repo ships, rendered at the indent the writers really use. A sixteenth capability with an oversized seed fails the build instead of an adopter's first `bun run lint`.
  
  `ConfigOptionValue` narrows rather than the renderer growing a copy of Biome's formatter. Three shapes the widened type admitted did not print the way Biome prints: `he said "hi"` renders with escaped quotes where Biome writes `'he said "hi"'`, `1e21` renders as `1e+21` where Biome writes `1e21`, and `"${x}"` renders valid TypeScript that trips `noTemplateCurlyInString`. The alternative was to carry a quote-preference heuristic and a numeric-literal normalizer, and keep both in step with a formatter free to change either — for inputs no worked example should carry. A manifest default is an example; one needing a quote inside a string is already too clever. The schema refuses all three, and `renderConfigValue` refuses them too, so `pithy add --set` fails at the command rather than writing a file that fails the lint gate later.
  
  The test that asserted the escaped-quote rendering as correct is corrected. It pinned a violation of the function's own stated contract, which would have made the fix look like a deliberate assertion being deleted.
  
  Every case above was checked by writing the rendered output to a file and running Biome over it with the scaffold's own `biome.jsonc`. The whole defect class here is guessing what Biome would print.

- [#177](https://github.com/pithy-sh/pithy/pull/177) [`52ad9e6`](https://github.com/pithy-sh/pithy/commit/52ad9e6607bac5d4a1e3f07b240cdac87626212e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy seed` reads the secret it just seeded.
  
  A prepared seed set asks the CLI for a secret. That reader still opened the project's `.dev.vars` —
  the file [#153](https://github.com/pithy-sh/pithy/issues/153) emptied of every `d1` secret and [#154](https://github.com/pithy-sh/pithy/issues/154) turned into a generated per-Worker artifact. So
  `pithy seed` on any project composing auth's dev-session seed printed two lines that contradicted each
  other:
  
  ```
  Seeded auth-session-secret and email-link-signing-key into the local secrets store.
  Cannot mint a dev session without this environment's auth secret.
  Add auth-session-secret to .dev.vars, then seed again.
  ```
  
  The secret was seeded. The seed that needs it could not see it. And the advice was to undo [#153](https://github.com/pithy-sh/pithy/issues/153) — a
  `d1` value in `.dev.vars` is inert, so following it produced the same failure a second time.
  
  The reader now reads the dev secrets file, `<config>/<project>/secrets.jsonc`: the same source the run
  had minted into two steps earlier, and the only place a dev value is *stated*. It needs no D1 and no
  master key, so it answers where seeds run. There is no `.dev.vars` fallback and no backend branch,
  because there is no second source — a `cf-secrets-store` line in a Worker's `.dev.vars` is generated
  from this file, and a run-wide reader cannot say which Worker's copy it should trust anyway. What is
  given up is narrow and deliberate: a value supplied only through a hand-written `.dev.vars.local`
  override is not visible to a prepared set.
  
  The value goes through the registry and the same conversion that fills the store, so a prepared set is
  handed exactly the bytes the running Worker will resolve — a `text` secret that is not a string is
  refused by name rather than stringified. A name no capability declares reads as absent, because the
  Worker could not resolve it either. [#159](https://github.com/pithy-sh/pithy/issues/159)'s environment gate is untouched: outside `dev` the reading
  closure is never built.
  
  Auth's message names the dev secrets file now. It does not guess the path — that set runs inside a
  Worker with no filesystem, and `pithy doctor` prints the resolved path on every run.
  
  The suite missed all of this because the dev-session seed's tests supply the secret through the
  `secret` seam, so the seam was exercised and the thing behind it never was. The new test composes the
  real seed against a project whose secret is in the new location and resolves it through the real
  reader.
  
  Fixes [#176](https://github.com/pithy-sh/pithy/issues/176).

- [#201](https://github.com/pithy-sh/pithy/pull/201) [`bd9899e`](https://github.com/pithy-sh/pithy/commit/bd9899edc6af695a1ac795e83ff4cb073fd2d929) Thanks [@kingmesal](https://github.com/kingmesal)! - The dev secrets file is the source of the values a Worker receives ([#179](https://github.com/pithy-sh/pithy/issues/179)).
  
  `generateDevVars` reads `<config>/<project>/secrets.jsonc` and the registry directly and materialises
  every `cf-secrets-store` secret into each Worker's `.dev.vars`. It read a **copy** before: `pithy seed`
  routed each value into `<config>/<project>/dev.json` under `vars`, so rotating a value in the file named
  "the dev secrets file" did not reach a Worker until something re-seeded, a removed secret's plaintext
  stayed in `dev.json` forever, and the generated header named a source it did not read.
  
  `SECRETS_ENCRYPTION_KEYS` is a registry secret now — `cf-secrets-store`, `json` against
  `EncryptionConfig`, and `bootstrap: true`, a new registry axis for the one secret a Worker reads straight
  off its binding because it is what the envelope decoder needs to exist. `pithy add secrets` mints it into
  `secrets.jsonc`; the local `SECRETS` store opens from there, and still opens for a project whose key is
  in `dev.json` or in the project root's `.dev.vars`.
  
  `dev.json` keeps only what no registry declares — a Turnstile sitekey has no other home. A registry name
  there is dropped outright, which is what makes a deletion take effect. `pithy doctor` names each one.

- [#201](https://github.com/pithy-sh/pithy/pull/201) [`bd9899e`](https://github.com/pithy-sh/pithy/commit/bd9899edc6af695a1ac795e83ff4cb073fd2d929) Thanks [@kingmesal](https://github.com/kingmesal)! - No minted credential is written into the checkout, for any environment ([#182](https://github.com/pithy-sh/pithy/issues/182)).
  
  Cloudflare's account credentials — `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `SECRETS_STORE_ID`,
  `R2_CREDENTIALS` — are account-scoped, so they live in `<config>/cloudflare.json` at mode `0600` in the
  `0700` config directory rather than in the project root's `.dev.vars`. `pithy init` records the pair at
  the one moment you are holding both. The `process.env` overlay is unchanged, per key, so CI still passes
  them as plain environment variables with no file at all.
  
  `pithy token mint --store dev-vars` writes `<config>/<project>/tokens.json`, keyed by environment.
  It wrote `.dev.vars` for dev and `.dev.vars.<env>` for everything else — so minting for production put a
  live production Cloudflare token in the checkout. Gitignored is not sufficient: `npm pack` does not read
  `.gitignore` when `files` is set ([#145](https://github.com/pithy-sh/pithy/issues/145)), and that path had its own `0664` permissions defect on record.
  
  `pithy add secrets` resolves the account's Secrets Store and records `SECRETS_STORE_ID` — the one moment
  in that key's life anything asks Cloudflare where the store is. Cloudflare permits one store per account,
  so two is refused and named rather than guessed at, zero is explained, and a recorded id is never
  overwritten (a mismatch is reported instead). Nothing here can fail the command: no credentials, no
  network, and no store each cost a sentence.
  
  `pithy doctor` names a `.dev.vars.<env>` still in the project, with its environment, and a Cloudflare
  credential still in the root `.dev.vars`, with the file it belongs in. Reported, never moved.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A co-located route test is a test, not a route.
  
  `src/router.tsx` says its two globs ARE the route registration and must not be edited. They matched `**/*.tsx`, which matches `**/*.test.tsx` — so `home.test.tsx` beside `home.tsx`, the file every other convention in the kit tells an adopter to write, was registered as a route and bundled. Measured in `pithy-sh/dashboard`: a 283 kB Vitest chunk in `dist/client/`, loaded on every page. The suite was green, because running a test was never the problem. A test file carries fixtures, stub tokens, hardcoded ids and comments about how an endpoint fails, and all of it was being served to anyone who asked.
  
  Both globs now take an array and negate `*.test.tsx` and `*.spec.tsx` — the test runner's own names for its own files. Refusing a module with no `path` export would have stopped it *registering* and shipped it anyway; by the time that check runs the glob has already pulled the module into the graph, so the fix is the glob. `router.tsx` stays byte-identical in every template.
  
  The other half was quieter. The starter's node test project collected `apps/*/src/**/*.test.ts`, and a scaffolded front end is `.tsx` to the last file — so the same test ran nowhere, and `passWithNoTests` made that green. It collects `*.test.{ts,tsx}` now, with the Workers-runtime exclude widened beside it.
  
  Two gates, both proven against a planted file. `@pithy-sh/ui-react` runs a real `vite build` over the real `router.tsx` with a test planted beside a screen, and fails if any emitted asset mentions it. `@pithy-sh/cli` holds the starter's include against every extension the UI stub writes, rather than against a literal.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy dashboard connect` grants every read the Worker declares, so connecting produces a working surface.
  
  `connect` granted `SEAM_SCOPES` and nothing else. Every pane that reads a customer's data needs a scope that default did not include, so a freshly connected project opened to six panes each saying the credential does not cover this call. `pithy-sh/dashboard`'s own self-connection held `manifest:read` and `keys:rotate`, read `blocked` off the manifest, and never made a single call. Adding the reads by hand made the whole surface work with no other change.
  
  The default is now derived from the Worker being registered: each capability already declares its admin routes with the scope each one needs — the same declaration `GET /control-plane/manifest` reports — and the CLI already resolves the composed set to find the seam's mount point. So a capability that lands a read route is offered on the next `connect` with no list here to keep in step, and no capability the project does not compose is ever mentioned.
  
  **A read is a route, not a name.** A scope joins the default only when every declared route requiring it is a `GET`. `scopeCovers` matches exactly, with no prefix or wildcard rule, so holding a scope confers every route that requires it — one mutating route anywhere makes the whole scope a write however it is spelled. `keys:rotate` is exactly that shape: a key listing and two key writes behind one scope. It stays in the default, because it always was and because dropping it would break `pithy dashboard rotate` on every new connection. Nothing the derivation adds can write, and a test asserts that over the composed seam and a hostile synthetic surface rather than over a list of scope names.
  
  The interactive prompt is read off the same declaration. It used to offer two hardcoded scopes, neither of which reads any of the adopter's data; it now lists every operation their Worker exposes, in each capability's own words, preselected to the default — because narrowing is the point of showing the list at all.
  
  `--scope` still narrows to exactly what is passed, an explicitly empty selection is still empty rather than the default, an update with no `--scope` still leaves the grant alone, and enforcement is unchanged: the adopter's row is the authority, and a narrowed grant refuses every call it left out.

- [#254](https://github.com/pithy-sh/pithy/pull/254) [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729) Thanks [@kingmesal](https://github.com/kingmesal)! - A config Pithy writes is a config Biome would print.
  
  `pithy ui sync --worker board` in `pithy-sh/dashboard` did its job — it found the missing `/control-plane` in `run_worker_first` and corrected it — and then failed `biome check` in the pre-commit hook the CLI itself scaffolds, over four hunks of `"compatibility_flags": [\n "nodejs_compat"\n]` where Biome wants one line. The same run turned a two-line change into 78 insertions, which leaves the real edit somewhere inside a reformat nobody can review.
  
  Every JSONC document the CLI writes now goes through one printer, `project/jsonc.ts`, holding two rules that together are Biome's `expand: "auto"` for JSON. **An array is one line when it fits and one element per line when it does not** — the width decides, so there is nothing to preserve. **An object keeps the shape it already had**, read from the bytes about to be replaced, because both shapes pass Biome and only one of them leaves the diff alone. A span holding a comment is never collapsed. `pithy ui add` went from a 15-line `wrangler.jsonc` diff to a 3-line one, and a `sync` that adds one path is now a one-line diff with the adopter's own expansions and notes untouched.
  
  The starter's `biome.jsonc` stops exempting `wrangler.jsonc` and `pithy.worker.jsonc` from the formatter. Exempting the two files Pithy touches most was the workaround, not the fix, and it left every adopter with two files nothing formats.
  
  The gate runs the adopter's toolchain rather than a literal: the scaffolded Biome config, over the scaffolded `wrangler.jsonc` and `pithy.worker.jsonc`, after the real wiring functions have edited them. It failed on all four counts before the printer landed.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - Pithy's screens carry their own stylesheet, so a backfill renders styled
  
  `pithy ui add react --auth` on a project scaffolded `--no-auth` wrote `routes/pithy/sign-in.tsx` and
  reported it as `created`. The screen rendered `stack`, `divider` and `secondary` — classes defined only in
  `src/styles.css`, the file the same run correctly skipped because it is the adopter's. The first sight of
  the feature they had just enabled was an unstyled login page, on a product whose pitch is that the design
  is the product.
  
  Skipping the stylesheet is right. Keeping the rules in it was not: a screen and the rules it needs are one
  artifact, and ownership had split them.
  
  So the templates now ship **`src/pithy-screens.css`**, holding every class name a Pithy screen renders, and
  the screens import it themselves. It is written whenever it is absent, so the run that writes a screen
  writes its rules; `src/styles.css` stays the adopter's and is never touched.
  
  Two properties keep it safe to live beside a design someone else owns. Everything sits in a `@layer pithy`
  cascade layer, and unlayered CSS beats layered CSS regardless of order or specificity — so any rule an
  adopter writes wins with no `!important` and no regard for import order. And the palette is six tokens read
  with fallbacks (`--bg`, `--surface`, `--fg`, `--fg-muted`, `--border`, `--accent`): declare them and the
  screens adopt your colors, declare none and they stand up on their own, following `prefers-color-scheme`.
  
  Two gates keep it true, because the drift that produced this runs in both directions. A test extracts every
  `className` the screens render and every selector the stylesheets define and requires the first to be a
  subset of the second — a screen gaining a class nothing defines now fails CI. And `pithy ui add` checks the
  result rather than assuming it: after writing, it reads the stylesheets actually on disk and reports any
  class the screens render that none of them defines, as `unstyled` under `--json`. Wrote the screens and the
  screens are styled are two claims, and only the first was ever made.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - The asset allowlist is derived from every environment's route table, not one
  
  `pithy dev` printed a sign-in URL that landed on the front end's 404. `/__pithy/dev-login` was not in
  `assets.run_worker_first`, so Cloudflare's asset router answered it with the SPA shell and the Worker never
  ran. `pithy ui sync --check` reported `every route reaches the worker` the whole time.
  
  Both halves were doing their job. `@pithy-sh/auth` mounts that route only in a `dev` composition with `CI`
  unset, because it mints an authenticated session with no credential presented — its absence from a shipped
  route table is the security property. And `pithy ui sync` derived the allowlist by composing the Worker once,
  under whatever environment the command happened to run in. That is not a `dev` composition, so the route did
  not exist to be found.
  
  **A Worker has one route table per environment.** The derivation now assembles it once per environment the
  project declares plus `dev`, and takes the union. Any conditionally-mounted route is covered without being
  named — gated on the environment, on a flag, on a capability being composed — so this closes the class rather
  than the one path. Reserving the `/__pithy` prefix wholesale would have fixed the symptom and left
  `--check`'s claim just as false for the next one.
  
  `CI` is deliberately ignored while deriving. `--check` runs in CI and `sync` runs on a laptop; a list that
  differed between them could never be checked. The asymmetry makes it free — an allowlist entry nothing serves
  costs a 404 from the Worker, a missing one costs a 200 with the wrong body.
  
  Production is unchanged: the route is still mounted only in `dev`, and still 404s everywhere else.
  
  Run `pithy ui sync` once. It adds `/__pithy` and `/__pithy/*`, and `--check` fails until you do. A project
  that added those entries by hand can drop the hand edit — the derivation writes them now.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - `originFor(environment, domains)` — one answer to "where is this Worker reachable", so no capability asks an adopter to write an origin down.
  
  Every capability that needs a public origin made the adopter type one, so a project with more than one environment wrote production's origin into staging's config. The first adopter's single Worker carried `https://app.pithy.sh` three times, in three capabilities, each wrong for staging in its own way: `auth.baseURL` mailed testers magic links **into production** and let the CSRF gate allow prod while refusing staging's own forms; `email.baseUrl` meant an unsubscribe from a staging test would have unsubscribed that person **in production**; the `payments` Stripe return URLs landed a staging payer **in production**, on an account that had bought nothing. Three capabilities, one mistake, three separate discoveries — because fixing it inside one capability does not stop the next capability asking the same question.
  
  The two halves already existed and nothing composed them. `domainFor` and `baseUrlFor` are now composed once, in `@pithy-sh/core/src/naming/domains`:
  
  ```ts
  const domains = { staging: { … }, prod: { … } };
  const PUBLIC_ORIGIN = originFor(compositionEnvironment() ?? "dev", domains);
  ```
  
  Named for the Worker rather than for whichever capability asked first. The adopter's own version was called `AUTH_BASE_URL`, which is part of why `email` and `payments` kept their literals for days — the constant read as auth's private business when it is the Worker's address.
  
  **The fallback is the load-bearing part.** An environment absent from `domains` is one that is not published, so it resolves to `http://localhost` and to nothing else. That fails closed: a link that goes nowhere, useless rather than harmful. What it replaces fell back to production's origin, which is the only version of this that was actively dangerous. And a *deployed* environment can never keep that fallback, because `pithy deploy` refuses an environment whose config declares no origin — one rule in two halves rather than two rules that happen to agree.
  
  `applyDomains` and `workerAddress` are routed through it, so `vars.BASE_URL` and the origins a Worker's capabilities were configured with are the same function's answer and cannot drift apart.
  
  **`controlplane.issuer` deliberately does not derive**, and the docs say why. It is an identity, not an address: a connection stores the issuer it was created with and verification checks that stored value, so a per-environment issuer would make a connection minted in staging unverifiable in production. That may be the better isolation, but it is a decision about trust rather than about reachability, and a helper whose job is "where am I reachable" must not sweep it up.

- [#275](https://github.com/pithy-sh/pithy/pull/275) [`152c97b`](https://github.com/pithy-sh/pithy/commit/152c97b1f93475416cb80a1e0da5c9a0014e16a7) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add auth` left a project that could not boot.
  
  `auth` composes against `secrets` and `email` — it reads provider credentials and a session secret through one, and sends magic links and OTPs through the other — and `createBackend` has always refused to assemble without them: `Capability "auth" requires the "secrets" capability, which is not composed.` `pithy add` registered neither. So the command reported `Done.`, `pithy doctor` reported a healthy project, and `pithy dev` failed to start. The first five minutes ended on a stack trace from a command that had said it was finished.
  
  **A capability declares what it composes against, and `pithy add` acts on the declaration.** `peerCapabilities` was already in every `pithy.manifest.json`; nothing read it. Not a special case for auth: `payments`, `support`, `storage`, `media` and `turnstile` all declare `secrets`, `testers` declares `email`, and hand-listing them at the command is how the next one gets missed.
  
  They resolve as a **graph**, deepest first — `secrets`, then `email`, then `auth` — because `email` reads a secret at boot, and a plan that echoed the manifest's array would compose them in whatever order it was written in. Each prerequisite is a real `pithy add`: its package, its bindings in every environment stanza, its dev secrets, its own audit event. Their notes come back ahead of the capability's own, so the dev master key `pithy add secrets` mints is still printed exactly once.
  
  **Add, or refuse?** Both, decided by what the run can be asked. A terminal is asked once for the whole cascade. `--with-prerequisites` composes them without asking. Anything else — `--json`, no TTY, an agent — is refused, exit 1, naming the exact commands in the order they must run, with nothing written. Composing something nobody asked for is not a thing to do behind an adopter's back; reporting success on a project that cannot boot is worse.
  
  **`pithy doctor` reports it and fails the exit.** A new `prereqs` line, first in each Worker's block, because it is the only check there that is not drift: a Worker failing it does not start, so every line under it describes a Worker that is down.
  
  **And `pithy add` now applies the migrations it says it runs.** Found while proving the above end to end. `add` re-reads the Worker config it has just written to build the migration registry, and the module cache returned the module from *before* the write — Bun keys it on the resolved path, and neither a query string nor a differently-spelled path busts it. So every `pithy add` reported a clean run and applied nothing, and the Worker that finally booted answered 500 on every route that touched a table. The post-write read now goes through a uniquely-named copy beside the original.
  
  The five-minute path — `pithy init`, `pithy add auth --with-prerequisites`, `pithy dev`, sign in — works end to end, and is covered by tests that spawn the real binary.

- [#277](https://github.com/pithy-sh/pithy/pull/277) [`656ef39`](https://github.com/pithy-sh/pithy/commit/656ef39ec81bcba09197ed02c0186f44b09fe502) Thanks [@kingmesal](https://github.com/kingmesal)! - A capability's schema is one migration, not a chain.
  
  Nothing here has been published — every package is `0.0.0`, `npm view @pithy-sh/core version` is a 404, and the one adopter recreates its dev database in two minutes. A chain buys exactly one thing: walking a database that already holds rows from an old shape to a new one. There is no such database, so the three `0002`s were steps from a shape that never ran to a shape that never shipped, each carrying a second `down` and a second test suite for a history nobody will replay.
  
  `audit`, `media` and `payments` now each carry their whole schema in one migration. The resulting schema is byte-identical to what the chain produced — `CREATE TABLE` text, column ordinals, every index and its column order, read back out of a real D1 before and after. Every assertion the deleted tests made is made against the merged migration, including the tenant column reading back as `null` when nobody states one, and each `down` is tested against a populated database rather than an empty one.
  
  `media`'s migration is parameterized rather than chained: it creates the dedup hash table in both record-store modes and the record table only for `recordStore: 'd1'`, which is what the second migration used to select. Its adopter extension columns are now `0002_extend`, matching what they were always documented as.
  
  `packages/cli/src/migrations/oneMigration.test.ts` states the rule as an invariant — every authored migration numbered `0001`, and no more migrations than a package declares databases — so `@pithy-sh/email`'s legitimate pair of `0001`s passes structurally rather than as a named exception. It skips any package that has been released, and goes quiet on its own the day the first version is cut. `CONTRIBUTING.md` §Migrations says why the rule is safe today and what replaces it after that.
  
  A dev database migrated before this lands has the old keys in its ledger. Recreate it, or `pithy migrate --rollback` first.

- [#286](https://github.com/pithy-sh/pithy/pull/286) [`d597eb3`](https://github.com/pithy-sh/pithy/commit/d597eb3c6f07c8bb47f5c00c19f7402f8327a46d) Thanks [@kingmesal](https://github.com/kingmesal)! - Semver and address normalization are primitives now, and the kit uses them.
  
  The kit exported neither, so the first adopter wrote both. Taken up before publication, when it costs one commit rather than a deprecation.
  
  `@pithy-sh/core/src/semver/semver` is semver §11.4, once: `parseSemver`, `formatSemver`, `compareSemver`, `semverGap`. The four rules that decide a release feed's order are each one line to get wrong quietly — numeric identifiers compare numerically and alphanumerics lexically, a numeric identifier ranks *below* an alphanumeric one, a longer identifier set wins when every shared one is equal, and a stable outranks every prerelease of the same core. Numeric identifiers are compared as digit strings, not through `Number`, because above 2^53 two distinct identifiers round to the same float and `latest` becomes whatever order the rows arrived in.
  
  The CLI's update notifier uses it and stays narrow: `parseVersion` still drops the prerelease, so nobody on the stable channel is nagged about an `rc.1`. Its tests pass unmodified. It now refuses a handful of strings it used to coerce — `1.2.` was `1.2.0` and `01.2.3` was `1.2.3` — none of which a registry ever returns.
  
  `@pithy-sh/core/src/address/address` is the one rule for whether two strings are the same person. It trims and lowercases both halves, and it deliberately does **not** collapse subaddressing or dots, unicode-normalize, convert IDN, or validate — the boundary is written down in `docs/CONVENTIONS.md`, because a normalizer that quietly merges two people is worse than none. `parseAddress` sits beside it for mail headers: unwrap `Ada Lovelace <ada@example.com>`, bound it, refuse anything that is not one address, return it normalized.
  
  Five capabilities compared addresses with five copies of `trim().toLowerCase()`, and a disagreement between them presents as "the suppression list did not work" rather than as anything about addresses. `auth`, `email`, `support`, `testers` and `matchmaking` now route through the primitive. `support`'s `normalizeAddress` and `email`'s `normalizeEmail` are gone; use core's `parseAddress` and `normalizeAddress`.

- [#295](https://github.com/pithy-sh/pithy/pull/295) [`d282ee9`](https://github.com/pithy-sh/pithy/commit/d282ee9088595979b7d830908ac0799ec6a148de) Thanks [@kingmesal](https://github.com/kingmesal)! - The scaffolded SPA router matches path parameters.
  
  `export const path = "/invitations/:token"` now routes, and the value arrives as a typed `params` prop: `ScreenProps<typeof path>` reads the names off the pattern, so `params.tokne` is a compile error and there is no second place to keep the names in step. Identifier-in-path is the ordinary shape for anything arriving by link — an invitation, a password reset, a shared record, an unsubscribe confirmation — and until now every adopter needing one either used a query string or forked a file the kit keeps changing underneath them. `pithy-sh/dashboard` shipped `/invitations?t=<token>`.
  
  Four rules, each decided rather than emergent. A static segment beats a dynamic one at the leftmost segment where two patterns differ in kind, by comparing patterns rather than by whichever glob reached a file first — the previous table was a `Map` keyed on the literal path, so there was no order to get wrong, and adding one silently would have been the wrong way to answer it. Values are decoded once, in the router, after the split, so `%2F` is a slash inside a value; a malformed encoding does not match at all, rather than reaching a screen as raw text or as an empty string. A parameter captures at least one character, so `/invitations/` is not a token. And a pattern matches a path with the same segment count: no wildcards, no optional segments, no nesting.
  
  `routes/pithy/otp.tsx` keeps its `?email=`, and now says why: that URL points at the code-entry screen, the address is a prefill rather than the resource, `/otp` with no email is a valid screen, and an address in a path is PII in every access log along the way.

- [#299](https://github.com/pithy-sh/pithy/pull/299) [`a75a932`](https://github.com/pithy-sh/pithy/commit/a75a932b642026ed146f24bf63914ce6f0d8943f) Thanks [@kingmesal](https://github.com/kingmesal)! - A connection's lifecycle is recorded in the adopter's own trail.
  
  `ControlPlaneAuditActions` declared `connectionRegistered`, `connectionUpdated` and `connectionRemoved` from the day the seam shipped, and nothing emitted any of them. Not an oversight in a handler: those are the writes `pithy dashboard` performs by opening the adopter's D1 directly, so no request reaches their Worker and no route is in a position to record one. An adopter could read a *key* rotation in their trail but not the connection being created or destroyed — the larger event was the invisible one.
  
  The write records itself instead, in `connectionRegistry` rather than at its call sites. That module is already the CLI's only door onto the connections table, so "every CLI write to an adopter's connection row is recorded" now holds by construction. `connect` registers, `connect --update`, `connect --public-key` recovery and `revoke-key` update, `disconnect` removes.
  
  Three things this settles. **Where**: the event goes to a recorder built over the same `DB` handle the row was written through, never a database id resolved a second time — on `dev` those are not the same store. **When**: the row lands first and the event follows; a refused write records nothing, and a failed record cannot unwind a write and does not try. **Who**: not `control-plane`, which means a management client called in and proved it, but the adopter's own operator — named from their Cloudflare token where the command has one, `system` with a note where it does not, `worker` and `version` null because no Worker recorded it.
  
  `createCliAudit` gains an injected-database form for this. With a handle passed in, the Cloudflare pair becomes optional and names the actor rather than finding the database; a union type keeps that from loosening the ordinary case. A project not composing `audit` connects exactly as before.
  
  **A declared action code that nothing emits now fails the build.** `packages/cli/src/ci/auditActions.test.ts` compares every declared audit-action map against its use sites across the tree. It found one more on its first run — `PaymentsAuditActions.webhookUnverified`, so a notification failing its authenticity check throws 401 and records nothing — which is filed as [#296](https://github.com/pithy-sh/pithy/issues/296) and written down as the single exception there.

- [`704f8fa`](https://github.com/pithy-sh/pithy/commit/704f8faf6e94aafe115df7d74ac34b1f868b211f) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy upgrade` counted bindings it had not written, and `pithy doctor` was right to disagree.
  
  Run in sequence, seconds apart, against one tree: `upgrade` said `payments: added 3 bindings` and `git diff apps/board/wrangler.jsonc` showed none of them. `doctor` still reported `PAYMENTS_RECONCILE (workflow) missing from wrangler.jsonc`. Two commands of one CLI disagreeing about a file one of them had just edited, with the failing direction the dangerous one: `upgrade` says done, so a reasonable person deploys a Worker whose reconciliation Workflow has no binding, and finds out at runtime.
  
  Two causes, both fixed at the thing rather than the call site.
  
  **Six capabilities derived their Workflow bindings with `Object.values`, and the job is the map key.** `payments`, `storage`, `support`, `vector`, `testers` and `media` each carried the same four lines, and `createBackend` carried them a seventh time. Dropping `job` and `className` is not cosmetic: the CLI composes a `workflows` entry's deployed name from the job and its `class_name` from the class, refuses to write a partial one because wrangler rejects it, and had no way to say so. `workflowBindings` in `@pithy-sh/core/src/workflow/bindings` is now the one derivation, `Object.entries` where it belongs, and every producer routes through it.
  
  **And the report came from the plan.** `applyBindings` recorded what it *intended* the moment it touched a capability. `appendBinding` now returns what happened — written, present, unsupported, or skipped with a reason — and `upgrade` reports off that. A binding it could not write gets a line of its own, named:
  
  ```
  payments: PAYMENTS_RECONCILE (workflow) not written for dev — PAYMENTS_RECONCILE declares no job.
  ```
  
  The gate that should have caught this was green and structurally unable to fail: it checked workflow bindings for `job` and `className` over `requiredBindings.filter((b) => !b.optional)`, and every affected binding was optional. `optional` answers whether the app may boot without the binding. It says nothing about whether the entry is derivable offline, which is the question that gate asks. It now asks it of every workflow binding, and a sweep over the shipped manifests holds `upgrade`'s report to the file it wrote and to the plan `doctor` reads afterwards.

- [`f103aa5`](https://github.com/pithy-sh/pithy/commit/f103aa55878ad1a191100a2be8dc1683644ff2db) Thanks [@kingmesal](https://github.com/kingmesal)! - Bare `pithy` printed the help and then called it an error.
  
  ```
  $ bun run pithy
  A backend kit for Cloudflare Workers. (pithy v0.0.0)
  
  USAGE pithy init|add|remove|worker|…
  
  No command specified.
  error: script "pithy" exited with code 1
  ```
  
  It answered correctly and then told the user they had done something wrong, twice. Somebody typing `pithy` with no arguments is asking what it does; the command list is the answer, and it is the most common thing anyone types on their first day. Exit 1 breaks `pithy && next`, fails a bare invocation in a CI step, and — under `bun run` — hands the last word to a line that names a script rather than anything the user did.
  
  The rule now, stated once: **a command that names no action is asking what it can do, and being answered is a success.** Bare `pithy` prints the help and exits 0. So does a group with no subcommand — `pithy secrets`, `pithy worker`, all thirteen — because it is the same question one level down. Nothing is printed after the help.
  
  A name that is not a command is a different thing and is unchanged: `pithy nonsense` names what was not recognized, shows the help, and exits non-zero.
  
  Fourteen commands took the failing path, so the rule is not written fourteen times. `dispatch.ts` answers before citty parses, because citty cannot be told otherwise — `runCommand` throws `E_NO_COMMAND` for the root and for every group, and `runMain` catches every `CLIError` into usage, the message, and `process.exit(1)`. Adding a `run` to each group would also have been subtly wrong: citty runs a parent's `run` after dispatching to a subcommand, so each would have needed to know whether it had been dispatched through. A group added next year inherits the rule with nothing to remember, and the gate checks it over every group the root declares rather than over the two the report happened to name.

- [`a56209d`](https://github.com/pithy-sh/pithy/commit/a56209d73d0756f497edc20cd21c44007bf1719c) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy env` reported a working local environment as three-quarters unprovisioned.
  
  ```
  dev  local
    worker  dash-board
    SECRETS (d1)  not provisioned
    DB (d1)  not provisioned
    EMAIL_SUPPRESSIONS (d1)  not provisioned
  ```
  
  That environment was running, migrated and seeded. The fact was right — there is no remote `dash-dev-db` — and the presentation was wrong, because a local environment is not supposed to have one. Miniflare serves D1 from the binding declaration, with state under `.wrangler/state/v3/d1`, and `pithy dev` works precisely because no Cloudflare resource is involved. The command printed `dev  local` one line above and then evaluated that environment against a remote standard it had just said did not apply.
  
  The cost is not cosmetic. `pithy env` is the inventory read before provisioning and after; if a third of it is always red for an environment that is fine, the reflex becomes to skim past red, and that is the reflex you least want when reading it against production.
  
  **A check that cannot fail meaningfully for an environment is not run against it.** A binding with no id now reads `local` in a local environment and `not provisioned` only in a deployed one — deliberately different words, because sharing them is what made the real action item weaker. A local environment that *does* name a real id still shows it: pointing dev at a remote database is a thing an adopter may do, and the id is the true and useful thing to print.
  
  **Localness is a property of the report, not a guess about the name.** `environments[].local` is set where it is known for a structural reason — the top-level wrangler stanza *is* the local environment, which is why `DeclaredEnvironments` refuses to let a project declare `dev` — and `--json` carries it. Keying a fix off the string `dev` at the render layer would have re-encoded the same guess one layer down, and every consumer would have had to make it again.
  
  The disagreement with `pithy doctor` was entirely on this side: `doctor` reported the same tree healthy because it never evaluates provisioning at all — its `bindings` check is about whether a Worker *declares* what a capability requires. There was nothing to relax there, and a standard to stop applying here.

- [`08c317c`](https://github.com/pithy-sh/pithy/commit/08c317cd8b897be5e744c7d3483f4126f67b3b8a) Thanks [@kingmesal](https://github.com/kingmesal)! - Provisioning stopped to ask a human to generate random bytes.
  
  `pithy provision --env staging --yes` created three databases and then printed three `pithy secrets create` commands. `--yes` had been passed. Each of those commands generates a random string; there is no decision in one.
  
  The declaration was already there. A registry entry's `devValue` says whether a value is *arbitrary* — nothing outside the project has to agree with it — and that is a fact about the value, not about the environment. A session signing key is arbitrary in production for exactly the reason it is arbitrary on a laptop. Only local dev ever read the field.
  
  Every environment reads it now. `pithy provision --env`, `pithy provision --feature` and `pithy secrets provision` create each declared-mintable `cf-secrets-store` secret and bind it in the same pass. `pithy feature` therefore stands up an environment with no follow-up commands, which is what it always said it did.
  
  The limits are as deliberate as the change. Absence is checked first, always — an existing value is never replaced, because replacing a key-encryption key orphans everything sealed under it, and that is rotation rather than provisioning. A secret with no declaration stays a question for the human who can answer it: a generated value there authenticates against nothing and hides a real gap behind one that looks filled in. Nothing minted is printed, logged, or put in an audit event; the trail records that a secret was created and which entry it went to. Only the Secrets Store backend, because it answers *does this exist* authoritatively, and "never regenerate" has to be checkable.
  
  Ask `isMintableSecret` rather than reading `devValue`, so the day that field is renamed there is one site to correct.

- [`0f912a2`](https://github.com/pithy-sh/pithy/commit/0f912a2677ea731d16659cf6d3f5e98b11d3c53f) Thanks [@kingmesal](https://github.com/kingmesal)! - A malformed secret was reported as absent, and the suggested remedy did nothing.
  
  `No SECRETS_ENCRYPTION_KEYS recorded. Run pithy add secrets.` said "absent" about a key that was there and failed its schema — and the command it named then returned without doing anything, because a key was already present. Three states collapsed into that one sentence: no project name, an unreadable file, and a stated value that will not read. Two investigations died in the third one, and one of them produced a work plan built on a refuted premise.
  
  **The reader no longer swallows what it read.** `statedMasterKey` answers with the value, with nothing, or with the sentence saying why — a type with a slot for each, instead of `string | undefined` and a bare `catch {}`. Nothing new is written: `requireProjectName`, `readDevSecretsSource`, `loadDevSecrets` and `storedSecretValue` each already named the secret, the file and the fix, and the defect was a `catch` throwing four good messages away. "Not recorded" is a claim about the file, and it is now made only when the file makes no claim.
  
  **`pithy doctor` judges what a stated value is, not that it is there.** `Object.hasOwn` was the entire check, so a value violating its own registry schema passed doctor and failed the next seed — the one command whose job that is. It is checked through the seeder's own `storedSecretValue`, so the two cannot come to two answers, reported apart from `missing`, and counted a fault. A file that will not parse now carries the loader's sentence rather than "run pithy seed to see which secret and why", which spent a round trip re-deriving what the run already knew.
  
  **The envelope parser rejects a non-envelope instead of stripping it into one.** `DevSecretEnvelope` accepted any object carrying `currentVersion` and `versions` and dropped the rest — so an `EncryptionConfig`, a structural superset of an envelope, parsed as one, lost `lastRotatedAt`, and left a base64 string where a nested object belongs. The failure then surfaced three frames later talking about version `"1"`. It is strict now, and the error says what was found: which keys, or which type. Keys and types only — the file holds OAuth client secrets.
  
  `sentenceOf` in `@pithy-sh/core` is where the two reporters get their one sentence from — a caught error's message and its `action`, never its `detail`. Both of them had grown a copy of it, and a three-line helper in two files is a helper that drifts.
  
  The format's guarantee is unchanged and is the reason for all three: the outer object is always the envelope. `SECRETS_ENCRYPTION_KEYS` carries a full envelope in the file like every other secret, and its binding carries the bare `EncryptionConfig`. That is `bootstrap`, it is correct, and nothing here alters it.

- [`973d79f`](https://github.com/pithy-sh/pithy/commit/973d79ffbd0f79ff63a2055fd41d44c4529f0a6d) Thanks [@kingmesal](https://github.com/kingmesal)! - The minter that could never fire, and the two contracts it broke on the way.
  
  **It had no input.** [#321](https://github.com/pithy-sh/pithy/issues/321) gated minting on two predicates at once: the secret gets a `secrets_store_secrets` binding, so `backend === "cf-secrets-store"`; and its value is arbitrary, so `devValue` is declared. The intersection is empty across everything the kit ships. Both store-backed secrets are ones no random string can satisfy — `SECRETS_ENCRYPTION_KEYS` is an `EncryptionConfig` the master-key provisioner writes, `CLOUDFLARE_API_TOKEN` is issued by Cloudflare — and both secrets that declare an arbitrary value are `d1`: the auth session secret and the email link-signing key. So provisioning went on printing `pithy secrets create` for exactly the two secrets the change was filed about, and its tests passed because each of them built a registry out of literals rather than reading one the kit ships.
  
  Minting now covers `d1` too, and the reason it was excluded is answered rather than overruled. The exclusion was about authority: the Secrets Store answers *does this exist*, which is what makes never-regenerate checkable, and the CLI cannot ask the same of a `d1` secret because its value is sealed under a master key that never leaves the manager Worker. So the question moves to whoever can answer it. `runWriteSecret` gains an `ensure` mode — write only when the name is absent — and the manager makes that decision one store read away from the write it is atomic with. That is a stronger guarantee than a caller-side read followed by a write, which is a race. It is deliberately not the `create`-then-`update` upsert the storage, turnstile and media provisioners use: that is right for a credential just obtained from a third party, and exactly wrong for a minted one, because it would replace a live key on every run. A `global` secret is minted once and fanned out unchanged; an `environment` secret is minted afresh for each, so a staging session key never signs a prod session.
  
  **A gate that reads the registries the kit actually ships.** `mintCoverage.test.ts` runs every creator the CLI has over auth's, email's, the secrets capability's and the manager's own registries, and fails naming any secret the kit calls arbitrary that nothing can produce. A test that builds its own registry cannot see this, which is how it was missed.
  
  **The minter ignored `bootstrap`.** It wrote an encoded `{ currentVersion, versions }` envelope unconditionally. A bootstrap secret's binding carries its current value verbatim — it is what the envelope decoder needs in order to exist, so it cannot arrive in a form whose reading depends on it — and `defineSecretRegistry` admits exactly the entry that reaches this: bootstrap must be `cf-secrets-store`, which is the only backend the minter handles. A Worker bound to such an entry fails at its first read with the binding plainly present. `bindingValue()` already owned that rule for `.dev.vars`; it now lives in `@pithy-sh/secrets/src/bindingValue` rather than under `dev/`, because it was never a dev rule, and the minter calls it instead of restating it. A rule restated at a second site is a rule that will diverge.
  
  **`mintDevValue` said it was never for production, and had been for four releases.** [#321](https://github.com/pithy-sh/pithy/issues/321) made it the sole producer of key material written into a real account's Secrets Store and into a deployed environment's secrets D1. The function is now `mintSecretValue`, in `mintValue.ts`, and says what it is for; the requirement that it draw from `crypto.getRandomValues` is stated where it governs production keys rather than where it governed a laptop. What limits it is the declaration, not the environment — an entry carries a mintable value only when nothing outside the project validates one, which is as true in prod as on a laptop.

- [`fe8fcde`](https://github.com/pithy-sh/pithy/commit/fe8fcde772575edf45b5d1afe78e1ce16d839675) Thanks [@kingmesal](https://github.com/kingmesal)! - Refuse a split global secret with a remedy that exists, and report what a half-finished fan-out wrote.
  
  `mintDeclaredSecrets` finds a `global` secret in some environments and not others, and refuses rather than completing the split with a second value. That lockstep was right. Two things around it were not.
  
  The refusal offered a repair no command can perform. It read *"give the others the same value with `pithy secrets create`"*, and for the secrets this creates nobody can: they are `d1`, 256 bits of `crypto.getRandomValues`, sealed under a master key that never leaves the manager Worker. There is no way to read the value back out of the environment that holds it, so an operator reaching for the first branch found no first step. It now names the one remedy that works — remove the secret everywhere with `pithy secrets rm`, then run again — and says plainly what that costs: a live signing key destroyed, and everything signed by it stops verifying.
  
  The report was assembled after the delivery loop, so any throw inside it took the whole record with it. A fan-out that wrote staging and then lost prod left staging holding a brand-new signing key and told the operator nothing was created. The entry now enters the report on the first write that lands and grows one environment at a time, and whatever a run wrote rides out on the error that ended it — carried, never replacing it, so the failure an operator has to read is unchanged. `pithy secrets provision` prints what landed before the failure, in both the human output and `--json`, and still exits 1.
  
  Fixes [#324](https://github.com/pithy-sh/pithy/issues/324).

- [`67a367b`](https://github.com/pithy-sh/pithy/commit/67a367bb1a52e9120b86f4947e9e4c43451d54e8) Thanks [@kingmesal](https://github.com/kingmesal)! - Three faults the doctor and the store found and did not say.
  
  **`--json` carries every fault the human report prints.** `devSecrets.unreadable` became the loader's sentence rather than a boolean, and the projection passed it through unchanged — so a CI script gating on `unreadable === true` stopped firing and read a broken secrets file as healthy. Silently, because a non-empty string is not `false`, it is merely not `true`. `malformed` and `bootstrapMissing` were not in the payload at all, and `malformed` is the one that flips the verdict. All three are there now, beside a `healthy` boolean computed from the same function the text report draws its fault line from. A consumer gates on one field, and the next fault class added needs no consumer to be updated.
  
  **A file that states a master key which will not read ends the open, whatever an older home holds.** The file's sentence was read only when no key was found anywhere, so a project with a malformed `SECRETS_ENCRYPTION_KEYS` in `secrets.jsonc` and a valid one in an older `.dev.vars` opened under the older key without a word. That is not a lost message: this file is what every Worker's `.dev.vars` is generated from, so the next seed encrypted rows under a key the running Worker is never handed, and the only symptom was a decrypt failure three commands later. "The file will not answer" and "there is no file to ask" are two fields now, and only the first is authoritative — a project with no name has stated nothing, so its older homes are still read.
  
  **A keyspace given a single value is a fault, and doctor says so.** `pithy seed` throws `Secret '<name>' … is a keyspace, not a single value.` on exactly that input; `pithy doctor` skipped every keyed entry before the file was consulted, so the one file the seeder hard-fails on was a file doctor called green. The refusal is one function now, thrown by the seeder and quoted by doctor, so the two cannot come to two wordings of one rule.
  
  The promise that a green report means the next `pithy seed` works is asserted as that implication now, over a corpus of files, rather than one case per fault somebody thought of. A promise checked case by case is only ever as true as the list — which is how a keyspace stayed off it.

- [`b0275f0`](https://github.com/pithy-sh/pithy/commit/b0275f0fef37a3c6434df108958c1e2a2bc9ee1e) Thanks [@kingmesal](https://github.com/kingmesal)! - A global secret cannot be narrowed to one environment, and a fan-out that dies says what it wrote.
  
  `pithy secrets update <global> --env staging` used to widen silently: `--env` was resolved to the
  canonical environment before anything could refuse it, and the write went to every environment
  including prod. It is refused now, before dispatch, with nothing sent — the re-run without `--env` is
  the confirmation, and no flag skips it. `rm` gets the same answer, where it matters more.
  
  The rule has one owner. `secretWriteTargets` decides where a write may land; `resolveWriteTargets`
  stays the routing table underneath it and holds no policy. `dispatchSecretWrite` and
  `mintDeclaredSecrets` both ask the rule, and a gate over the source fails the build on any shipped
  module that reaches the table directly — the state this found, where each caller held a
  cross-environment invariant on its own.
  
  Complete-or-revert is not offered, because it does not exist: each environment is a separate Workflow
  in a separate Worker, and a compensating write is itself a Workflow that can fail. So the fan-out
  reports instead. `dispatchSecretWrite` grew the environments it wrote one at a time and lost all of
  them to a throw; they now ride out on the error, reach the failure audit, and are printed before the
  error with `"interrupted": true` under `--json`. The mechanism is `partialWriteReport`, shared with the
  minting path rather than copied from it.

- [`2d014a2`](https://github.com/pithy-sh/pithy/commit/2d014a29940281261a79deaba2d24a61339e3d80) Thanks [@kingmesal](https://github.com/kingmesal)! - Nine gates were green and could not fail. Each is now planted against and watched failing.
  
  They are one class, not nine bugs. A census of every test claiming a repo-wide or capability-wide invariant found eight shapes, and the two most common are the same mistake at different altitudes: a check derived from its own subject, and a set under test computed by calling the function under test. The taxonomy is written down in `packages/cli/src/ci/sweepPopulation.test.ts`, where the next gate author will meet it.
  
  **auth and support declare admin routes and asserted only one direction.** Five capabilities assert both. A route mounted with `requireControlPlane` and never declared was invisible to `missingAdminRoutes`, so a management surface could grow without ever reaching the manifest a client dispatches from. Both now probe the router with a credential-free request and hold the set that answers `controlplane/not_connected` against what the manifest declares — method and path, read from behavior rather than from the declaration under test.
  
  **payments pinned its route table by path.** `POST /payments/admin/purchases` beside the read was a write nobody declared and this file could not see: the path was already in the set, and a set does not count. Pinned by method and path now, as email's has been.
  
  **The store-backed-secret scan could not see a hyphenated, quoted or standalone declaration.** It found one of the two the kit ships and its anti-vacuity guard was `> 0`. It is driven off a text count now, every declaration must be named, and a shape the extractor cannot read raises instead of vanishing.
  
  **The mint-coverage gate named four registries and said it read them all.** Eight ship. The list is held against a scan of the packages, so a ninth `defineSecretRegistry` fails until somebody says what creates its arbitrary secrets.
  
  **The schema-description sweep walked object fields and stopped.** An object inside an array, an optional, a record or a union member was never reached. It follows every container Zod has, a kind it does not know throws rather than passing as a leaf, and it counts what it swept.
  
  **`requiredBindings` quantified fifteen manifests it never asserted it had.** With an empty walk the file collapses from 36 tests to 6 and stays green.
  
  **The core Worker-safety scan saw only `node:` specifiers**, with a floor of 20 against 104 modules. `import { createHash } from "crypto"` is a Node builtin and was invisible. Stated positively now: every specifier is relative or a declared dependency.
  
  **The one-printer JSONC gate matched two spellings of a write verb.** `writeFileSync` was not one of them. The write half is gone; what is checked is who can reach `comment-json`'s `stringify` at all.
  
  **The contract module's "no timer, no fetch, nothing from node" was four literals.** `setInterval` was not among them. The imports are an allowlist and the forbidden ambient names are the runtime's own globals, so the list cannot come out shorter than the rule.
  
  And a gate over the gates: every package-wide `import.meta.glob` sweep is partitioned into the ones that assert their population and the seventeen that do not. A new sweep is in neither list and fails there.

- [`8eaea90`](https://github.com/pithy-sh/pithy/commit/8eaea90d1a35fd295733f8d33a04b4ce44119211) Thanks [@kingmesal](https://github.com/kingmesal)! - A resumed email batch dates its work by the pass, and its heartbeat still beats.
  
  `EmailSendWorkflow.run` read one clock in the driver body and gave it two jobs. A Workflow does not resume inside the step it died in — it re-executes the body from the top and serves every completed step from the journal — so a batch that backed off and resumed dated its remaining jobs, and the expiry of every tracked link in them, by the resume. A batch interrupted overnight promised half its recipients a link a day shorter than the other half.
  
  `SendDeps.now` is two fields now, because it was answering two questions with opposite lifetimes.
  
  `passStartedAt` is journalled in a `pass-instant` step and stable across a resume. It dates the work: `sentAt`, the redaction stamp, the events, and every link expiry. A link minted on the resumed half expires from the pass rather than from the mint — two people in one batch are promised the same window, and which attempt happened to render their message is not something they can see.
  
  `heartbeatAt` is a thunk, read fresh on every patch, and never journalled. **This is the half that had to be got right.** `updatedAt` is not a stamp: it is the scheduler's only evidence that a `sending` job is still being worked on, and `runScheduler` claims and re-drives anything older than `stuckMs` on the assumption its dispatch died. Journalling it makes a batch that resumes past that window report the job it is actively retrying as stranded — so the next tick starts a second send Workflow against it, and since `runSend` short-circuits only a job already `sent`, both attempts render and both call `send`. One person, two emails. A sweep journalled the single `now` and was reverted for exactly that; the test suite now drives it, with a real scheduler tick over a real resume, and a vacuity check that the detector still catches a batch that really did die.
  
  The Workflow's body moved to `workflows/sendBatch.ts` as `runSendBatch`, taking a structural step runner the way `reconcilePayments` and `runAtRestKeyRotation` take theirs. `worker.ts` imports `cloudflare:workers`, so nothing inside it could be exercised without deploying it — and every property worth proving here is a property of a resume.
  
  With this the driver-determinism gate's known-exceptions list is empty. It held three sites; [#327](https://github.com/pithy-sh/pithy/issues/327), [#328](https://github.com/pithy-sh/pithy/issues/328) and [#329](https://github.com/pithy-sh/pithy/issues/329) are all closed, and the gate now asserts against an empty set.

- [`fe88615`](https://github.com/pithy-sh/pithy/commit/fe88615679a85b30e4181a92dad42213b789f6ae) Thanks [@kingmesal](https://github.com/kingmesal)! - A testers pass that crosses midnight files every cohort under one day.
  
  `TestersDailyWorkflow.run` read its clock in the driver body, and that clock decides the day key every snapshot is written under. A Workflow does not resume inside the step it died in — it re-executes the body from the top and serves every completed step from the journal — so a pass that began at 23:58 and resumed at 00:05 filed its remaining cohorts under the next day. One run, two rows of a series, and nothing later corrects it: the darkness histogram cannot be recomputed after the fact.
  
  The instant is journalled in a `pass-instant` step now, so a straddling pass belongs to the day it began — the day it sampled activity on.
  
  **The nudge clock is deliberately left alone, and now has a module and a test saying so.** `enqueueEmail` writes the instant it is given as an email job's `createdAt`, and the email scheduler re-drives any `pending` job older than `graceMs` on the assumption its dispatch died. A nudge stamped with an instant the pass read an hour ago is born already past that cutoff, so the next tick claims it and starts a second send Workflow against the one the enqueue just dispatched — a double-send. That seam moved to `nudge/enqueueSeam.ts`, takes its clock as a thunk it reads per nudge, and is held there by a test that drives a real scheduler tick over both stampings. Day key stable, enqueue fresh.
  
  The Workflow's body moved to `workflows/pass.ts` as `runDurableDailyPass`, taking a structural step runner the way `reconcilePayments` and `runAtRestKeyRotation` take theirs. `worker.ts` imports `cloudflare:workers`, so nothing inside it can be exercised without deploying it — and every property worth proving about this body is a property of a resume.

- [`fcc9ec6`](https://github.com/pithy-sh/pithy/commit/fcc9ec62ffa122784fd423b275b8253a1ed9ad34) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy valueOf` crashed. `pithy constructor` succeeded, silently, having done nothing.
  
  ```
  $ pithy valueOf
  TypeError: undefined is not an object (evaluating 'value()')
  Bun v1.3.14 (Linux x64)
  
  $ pithy constructor ; echo $?
  0
  ```
  
  Every `subCommands` is an object literal, and citty resolves a name with `name in subCommands` and calls the value when it is a function. So `Object.prototype` was a member of every lookup at every level of the tree: `valueOf` and `hasOwnProperty` were called with no receiver and died on a raw `TypeError` under a crash banner, and `constructor` was called, returned `{}`, and was taken for a command definition with nothing to run.
  
  Neither name is a command, and there is already a path for a name that is not a command — `pithy nonsense` names it, shows the help, and exits non-zero. Each `subCommands` record is now copied onto a null prototype on its way to citty, so an inherited name resolves to nothing and takes that path. Done once for the whole tree rather than at the twenty-six `defineCommand` calls, for the same reason the usage rule is: a group added next year inherits it with nothing to remember. Laziness survives — a subcommand thunk is wrapped, never called.

- [`fcd26f2`](https://github.com/pithy-sh/pithy/commit/fcd26f21c306fed71fcb4ef22579a58bb6288246) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy env` said `local` where it meant "Miniflare is fine with this, and a bare deploy is not gated on it".
  
  [#320](https://github.com/pithy-sh/pithy/issues/320) was right that an id-less binding in the top-level stanza is not a deficiency: Miniflare serves D1 from the binding declaration, and `pithy dev` works because no Cloudflare resource is involved. But that stanza has a second job. A bare `pithy deploy` — `wrangler deploy` with no `--env` — ships it to Cloudflare, and it is the one deploy path with no `assertEnvironmentProvisioned` in front of it. Every `--env` deploy is refused before a binding with no id reaches wrangler ([#240](https://github.com/pithy-sh/pithy/issues/240)); this one is not.
  
  So one word stood as the whole answer, and an operator reading `pithy env` before a deploy read it as *nothing to provision here*. The stanza now says the other half itself:
  
  ```
  dev  local
    worker  dash-board
    DB (d1)  local
    Miniflare needs no id. A bare pithy deploy ships this stanza, and nothing gates it on one.
  ```
  
  Once per stanza, because it is a fact about the stanza and not about each binding. And only where it is a fact: a local environment whose bindings all carry ids says nothing, and a deployed one already says `not provisioned`, which is the action item. A line under every environment would be the wallpaper [#320](https://github.com/pithy-sh/pithy/issues/320) removed.

- [`88e5a0a`](https://github.com/pithy-sh/pithy/commit/88e5a0a47412d19727ad44fa058d404a60689587) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy provision --feature` states the shortfall instead of naming a command that does nothing.
  
  Both modes defer the same `d1` secrets — they are sealed under a master key inside an environment's
  secrets manager, and provisioning runs before the managers are deployed. Both were then told to run
  `pithy secrets provision`. That command spans the environments the project *declares*, deploying a
  manager into each; a branch is not declared and gets no manager, deliberately, so running it from a
  feature worktree does nothing. An operator spent a command and learned nothing, which is the dead end
  this area exists to remove.
  
  `--env` is unchanged. `--feature` now says that a branch gets no manager, that no command creates these
  for one, and that the environment comes up without them. No remedy is invented: every route to one was
  checked, and each is either the per-branch manager [#241](https://github.com/pithy-sh/pithy/issues/241) refused or a second writer for a store whose
  whole premise is that only the manager writes it.
  
  `--json` carries the distinction as `pendingSecretsRemedy` — the command, or `null`. A pipeline branches
  on that rather than on the mode. The advice is chosen by a record total over the provisioning modes, so
  a third mode fails the build rather than inheriting whichever branch came first.

- [`d0e1744`](https://github.com/pithy-sh/pithy/commit/d0e1744f75cd0520252d36efb7309875fe678327) Thanks [@kingmesal](https://github.com/kingmesal)! - No Workflow driver body reads a clock or a random source outside a step, and a gate over every shipped Workflow says so.
  
  A Cloudflare Workflow does not resume inside the step it died in. It re-executes the driver from the top and serves every completed step from the journal, so anything the body computes answers differently on the second attempt. [#328](https://github.com/pithy-sh/pithy/issues/328) moved payments' run id into a step for exactly that reason and left `const now = deps.now()` on the line above it — the same defect, one field over, in the fix for it. `startedAt` was therefore recomputed on resume, and a run interrupted at nine and resumed at three recorded a start six hours **after** the repairs its own id is stamped on. The runs table exists to answer "when did this pass run and what did it fix", and its answer was a row that began after its own work.
  
  The id and the clock are minted together in one `start-run` step now (which replaces `mint-run-id`), as epoch milliseconds, because a journal round-trips JSON. Proved by driving a real interrupt-and-resume with a clock that moves six hours, and asserted over the work rather than over a constant: no row the run repaired was written before the run says it started.
  
  The sweep found three more, in three capabilities. `TestersDailyWorkflow` read `new Date()` in its body, and `now` decides the day key every snapshot is written under — a pass that began at 23:50 and resumed after midnight wrote the cohorts it had finished under yesterday and the rest under today, and the darkness histogram cannot be recomputed after the fact. `EmailSendWorkflow` read its clock a frame down, inside `buildSendDeps`, so a batch resumed the next day dated its remaining jobs and every link expiry with it. `runAtRestKeyRotation` read one for the key version it stamps. All three are journalled. Leaderboard's `RankRefreshWorkflow` already did this correctly and is what the others now look like.
  
  The gate is `packages/cli/src/ci/workflowDrivers.ts`, and it states where a value may be produced rather than listing the ways to produce one: **a driver body may not evaluate a nullary call or a nullary construction.** A call with no arguments cannot compute its answer from its input, so the answer came from outside the program — which closes over `Date.now()`, `new Date()`, `crypto.randomUUID()`, `performance.now()`, the injected `deps.now()` that no list of global names could have caught, and the sixth spelling nobody has written yet. A function-like node is a definition rather than an evaluation, so `now: () => new Date()` handed to a step stays legal and a `step.do` callback needs no special case; a call into the module's own functions is followed, which is how email's clock was found.
  
  The population is discovered, never declared: every class extending `WorkflowEntrypoint`, plus every function taking a step runner — itself recognized by shape, as any interface whose one member is `do(name, callback)`. Fourteen Workflows and four delegates, asserted exactly and cross-checked against the `className` every `WorkflowSpec` declares, which is a second enumeration maintained for an unrelated reason. Three of the fourteen do not live under `src/workflows/`, so a gate that had globbed that directory would have covered eleven and reported itself green — pithy-sh/pithy#326 finding 4, avoided by asserting the set rather than a floor. Each of the four defects was planted back into the real tree and named with its file, line, driver and expression; a fifteenth Workflow was planted and the population assertion failed on it.

- [`de57027`](https://github.com/pithy-sh/pithy/commit/de57027baf1d17e3554ba7da0821224fc2457bb1) Thanks [@kingmesal](https://github.com/kingmesal)! - Give `action` an audience, and enforce it where the boundary already is.
  
  `PithyError` classified two of its three text fields. `message` was safe to expose, `detail` was stripped by the HTTP codec, and `action` was neither — so it went to the browser with everything else. Read the ones the kit ships and what it is becomes unmistakable: `Run \`pithy vector provision\``, `Bind a D1 database named DB in wrangler.jsonc`, `Set \`name\` in pithy.config.ts`, `Take the ${rail} credentials from <provider console> and set them with \`pithy secrets set\``. That is a sentence for somebody with the project checked out, and it was being handed to whoever tripped the error.
  
  **`action` is operator-facing.** It now sits beside `detail` on `ErrorPayload` and is absent from `PublicErrorPayload`, so the wire shape has no such key to fill — the strip is a property of the schema, per code and without exception, for an adopter's own codes exactly as for the kit's. A remedy the *caller* needs has always had a field: `message`.
  
  The operator's surfaces keep it. `renderTerminal` is unchanged, and the CLI's `--json` error line now encodes through `operatorError` rather than through the HTTP codec — both drop `detail`, but they drop it for different readers, and whoever ran the command is the person who can act on a wrangler binding.
  
  Two remedies that a caller genuinely needed moved to `message`, where they are said in the open rather than carried by a field nobody had classified. Storage now answers a half-finished multipart upload with the route that resumes it, and the dev-login page — which registers only in a `dev` composition outside CI, so its browser is the developer's own — still names `pithy seed`.
  
  Also: `<config>/cloudflare.json` promised that another tenant's key is "read and written back untouched" and silently deleted a `__proto__` one. `JSON.parse` gives it an own property, the parse skips it while rebuilding the object, and the write puts back what it was handed. The read-modify-write now refuses that document rather than quietly dropping the key from a file holding a live API token.

- [`bb5f461`](https://github.com/pithy-sh/pithy/commit/bb5f461cca2ad7f3b1eda3abe2cd0bbbcbfdec21) Thanks [@kingmesal](https://github.com/kingmesal)! - `<config>/cloudflare.json` no longer deletes a `__proto__` key while promising it would not.
  
  The schema's `catchall` says another tenant's key is "read and written back untouched", and for one key that was never true. `JSON.parse` gives `__proto__` an own property, because it must; Zod skips that key while building the object it returns, for the same reason; the read-modify-write then puts back what it was handed. Measured: the document states the key, the parse result does not, and nothing is reported in between.
  
  Refused rather than preserved, on `@pithy-sh/core`'s `statesNoVanishingKey` and in front of the parse, where a key that has already vanished can still be seen. `__proto__` is not a name a future tenant will be called, and this file holds a live Cloudflare API token — a key deleted in silence there is not something to shrug at. A malformed document keeps its existing answer, which is a different failure with a different cost.

- [`a3ef4c9`](https://github.com/pithy-sh/pithy/commit/a3ef4c94d9cd73368fc85dca70785b8ef7b9e551) Thanks [@kingmesal](https://github.com/kingmesal)! - `bun install` left the CLI entrypoint world-writable.
  
  `packages/cli/src/bin.ts` came out of every install at `0777`. `pithy` is the only `bin` in the workspace, `tooling/browser-scopes` depends on `@pithy-sh/cli`, and bun links a workspace bin by symlinking `node_modules/.bin/pithy` straight at the source file — then makes the target executable with a mode nobody chose. `rwxrwxrwx` on the program that reads an adopter's dev secrets and holds their Cloudflare credentials: any local account could rewrite it, and the next `pithy` the user ran was whatever that account wrote. git recorded the file `100644`, so it also reported a mode change in every worktree from the moment it was cut — six of thirteen on one machine at once, and a tree that is dirty by default is how an unrelated change gets swept into somebody's commit.
  
  The exec bit is wanted. `bin.ts` opens `#!/usr/bin/env bun`, and bun's workspace link points at the source rather than at a shim, so `./node_modules/.bin/pithy` is `Permission denied` without it. So git now records `100755`, and the repo root's `postinstall` narrows what the install widened: the same command that breaks the mode repairs it, which is why a worktree already carrying the change is fixed by re-running `bun install` rather than by hand.
  
  The rule is stated once, in `src/ci/fileModes.ts`, and gated in `src/ci/fileModes.test.ts` over everything git tracks or the tree holds unignored. No file is world-writable, none carries setuid, setgid or sticky, the exec bits agree with what git records, and a file git records executable is not group-writable either — the three programs something else runs by path land at `0755`. Group-write is permitted elsewhere because `git checkout` writes `0664` under a `0002` umask, and a gate red on files git itself just wrote is a gate muted within a day. A mode git records that this rule has no sentence about throws rather than being skipped.

- [`a2a6e83`](https://github.com/pithy-sh/pithy/commit/a2a6e832b2fde486dc1dfd3fe1e47189d7b872c4) Thanks [@kingmesal](https://github.com/kingmesal)! - A successful rotation records a rotation, whichever path ran it.
  
  `pithy secrets rotate` dispatched an ordinary `update`, and an update is not an event the write core can name — so nothing advanced `lastRotatedAt`, the secret reported **overdue** permanently, and rotating again did not help because the next rotation was also an update. The same act performed from a control-plane client recorded correctly. Two paths to one act, disagreeing about whether the act happened, and an operator rotating on the command line during an incident told by the product that they did not.
  
  `rotateSecretValue` now takes a `RotationLedger` as a **required** argument and brackets the run with it: refuse, open the row, produce once, store with retries, close the row. Required because an optional one is the one a caller forgets, which is exactly how this happened. The row opens before the roll, so a rotator that never returns still leaves an `in_progress` trace; it opens only after every refusal, so a rotation that never started writes no history.
  
  Two implementations of one seam, because there are two kinds of caller and only one holds the database. `trackerRotationLedger` writes the table directly, for anything running inside an environment. `dispatchedRotationLedger` reaches the same table through the manager write-Workflow, which is how the CLI writes anything — two new dispatch modes, `rotation-open` and `rotation-close`, answered by `runWriteWorkflow`. Both compose the closing verdict the same way, per environment: a fan-out that reached staging and stranded prod closes `success` in one ledger and `failed` in the other.
  
  A first write and a rotation stay different events. `recordBaseline` keeps writing `trigger: baseline` on the create branch, a rotation writes `manual` with an actor, and `pithy secrets update` records neither — inferring a rotation from a write would let a typo fix advance a freshness clock nobody rotated.
  
  Bookkeeping never blocks the act: a ledger that cannot be reached costs the row, not the rotation. A close carries a reason **code**, never free text, so the failure sentence is composed inside the Worker and no shape crossing the wire could carry a value.

- [`441cc56`](https://github.com/pithy-sh/pithy/commit/441cc56be62c067efc83b46ec93d78c0ef6e24c3) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add --auth` now seeds the gate that catches the Turnstile action drifting, not just the widget it drifts in.
  
  The action label is one contract with two ends. `[#377](https://github.com/pithy-sh/pithy/issues/377)` made the projection the single statement of it and had `src/turnstile.tsx` render `turnstileConfig.action`, and it proved that with a test — in `packages/ui-react/src/`. So the corrected widget shipped to adopters and the gate stayed here. The template's whole risk is that it can be retyped, it is an adopter-owned file the kit only seeds, and the kit cannot stop the retyping. That is exactly why the gate has to travel with it.
  
  **The failure is invisible in every environment an adopter runs before production.** Cloudflare's always-pass test secret answers siteverify with no `action` field at all, and `[#374](https://github.com/pithy-sh/pithy/issues/374)` made the gate accept exactly that in dev and staging. A drift is caught first in production, where it refuses every sign-in with a 403 saying the challenge failed — pointing the reader at the sitekey, the secret and the widget, in that order, none of which is wrong. The adopter most likely to hit it was the one least equipped to recognize it.
  
  `templates/src/turnstile.test.tsx` mocks `src/pithy-config.tsx` with an action that is deliberately not a real one, renders the widget against a stubbed `window.turnstile.render`, and asserts it carried the canary. **It cannot pass against a literal** — asserting the real action would pass against the very bug it exists to catch — and it derives nothing from its subject: the expected value is invented in the test file and reachable from nowhere else. A sitekey canary beside it fails as loudly when a mock never took effect as when the widget ignored it, and one assertion refuses the canary degenerating onto a real action, because a gate nobody can neuter quietly is worth more than one that only usually works.
  
  It runs under the `vitest run` a scaffolded project already has. `// @vitest-environment happy-dom` in a docblock is the whole of its configuration — no Vite plugin, no alias, no kit package on the import path — because a gate that depends on the adopter's test configuration keeping a particular shape stops running the day they reshape it. `happy-dom` joins the React stub's dev dependencies to make that name resolve; the starter's node project already collects co-located `.tsx` tests but runs them in an environment with no `document`.
  
  The kit runs it too, from the template tree, exactly as an adopter will. A gate shipped and never executed here is the same silence one level up.
  
  `pithy ui add --auth` says the file is theirs and what it watches for, because a gate over a silence is worth nothing unnoticed.

- [`afa106f`](https://github.com/pithy-sh/pithy/commit/afa106f9ab58d4664eb2688711fdc925551ead11) Thanks [@kingmesal](https://github.com/kingmesal)! - The ambient types for `virtual:pithy/*` are now compiled against the projections they describe.
  
  `templates/client-env.d.ts` is 144 lines of hand-written declarations for four modules, copied into an adopter's Worker by `pithy ui add react`. The producers are each capability's `client:` projection, resolved by `resolveClientProjection` and rendered by `renderVirtualModule`, three packages away. Nothing compared them.
  
  **Because the declaration is the type, the compiler could not notice a drift.** A field a projection stopped emitting still typechecked everywhere in the adopter's app — the declaration said it existed. It was `undefined` at runtime, in production, in a browser, and nothing between here and there went red. The only checks were substring assertions in `@pithy-sh/cli` confirming the file against itself; the removal direction is precisely the one they cannot see, because the file still contains the string.
  
  `@pithy-sh/vite`'s `src/clientEnv.test.ts` closes it. Fifteen cases, each a real capability resolved through the real `resolveClientProjection` and rendered by the real `renderVirtualModule` — both branches of every union, the absent-capability answer included — and the rendered literal is assigned to the declared type in a throwaway TypeScript program with `tsc` as the comparator. Narrowing the union with `Extract` before the assignment is what makes it exact in both directions: a fresh object literal against a single object type is missing-property-checked and excess-property-checked at once. No expectation is written down anywhere.
  
  Proven able to fail, and permanently: every field of every projection, at every depth, is dropped, added beside, and retyped — one module each, three compiler runs — and every one must be red. That is also the reach assertion. A declared property this suite leaves green is one an adopter could read after the projection stopped writing it.
  
  It stays hand-written. Generating it is the better shape, but `Capability.client` is typed `(context) => ClientProjection` — `{ enabled: boolean }` plus a JSON catchall — so a capability's real shape exists only as an inferred object literal inside a closure and is erased at the interface. The only source in reach is the projected values, and a type inferred from a value is weaker than the file it would replace: the literal unions, the nullable blocks and the product element type all collapse to whichever branch one sample config took, and every doc comment is lost. No build step is involved either way.
  
  The CLI now asserts what is actually its own: the bytes it seeds are that file's, unaltered, in every scaffold.

- [`6226fc4`](https://github.com/pithy-sh/pithy/commit/6226fc48b5ca900d2e35f7c8fb6c29b7bf02b2a2) Thanks [@kingmesal](https://github.com/kingmesal)! - A screen's path and the router's redirect to it are one statement, not two literals that agree today.
  
  `router.tsx` held `SIGN_IN_PATH = "/sign-in"` and `PAYWALL_PATH = "/paywall"`. The other end of each was an `export const path` in a different seeded file, typed `string`. Renaming `/sign-in` to `/login` — an ordinary rebrand, and the most predictable edit an adopter makes to a file that is now theirs — typechecked, linted, built, and left the signed-out guard redirecting to the not-found screen. Nobody already signed in would ever see it.
  
  A screen claims the job it does — `export const role = "sign-in"` — and the router looks the path up. One statement, wherever the path moves to. Claim a role from `src/routes/app/` to take the job over, the same shadowing rule as a path. A role nothing claims throws, naming the export to add, rather than sending a visitor nowhere.
  
  Seven sites carried a copy in all: the router's two, the magic link's `callbackURL`, `signOut`'s
  redirect, and three `<Link to="…">` between screens. Each is now a role lookup or a declared export
  read directly, and `react.test.ts` refuses a template that writes a screen's path anywhere but on the
  line that exports it.
  
  The magic link is the same contract in the other direction. `sign-in.tsx` built `` `${origin}/callback` `` while `callback.tsx` declared `/callback`, and the kit's own `signIn.test.tsx` asserted a literal against a literal it also owned — so the round trip breaking was entirely unobserved by the test that looked like it covered it. The screen reads the export now, and both tests read it too.
  
  **Two gates are seeded with the screens ([#391](https://github.com/pithy-sh/pithy/issues/391)).** `src/router.test.tsx` and `src/routes/pithy/sign-in.test.tsx` travel into the repository where the rename actually happens. Each meets [#383](https://github.com/pithy-sh/pithy/issues/383)'s three properties: the failure it watches is silent, its expectation is a canary invented in the test file with a second assertion refusing a canary that has drifted onto a real path, and each was proven able to fail in a scaffolded project by planting the literal it exists to refuse.

- [`9abb6d3`](https://github.com/pithy-sh/pithy/commit/9abb6d3b84a0f35c88897ebebe10273838dd1562) Thanks [@kingmesal](https://github.com/kingmesal)! - A scaffolded front end mounts into a node it creates, so no renamed id can leave an empty page behind.
  
  `index.html` declared `<div id="root">`, `src/client.tsx` found it with `getElementById("root")`, and then guarded `if (container) { … }`. The guard was the defect: rename the div — an ordinary edit to your own HTML — and the app rendered nothing, threw nothing, logged nothing. An empty document with a 200, a clean build and a green suite. It is the failure mode hardest to attribute, because the first three things anyone suspects are their own code, their build and their Worker, and none of them is wrong.
  
  The page carries no mount node now. `client.tsx` creates the one it renders into, sets `#root` on it so the styling hook survives, and there is no second string for a rename to break. Anything you put in `<body>` is left alone; the app mounts after it.
  
  `src/client.test.tsx` is seeded with it ([#391](https://github.com/pithy-sh/pithy/issues/391)): it builds the document an adopter who renamed the div would have — a mount node carrying a deliberately wrong id — and asserts the app rendered anyway. Code that looks an id up goes red there; only code that creates its own node passes. Proven able to fail in a scaffolded project by planting the old shape.
  
  `routeGlob.test.ts` stops writing an `index.html` of its own too: it builds the seeded page, and its entry fixture carries the shape the templates now ship.

- [`a81d012`](https://github.com/pithy-sh/pithy/commit/a81d0123dd13dfb41736927bc47801a6e475a095) Thanks [@kingmesal](https://github.com/kingmesal)! - A Worker created through the API runs on a compatibility date its caller chose. **`createWorker` requires one.**
  
  `CloudflareWorkersManager.createWorker` supplied `2026-04-07` when the caller named none. It was not broken — that date is past [#385](https://github.com/pithy-sh/pithy/issues/385)'s fix — but it sat below the `2026-06-01` floor `compatibility.ts` holds every other Worker in this repository to, and it was the one date [#388](https://github.com/pithy-sh/pithy/issues/388)'s gate could not reach: the gate reads `wrangler.jsonc` manifests, and this was a TypeScript constant. [#388](https://github.com/pithy-sh/pithy/issues/388) named the hole in its own docstring rather than move a number in passing.
  
  **Moving it to the floor was the obvious answer and it is the wrong one.** A compatibility date is a behavior contract, not a version number — it is the date workerd pretends it is — and this one lands on Workers in accounts that are not ours. Re-picking the number changes what an existing caller's Workers run, silently, for somebody who never asked. And the new number goes stale on exactly the schedule the old one did, with the same gate still unable to see it. `compatibility.ts` makes that argument about `2026-03-03` already: *the minimum that fixes the last bug is exactly the number `2025-01-01` once was.*
  
  Requiring the date removes the class instead of re-picking the number, which is the move [#377](https://github.com/pithy-sh/pithy/issues/377), [#366](https://github.com/pithy-sh/pithy/issues/366) and [#394](https://github.com/pithy-sh/pithy/issues/394) each took. It is also the cheaper break: a caller who wanted `2026-04-07` writes `2026-04-07` and gets precisely what they had, and everybody else finds out at compile time rather than from a behavior change in production. `WorkersProvisioner` already promised this one level up — *"it carries no environment- or product-specific defaults"* — and the manager under it was the one place that was untrue.
  
  `metadata` may no longer also carry `compatibility_date`, and a date that is not an ISO date is refused here rather than by a 400 from Cloudflare. Two ways to state one contract is a precedence rule to remember, which is what this change exists to delete.
  
  **[#388](https://github.com/pithy-sh/pithy/issues/388)'s gate has no exception left.** Its docstring said so and now says why it does not.
  
  The reasoning is at the site, on `createWorker`, not only in the issue.

- [`bc1ddf1`](https://github.com/pithy-sh/pithy/commit/bc1ddf137d253790dc74633b09cb505fb1865bd6) Thanks [@kingmesal](https://github.com/kingmesal)! - Set the dependency floors the first release ships.
  
  `bun audit` went from 24 advisories to 5. The `hono` floor moves to `^4.13.2`, clearing seven —
  none reachable from the kit's own code, all reachable by an adopter composing `hono/cors` or
  `hono/jsx` through our range. `nanoid`, `postcss`, `fast-uri` and `js-yaml` cleared with a
  lockfile refresh.
  
  `postal-mime` moves to `^3.0.0`, and it is a security bump rather than a version bump. 2.7.x
  resolved a duplicated single-value header last-wins, so a sender could append a second `From:`
  below their own headers and choose the address `@pithy-sh/support` recorded as the sender, while
  every verdict above it was stamped against the topmost one. 3.0.0 resolves first-wins, which is the
  rule the header map already applied.
  
  Five undici advisories remain. Every `miniflare` 4.x pins `undici` at exactly `7.28.0`, so no
  floor of ours can move them, and miniflare 5 is alpha-only. miniflare is the local simulator; it is
  in no deployed Worker. `docs/STACK.md` §17 records that, and every other floor, with its reason.

- [`47e40ff`](https://github.com/pithy-sh/pithy/commit/47e40ff274e03100da64b87f5af190bf3025f2e4) Thanks [@kingmesal](https://github.com/kingmesal)! - Three contracts a scaffolded front end used to freeze in silence.
  
  **`/health` is one statement.** It was written in four places — `createBackend` mounted it, the route allowlist seeded it, `pithy deploy`'s probe appended it, and the bare home screen fetched it — and nothing compared any pair. That screen is the only one a project with no auth composed gets, and its whole content is the request: a rename in the kit rendered *"The worker says: unknown."* with a 200, no error, and nothing in a log. `HEALTH_PATH` in `@pithy-sh/core/src/worker/health` is now the one statement all four read. It imports nothing, so the client bundle can hold it without a server runtime.
  
  **The paths frozen at scaffold are checked by resolving them.** `vite.config.ts`'s `persistState` depth, both tsconfigs' `tsBuildInfoFile`, and `tsconfig.client.json`'s `include` are all relative to `apps/<worker>/`, and every one of them reads identically whether it is right or wrong. A wrong depth gives two Workers separate copies of one database. A narrowed `include` makes `tsc -b` exit 0 over a program holding no screens — the client's whole typecheck, gone, with no change in output. The gates live in the scaffolder's suite now, where a real project exists to resolve against, and each was proven red by planting the defect in one.
  
  **The unstyled report can fail a run, and runs again.** It checked whether Pithy's screens render styled, then printed once at `pithy ui add` and never asked again — while `styles.css` is the adopter's, so the ordinary way a screen loses its rules is an edit a week later. `pithy ui sync` re-runs it and `--check` exits 1 on a finding, alongside the shadowed-route check it already made. It reads every `.css` under `src/` rather than the paths a run planned, so a rule in a stylesheet Pithy never wrote counts. `docs/UI.md` says when it runs, what fails, and the one blind spot it keeps: a `className` given a bare identifier is not read.

- [`304a55b`](https://github.com/pithy-sh/pithy/commit/304a55bbc3d60634c3f3630f88cc97da99e1a83d) Thanks [@kingmesal](https://github.com/kingmesal)! - One statement for the project's local dev state root.
  
  `dev/orchestrator.ts` composed `join(projectDir, ".wrangler", "state")` itself, making
  three independent derivations of one directory. It reads `localDevStateRoot` now, and
  the scaffold gate holds the template's relative path against that function rather than
  against a deeper path two `dirname`s away.

- [`f75aec3`](https://github.com/pithy-sh/pithy/commit/f75aec387811fe603ae015d654b9eadb1fab0dc4) Thanks [@kingmesal](https://github.com/kingmesal)! - The Workflow determinism gate parses with the parser already in the tree, and Babel is gone.
  
  `@babel/parser` was a devDependency of `packages/cli` used by exactly one file: the [#331](https://github.com/pithy-sh/pithy/issues/331) gate that refuses a clock or a random source in a Workflow driver body. Nothing shipped, nothing ran it, no adopter ever installed it — and there was no reason for it.
  
  **The gate still needs a parser, so the first question was whether it does.** It resolves scopes, distinguishes a binding that holds a value from one that aliases a seam, stops at every function boundary, follows a call into a module-local function, and judges arity. A regex answers none of that, and [#326](https://github.com/pithy-sh/pithy/issues/326) finding 4 is what a gate that only looks like it walks costs. So the change is which parser, not whether.
  
  **`rolldown/parseAst`** — oxc, ESTree-shaped, TypeScript-aware. `vite@8` already depends on `rolldown@~1.2.1` for this repository's own test runner, so declaring `rolldown@^1.2.4` directly changed `bun.lock` by one line and added no package: same resolution, same binary, same bytes. `oxc-parser` is the same parser under a plainer name and would have resolved its own copy — nineteen platform bindings and about 3.6 MB — which is a swap dressed as a removal. `typescript@7.0.2` is tsgo and exports no classic compiler API, so the TypeScript already here was never an option.
  
  `ParseModule` was already a seam, so the parser is a parameter. What the swap forced is that the analyzer now speaks ESTree rather than Babel's dialect: `MethodDefinition` and `Property` for `ClassMethod` and `ObjectMethod`, `Literal` for `StringLiteral`, a `CallExpression` inside a `ChainExpression` for `OptionalCallExpression`, and a byte offset turned into a line rather than a `loc`. The one that bites: a method *wraps* a `FunctionExpression` in ESTree, so the walked scope has to be the function. Walk the method and the first node the walk meets is a deferred one — every driver in the kit reported clean, having parsed everything and read nothing.
  
  Which is why this is held to the swap by comparison rather than by argument. `analyseDrivers` ran over all 1023 sources under `packages/` with each parser, and over a second corpus of the same files planted with 75 violations across 19 of the 21 real driver bodies. Both outputs are byte-identical: same entrypoints, same drivers, same declared class names, same findings, same lines, same expressions. Then a clock planted in `PaymentsReconcileWorkflow.run` was named with its file and line, and a planted Workflow class failed the exact-population assertion. The gate bites exactly as it did.
  
  `@babel/parser` still resolves in `bun.lock`, reached by `@vitest/coverage-v8` through `magicast`. What went is the kit's declaration of it and the kit's use of it.

- [#417](https://github.com/pithy-sh/pithy/pull/417) [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27) Thanks [@kingmesal](https://github.com/kingmesal)! - The scaffolded SPA router reads and writes the query string.
  
  `usePath()` had no counterpart for `window.location.search`, and there was no `replace`. A screen whose state belongs in the address bar but not in the route had nowhere to put it, so it stayed in `useState` where history could not see it and the back button left the application. `pithy-sh/dashboard` is exactly that shape — a rail, an index and a record on one screen, where which kind and which row are navigation but neither is a route, because the rail is composed from a customer's manifest and `/users/usr_9f2c` would be a pattern for a set that may not exist on the next connection.
  
  Four exports, all against the `popstate` subscription that was already there. `useSearch()` returns `window.location.search` verbatim — the leading `?`, or `""`. `useSearchParam(name)` returns one decoded value, or `null`. `replace(to)` swaps the current entry rather than pushing one. `updateSearch(patch, options?)` sets a key for a string, clears it for `null`, and leaves everything else alone.
  
  **Both readers hand back primitives, and that is the decision.** A `URLSearchParams` is a new object every render, so every `useMemo`, `useEffect` and `useCallback` downstream of one re-runs forever.
  
  **`updateSearch` exists because the hand-rolled version has a trap that every call site meets separately.** Writing one parameter means reading the query, parsing it, setting a key, serializing it, and joining it back onto the path — and the join is where it goes wrong. `window.location.search` is `""` and never `"?"`, so a writer that appends a bare `?` after clearing its last parameter produces a URL that never equals the current one: every repeat call pushes another entry, and Back then walks through them one at a time without the page ever changing. Carrying the hash across is the other half nobody remembers. Both are handled once, here.
  
  `replace` is for a correction the reader did not make — a selection clamped back to nothing, a kind that left the manifest. Pushing one of those puts a state nobody chose into the back stack, and Back then lands on it and it is corrected again, forever. A place the reader *chose* to go is a push, which is why `<Link>` has no `replace`.
  
  `routes/pithy/otp.tsx` reads its prefilled address through `useSearchParam` now. It was the one template screen touching `window.location` directly, and it happened to work only because nothing navigates within that screen — a property of today's screens rather than of the router.

- [#420](https://github.com/pithy-sh/pithy/pull/420) [`2fdaf18`](https://github.com/pithy-sh/pithy/commit/2fdaf187119bf0e8ae1d64dd60fb656b98c413a4) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy add matchmaking` and `pithy add rating` work. Both packages were complete — routes, migrations,
  seeds, workers tests, stamped versions, every repo-wide gate green — and neither shipped a
  `pithy.manifest.json`, which is the file `pithy add` reads for the bindings to write and the config to
  scaffold. So both refused, and refused in the way that costs most: the action line named the command that
  had just installed the package. Both ship a manifest and a catalog entry now, so both appear in
  `pithy add --list` and wire themselves.
  
  That matters most for matchmaking, whose two Durable Objects — `MatchmakingQueue` and
  `MatchmakingPresence` — have no supported path into a working `wrangler.jsonc` without one. Adding it
  writes both namespaces across every environment plus their `new_sqlite_classes` class-migration tag.
  
  **A second Durable Object capability now gets its own migration tag.** Every DO class used to merge into
  `v1`, which was correct while multiplayer was the only capability shipping one. Cloudflare remembers the
  last tag it applied and the next deploy sends only the tags after it, so appending a class into a tag that
  had already been deployed sent it to nobody: the namespace was never created and the deploy failed on a
  binding to a class with no migration behind it. `pithy add multiplayer` → `pithy deploy` →
  `pithy add matchmaking` is the path matchmaking's own README recommends, and it is the one that broke.
  Tags are now allocated per add and never edited after they are written, which costs a never-deployed
  Worker nothing.
  
  A package that is installed and ships no manifest is also its own refusal now, separate from a name that
  was never installed — same `core/not_found` code, but it no longer tells you to run the command you just
  ran. `capabilities/addable.test.ts` is the repo-wide gate that fails on the next capability package
  shipping no manifest or no catalog entry; it keys on `src/capability.ts`, because the manifest is the
  artifact that goes missing.
  
  Both READMEs are rewritten to the standard the other capabilities keep — starting at `pithy add`, naming
  their bindings, migrations, tables, and routes — and matchmaking ships a `docs/costs.md`.

- [`8c90e2c`](https://github.com/pithy-sh/pithy/commit/8c90e2c5b22b5a16e8372450af0d8068cfdacd29) Thanks [@kingmesal](https://github.com/kingmesal)! - Three Workflow hosts did not build, because a worker's module format is inferred from its default export.
  
  `@pithy-sh/support`, `@pithy-sh/media` and `@pithy-sh/vector` each ship a prebuilt Workflow host, and each exported only classes. wrangler decides a worker's **format** from one thing — whether the entry has a default export — so all three were read as service workers, and a service worker may not import `cloudflare:workers`:
  
  ```
  ▲ [WARNING] The entrypoint packages/support/src/workflows/worker.ts has exports like an ES Module,
            but hasn't defined a default export like a module worker normally would. Building the
            worker using "service-worker" format...
  ✘ [ERROR] Unexpected external import of "cloudflare:workers" and "cloudflare:workflows".
  ```
  
  `pithy dev` builds each worker separately and the other workers come up, so it scrolls past. The classification Workflow, the four enrichment Workflows and the reprocess Workflow simply were not running.
  
  **The four hosts that worked all have a cron.** Somebody wrote `export default { async scheduled(…) }` for the cron, and the module became an ES module as a side effect nobody named. The three with no cron had no reason to write one. A rule satisfied at the call site by whoever happened to need something else.
  
  So the rule is now stated where it belongs, and the population is derived rather than listed:
  
  > Every module in this kit that extends `WorkflowEntrypoint` has a default export.
  
  `cli/src/ci/workflowModuleFormat.test.ts` re-reads the tree on every run through the same walk the determinism gate uses, so a host added tomorrow is judged tomorrow with nothing to remember — and the walk finds hosts wherever they live, not under a `src/workflows/` glob. It is proved against fixtures in both directions before it is trusted against the tree.
  
  `workflowHostEntry(capability)` in `@pithy-sh/core/src/workflow/hostEntry` is what the three export. It refuses rather than being empty: `export default {}` would build and say nothing, while a Workflow host genuinely has no request surface — an app Worker starts its jobs through a Workflow binding — so an HTTP request arriving at one is a misconfiguration, and `core/not_found` naming the capability is the sentence that ends an operator's search. The `action` names the binding that does work and is stripped before the body goes out, like every other action.

- [`55af6d2`](https://github.com/pithy-sh/pithy/commit/55af6d2e421b8f476901e914124648e0c0ba0334) Thanks [@kingmesal](https://github.com/kingmesal)! - Seventeen packages import `@cloudflare/workers-types` and now declare it. It was a devDependency in every one of them.
  
  `@pithy-sh/core` got this right at [#315](https://github.com/pithy-sh/pithy/issues/315), and `tooling/browser-scopes/src/probe.ts` wrote down why in two halves: importing a package by name is what makes the dependency real, and declaring it as a dependency rather than a devDependency is what makes it satisfiable. Fourteen packages had the first half and not the second. Three more had neither. The entry moves section; the range stays `^5.20260729.1` verbatim, and the root `overrides` pin is untouched.
  
  **The reason it never bit here is not the reason the issue gave.** The issue said a published tarball ships bundled `.d.ts` from tsdown with the types inlined, so an adopter never asks. Nothing in this repository uses tsdown. No package publishes typings from `dist`; every one declares `"exports": { "./src/*": "./src/*.ts" }`, so **every** adopter compiles our raw TypeScript inside their own program — and a devDependency of ours is not installed for them. That makes the fault wider than the `pithy init` case the issue described, not narrower. What actually hid it is local: Bun hoists the workspace and the root pin gives every member one copy, so a sibling's devDependency resolves for everything in this tree. `docs/STACK.md` has prescribed `bun add zod @cloudflare/workers-types` — `bun add`, not `bun add -d` — the whole time. The manifests drifted from it one copied sibling at a time.
  
  Seventeen tarballs therefore gain a runtime dependency, `@pithy-sh/cli`'s among them, and the Workers types are several megabytes of `.d.ts`. That is the correct size for a package that publishes source importing them.
  
  **Two keep theirs as devDependencies**: `turnstile` and `tooling/vite-adopter`. Neither reaches a Workers type at all — turnstile's verifier is a `fetch` to Cloudflare's siteverify endpoint and the `Response` it reads is a global every Node program has, and vite-adopter is a compile fixture rather than a published capability. Promoting them would put that payload in two adopters' installs for nothing.
  
  **Nineteen files were not importing anything, and that is the half an import-by-name gate cannot see.** They put a Workers global in a signature — `D1Database`, `D1Meta`, `D1PreparedStatement`, `D1Result`, `KVNamespace`, `DurableObjectNamespace`, `ExecutionContext`, `ForwardableEmailMessage` — resolved through `types` in each package's own `tsconfig.json`. An adopter compiling that source gets `Cannot find name`, exactly as they would on a missing import, while every gate reads the package as clean. They import the names now: `audit`, `auth`, `cli`, `cloudflare`, `core`, `email`, `matchmaking` and `rating`.
  
  `packages/cli/src/ci/workersTypes.test.ts` is the gate, and it holds three directions: a package that imports the types declares them, a package that does not import them does not, and **no shipped source anywhere in the workspace names a Workers global it did not import**. That last record is empty, and empty is the assertion — a file that stops importing a name it still uses lands back in it and fails.
  
  The sweep only means that because it reads every workspace member. Its first draft read the two packages that declare the types without importing them, which is 2 of 25, and reported the tree clean while thirteen files were not; `packages/matchmaking/src/data/tables.ts` was byte-for-byte the shape `packages/rating` had just been fixed out of. It is also self-widening, which it demonstrated twice: `D1Result` was invisible because the only named import of it in the tree was in a `.test.ts`, and importing it in one file made the second file naming it ambiently fail immediately.
  
  A name the host platform declares is excluded, and the host is asked rather than listed — `ReadableStream` enters the vocabulary because `@pithy-sh/storage` imports it by name, and casting `Response.body` to it is not the ambient defect in any runtime. `name in globalThis`, measured against the Node 22 floor every package states.
  
  The gate is scoped to this one specifier. The general rule — every bare specifier a shipped source imports is a declared dependency — is the shape, and the docblock says why it is not asserted yet: the same sweep finds `vitest` and `miniflare` reached from `src/test-utils/*.ts` files that ship because nobody excluded them, and making a test framework a runtime dependency of the CLI would be the wrong answer to that.

- [`77e59e3`](https://github.com/pithy-sh/pithy/commit/77e59e34139540589f41e186a8a4e9dd2e862c3a) Thanks [@kingmesal](https://github.com/kingmesal)! - A gate whose subject is the repository is keyed on the repository.
  
  Turbo scopes a task to the files of the package that declares it. Eleven gates under `packages/cli/src/ci/` read past that line — `sourceFiles.test.ts` reads every tracked file in the tree, `fileModes.test.ts` every tracked file's mode, `compatibilityDates.test.ts` and `testIsolation.test.ts` walk the whole root, and five more walk `packages/`. Every one of them was scoped to one package while its subject was the tree, so a commit touching nothing in `packages/cli` left `@pithy-sh/cli:test` a cache hit and the gate replayed a pass over a tree it never saw.
  
  Reproduced with the cache warm, by planting one `U+200F` in `packages/payments/src/client/wholeUnits.ts` — the exact character the source gate refuses. `turbo run test --filter=@pithy-sh/cli` printed `Cached: 1 cached, 1 total` and `Time: 21ms >>> FULL TURBO`, replaying `3613 passed` from before the character existed. Run directly, the same tree fails and names it: `U+200F at byte 124`. This is [#427](https://github.com/pithy-sh/pithy/issues/427)'s own history — that branch shipped five of them past a green `bun run test`. **The stale answer is "pass."**
  
  **The planner was already right; only the hash was wrong.** `.github/scripts/crossPackageReads.ts` maps a changed path back to the package whose suite asserts about it, and CI has been adding `@pithy-sh/cli` on every `packages/**` change all along. Turbo then answered the job out of a cache computed for a different tree. So the key derives from that same register rather than from a second list: `packages/cli/src/ci/turboInputs.test.ts` reads it, asks `turbo --dry=json` what is actually hashed, and fails on any registered read a key has dropped. `turbo.jsonc` is inside the key it guards, so narrowing the declaration re-runs the assertion about the declaration.
  
  The other half is the artifacts. Turbo does not apply `.gitignore` to an explicit glob, so a bare tree glob hashes `node_modules/`, every `dist/`, and each package's `.turbo/turbo-test.log` — **which the hashed task writes itself**, a key that can never hit. The negations are named, and they are held to a probe the test invents rather than one anybody picked: every rule of every ignore file git consults — the root's, `packages/cli`'s, and the one husky generates for itself — becomes a path that rule and no other decides, planted for the length of the assertion, and any key still holding it is named.
  
  Planted rather than found, because reading the working tree made it a different assertion on every machine: one `packages/<pkg>/x.tmp` left by an interrupted atomic write turned it red naming neither the crash nor the file. Derived rather than cataloged, because a catalog is the defect one level up and had both halves of it — it read the root `.gitignore` alone, so the vendored `packages/cli/templates/` sat inside all four whole-tree keys unseen, and its probes were narrower than their rules, so `.dev.vars.dev` counted as covering `.dev.vars.*` while `.dev.vars.local` went on being hashed. Neither produces a false pass. Both produce a hash that differs between a developer's machine and CI, where the failure looks like the developer's.
  
  **The price, measured rather than estimated: one character changed in `packages/payments` costs `bun run test` 13m26s**, re-executing `@pithy-sh/cli`, `@pithy-sh/ui-react`, `@pithy-sh/browser-scopes` and `@pithy-sh/payments`. Three heavy suites now start on every change, and the cli one alone is 231 files and ~196s cold. That is what a gate reading every tracked file costs, and it is a deliberate trade: the alternative is not a cheaper gate but a green tick over unverified work. The follow-up that buys the time back is moving the eleven repo-wide gates out of `@pithy-sh/cli` into a root task of their own, so the whole-tree key drags eleven files behind it instead of a 231-file suite. Nothing here depends on that landing.
  
  One thing this deliberately does not do: collapse the declarations. `turbo.jsonc` now holds four verbatim copies of one negation list, on top of three each for `@pithy-sh/vite-adopter` and `@pithy-sh/browser-scopes`, and the prose in those two blocks used to promise they would fold into [#432](https://github.com/pithy-sh/pithy/issues/432)'s answer. **They cannot.** JSON has no way to name a value, and turbo's only shared-inputs mechanism is `globalDependencies`, which keys every task in every package — the end of caching, spent to save the duplication. What is general is the guard, not the declaration: one test stands over every package the register names and holds every one of those keys to it. The copies stay, checked. The two promises now say so.

- [`802513a`](https://github.com/pithy-sh/pithy/commit/802513a473828eee404b08d328a912b6b1faa8a4) Thanks [@kingmesal](https://github.com/kingmesal)! - The Workers Vitest integration is `@cloudflare/vitest-plugin`, and a scaffolded project says so.
  
  Cloudflare published version 1 of the Workers Vitest integration under a new name. `@cloudflare/vitest-pool-workers` is `@cloudflare/vitest-plugin`, and the configuration API is unchanged. The old name is not deprecated on npm — its `latest` is `0.22.0`, published two days before `@cloudflare/vitest-plugin@1.0.0` — but version 1 is where the integration continues, so that is what to follow. Every package here takes the new one at `^1.0.0`.
  
  **Your repository needs the same three edits**, and a `pithy init` scaffold has already had them. The dependency in `package.json`, the `cloudflareTest` import in `vitest.workers.config.ts`, and the `/// <reference types="@cloudflare/vitest-plugin/types" />` line in `cloudflare-test.d.ts`. Cloudflare ship a codemod that does all three — `bunx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`, with `--dry-run` to read it first. It rewrites prose as readily as code, so check what it touched.
  
  **Seventeen of these eighteen releases change nothing you can run, and that is the point.** Bytes do move in all eighteen tarballs — `bun pm pack --dry-run` shows every capability package shipping its `package.json`, its `src/cloudflare-test.d.ts`, and in sixteen cases its `vitest.workers.config.ts`, and this commit rewrites all three. None of them is runtime code: a devDependency name, a `/// <reference types>` line, and a test config. Nothing an import of `@pithy-sh/<capability>` reaches is touched. A patch version that says so is how the note above gets to the repositories that need it. `@pithy-sh/cli` is the one real change: it vendors `templates/starter`, so `pithy init` now scaffolds the new name.
  
  **The rename is not free, and the cost is one line of `docs/STACK.md`.** The old caret held the test harness on `miniflare` 4 for nothing — for a `0.x` package it resolved below the 0.20.0 that first pinned a `miniflare@5.x-alpha`. Version 1 is that same line renamed, so `*.workers.test.ts` now runs on `miniflare@5.20260820.0-alpha` and workerd `1.20260820.1`. That is dev-side only, and it is not the first alpha here: `wrangler` is a devDependency of eighteen packages under `packages/`, hoisting to one `wrangler@4.123.0` that has carried a nested 5.x-alpha for our own suites all along. The kit ships no wrangler — `pithy dev` execs the one in your repository. What the kit *does* ship is `miniflare` itself, a runtime dependency of `@pithy-sh/cli` that `pithy migrate` and `pithy seed` construct, and that stays declared at `^4.20260722.1`. So the harness and the migrator now run different workerd builds, and no common compatibility date holds them together — nothing the CLI constructs `Miniflare` with passes one. `docs/STACK.md` names that exposure rather than leaving it to be found.
  
  `packages/core/src/worker/envIsolation.workers.test.ts` is new, and pins the `process.env` a workers test sees. `@pithy-sh/core` declares no `files` and carries no `.npmignore`, so `src` packs whole and that file goes to the registry with it — the second tarball here to gain content rather than only rename it. That is core's packaging, unchanged by this commit and not a thing to fix inside it. The test-isolation gate exempts workers projects because workerd inherits nothing from the host, and that reason was a comment reporting a count from an older workerd. It is an assertion now — and the gate resolves the path it cites, so the evidence cannot be renamed away while the exemption stays green.
  
  Nothing in this repository reached for `fetchMock` from `cloudflare:test`. It went in 0.13.0 — the same single release that replaced `defineWorkersConfig`/`poolOptions.workers` with the `cloudflareTest` plugin, and the one `packages/core/vitest.workers.config.ts` names for that. 0.12.21 still exports `defineWorkersConfig` and still ships `fetchMock`; 0.13.0 exports neither. `cloudflare:test` is imported for `env`, `runInDurableObject` and `runDurableObjectAlarm`, and for nothing else.

- [`31a7620`](https://github.com/pithy-sh/pithy/commit/31a7620a6bc5a05d43a4ec00cb4395af28fff0a5) Thanks [@kingmesal](https://github.com/kingmesal)! - The kit writes American English, and an email job is `canceled`.
  
  **One line here is a break, and it is the `@pithy-sh/email` job status.** `EmailJobStatus` spelled its final state `cancelled`; it is `canceled` now. That string is not internal — it is a column value in `pithy_email_jobs`, the `status` field of every job the control-plane routes return, the `?status=` filter on `GET /email/jobs`, and the `status` of the `SendOutcome` a send resolves to. **If your code compares `status === "cancelled"`, or filters a job listing on it, that comparison is now always false and you must update it.** Nothing warns you: it is a string against a string, so it fails quietly by matching nothing rather than by throwing. Grep your repository for the seven-letter spelling before you take this minor.
  
  **There is no migration, and that is a fact about this moment rather than a shortcut.** `0001_init.ts` declares the column as `.addColumn("status", "text", (c) => c.notNull())` — bare text, no CHECK, no enum — so the value set lives only in Zod and the database has nothing to alter. And no database anywhere holds a row spelling it the old way: every package is `0.0.0`, `npm view @pithy-sh/email version` still 404s, and `0001_init` *is* the schema under CONTRIBUTING.md's pre-publish rule. Both halves were re-checked before the value moved. **Once a version is cut this inverts** — a status value that has been written somewhere real is history, and changing it then costs a migration plus a compatibility window for the rows already carrying it.
  
  **The two capabilities stopped spelling one concept two ways, and they got there from opposite directions.** `@pithy-sh/payments` already had `canceled` in `PurchaseStatus`, and it keeps it because it is *Paddle's* wire value — rewriting a vendor's own string would be inventing a translation layer over somebody else's API. `@pithy-sh/email`'s was the kit's own vocabulary: nobody else names those states, so the spelling was ours to pick and we picked the one the rest of the prose uses. Two arguments, one spelling. The reason is written above the enum in `email/src/data/enums.ts` so the next reader finds the decision instead of re-deriving it.
  
  **Every other package here changes prose only, and no runtime behavior moves in any of them.** Comments, doc comments, test names, Zod `.describe()` text, `docs/`, each package's own `README.md` and `docs/`, and the `templates/` starter that `pithy init` vendors — en-GB spellings became en-US throughout. The package READMEs matter more than their line count suggests: sixteen of the eighteen manifests declare no `files`, so a README ships in the tarball and is the most-read prose here. Bytes do move in these tarballs, because `src` packs whole and a `.describe()` string is runtime data an adopter can read; nothing an import reaches behaves differently. Twenty of the twenty-one packages carried at least one. `@pithy-sh/multiplayer` carried none and takes no bump.
  
  **A sweep like this is mostly a list of words it must not touch, and that list is the work.** Several near-neighbors are already correct American English and were left alone: `cancellation`, `fulfilled` / `fulfilling` / `fulfillment`, and `enrolled` / `enrolling` all keep their spelling, and only the exact words `fulfil` and `enrol` moved. `programme` was read one instance at a time rather than replaced, because it is right in both dialects when it means a broadcast and wrong when it means a scheme. Two third-party wire values that look exactly like the thing being fixed stay as they are: Lemon Squeezy sends `cancelled` and `payments/src/rails/lemonSqueezy/objects.ts` still maps `case "cancelled": return "canceled";`, which is the boundary doing its job, and Cloudflare's own build outcome in `@pithy-sh/cloudflare` is `cancelled` because that is what the API returns.
  
  **A census keeps it true.** The rule is *the words this project writes are American*, and it is now a test over committed source rather than a thing whoever greps next has to remember. It was watched failing on a planted spelling before it was trusted, and it is proven not to flag a wire value, a generated vendor notice, or a quoted third-party string — by planting one of each. The exceptions are named with their reasons beside them, which is the part a word list alone could never carry.

- [`d4e5784`](https://github.com/pithy-sh/pithy/commit/d4e5784d086a92515db0445241df5d69286e33e5) Thanks [@kingmesal](https://github.com/kingmesal)! - The dev port registry is one file per machine, so two Pithy projects no longer both bind 8787.
  
  `.dev-ports.json` lived at the main repo root, which meant the registry partitioned on the checkout. Every project on a machine kept its own, every one of them started empty, and every one of them allocated block 0. `pithy dev` on the default branch of a second project asked for the same twenty ports the first was already running on — not a feature-worktree edge case, the very first thing every project does. The port check caught it and refused, correctly and with no remedy: nothing in either registry knew the other project existed, so nothing could say who held the port or move anyone off it.
  
  **It is now `dev-ports.json` in the Pithy config directory** — `$PITHY_CONFIG_DIR`, then `%APPDATA%\pithy`, then `$XDG_CONFIG_HOME/pithy`, then `~/.config/pithy` — resolved through the same `stateDir()` as `state.json` and `<project>/secrets.jsonc`. At the config **root**, deliberately: a `<config>/<project>/` directory would put back the partition this moved to remove.
  
  **The key is the absolute main-checkout root, then the branch.** Not the project `name` — two unrelated projects can share one, and here that collision would hand them the same ports, which is the defect. The root comes from `git rev-parse --git-common-dir`, so every worktree of a repository files under one key.
  
  **A checkout that is gone frees its ports.** At the repo root the registry died with the checkout, so `rm -rf` cleaned up for nothing; machine-wide, nothing else ever would. Every allocation prunes any root no longer on disk, under the same lock, including on the idempotent path — a machine whose steady state is `pithy dev` on settled branches otherwise never prunes at all. Only a definite `ENOENT` counts as gone: a root the CLI merely could not reach keeps its blocks, because deleting a live checkout's whole allocation set on an unreadable mount is not recoverable by anything that can no longer reach it either.
  
  `reclaimPortBlocks` still rebuilds the registry from the blocks live worktrees hold, and what it guards has narrowed rather than gone away: outside every checkout, no clone and no `git clean` can take the file — only a wiped config directory, a new machine, or a relocated `$PITHY_CONFIG_DIR`. It reclaims for the checkout it was run in and no other, so after a wipe a project that has not run yet is not protected by one that has; and pruning cannot separate a deleted checkout from a moved one, so a moved repository frees its blocks until something in it runs again. **`pithy dev` now re-registers on the pinned path too**, which it did not before: the whole reclaim sat on the branch that runs when there is *no* `.dev.config.json`, so a settled project — the only kind that has these blocks to lose — repaired nothing, and only `feature create`/`sync` ever did. It is gap-filling and cannot move a live allocation, and it is best-effort, so a config directory that cannot be written still leaves `pithy dev` starting off its pinned ports. Both windows end at `pithy dev`'s dual-stack port check, which reports a conflict rather than letting two Workers onto one port.
  
  The root key is the **canonical** path, on both sides. Two things derive it — `git rev-parse --git-common-dir` for the registry, `git worktree list` for the worktree lifecycle — and they must produce the same *string*, not merely name the same directory, because `feature create` reserves through one and `destroy` frees through the other: a disagreement is a free that no-ops while still reporting `portsFreed: true`, over a block that then leaks for the life of the machine. They diverge one way per platform. On POSIX, `--git-common-dir` answers `.git` and resolving that against the working directory keeps whatever symlinks were walked to get there, while `worktree list` reports the real path. On **Windows** git emits forward slashes (`C:/code/app`) where `dirname` and `realpath` give backslashes — so canonicalising only the first side would have fixed POSIX and broken Windows, in the worktree case that `feature destroy` always runs from. Both now go through one helper, and a test asserts the equality itself across main checkout, worktree, and symlinked spellings of each, rather than either side's shape. CI is Linux on every job, so nothing else would have caught the Windows half.
  
  **`pithy doctor` prints the resolved path on every run**, on the same rule as the `Secrets:` line: inside the checkout the registry was at least in the file tree you already had open, and here nothing in your project mentions it. It also names a `.dev-ports.json` an older CLI left at your checkout root, because nothing reads that file any more and editing it changes no ports.
  
  No migration. Nothing is published, so no registry a released CLI wrote exists; a stray repo-root file is ignored, and the `.gitignore` line stays so an existing one does not become untracked and unignored at once. The file itself is written at the umask, like `state.json` and every other local-state file — it holds port numbers and paths, not credentials, which is the same decision `.changeset/150-token-mint-writes-owner-only.md` recorded for it under its old name. Its **directory** is another matter: `<config>` is `0700`, because `cloudflare.json` sits directly in it, so creating it goes through the one helper that says so rather than a private `mkdir`. On a new machine the first `pithy dev` can be the first thing to create that directory, and a fourth writer landing it at the umask default is exactly the failure `devSecrets/mode.ts` was written to end.

- [`2337456`](https://github.com/pithy-sh/pithy/commit/2337456baed2faba0372d19d88489eb4ad80254b) Thanks [@kingmesal](https://github.com/kingmesal)! - A workers suite cannot see a Cloudflare credential, and the guard that says so cannot be emptied.
  
  [#198](https://github.com/pithy-sh/pithy/issues/198) stopped unit suites authenticating against a live account, and the fix exempted every `*.workers.test.ts` project on a sound reason: workerd inherits nothing from the host, so there is no ambient token to blank. That answers **inheritance** and says nothing about **declaration**. A `cloudflareTest({ miniflare: { bindings } })` entry writes a host-computed value into workerd's `process.env` by design — five configs use it for `SECRETS_ENCRYPTION_KEYS: devEncryptionKeys()`, a key minted for the test and exactly what bindings are for — and the shape one line over is `CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN`. Nothing refused it. The exemption was a door.
  
  **Two gates close it, and they are halves rather than duplicates.** `vitest.workers.setup.ts` at the repository root runs inside workerd and throws on any Cloudflare credential visible there, whatever put it in — a binding, a future pool option, a harness change nobody read. All seventeen workers projects load it. And `packages/cli/src/ci/testIsolation.test.ts` refuses a workers config that reads `process.env` at all. Neither is redundant: a declaration reading the operator's shell carries nothing on a machine with no token exported, which is every CI runner, so the runtime guard passes a real leak on exactly the machine the gate has to be trusted on. Measured — a planted `process.env.CLOUDFLARE_API_TOKEN ?? ""` ran 166 tests green with no token exported. The scan owns the declaration; the guard owns the runtime.
  
  **The runtime guard reads the bindings, not only `process.env`, because a compatibility flag decided whether those are the same thing.** A declared binding lands in `process.env` only while the config states `compatibilityFlags: ["nodejs_compat"]`. Measured on `@pithy-sh/core`: delete that one line, declare `bindings: { CLOUDFLARE_API_TOKEN: "leaked-nocompat" }`, and the whole set goes green — the scan returns `[]`, the workerd assertions pass, and the credential is fully readable from any test through `env` from `cloudflare:test`. Blindness cannot be detected from inside either: with the flag and without it, `typeof process` is `"object"`, the key set is the same seven, and `process.version` is `"v22.19.0"`. So the guard reads the bindings themselves, where no flag can hide them, and `testIsolation.test.ts` holds every workers config to the flag — a suite exercising a workerd the deployed Worker is not is worth refusing on its own.
  
  **The source scan follows the imports rather than the file name.** Its own docblock rejected a narrower rule as "walked around by a helper that reads the environment one call away", and a rule scoped to `vitest.workers.config.ts` had that hole: all seventeen import `../../vitest.shared`, where an `export const HOST_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? ""` would be invisible and would flow straight into a `bindings` entry. The population is now every repository module a config reaches, transitively — derived by walking relative imports, so the next one is covered by the commit that adds it — and a specifier the walk cannot resolve is reported rather than skipped. The stripper it reads through is string-aware for the same reason: a `//` inside a URL and a `/*` inside a `**/*` glob each forged a comment that blanked a real `process.env` read, and both were silent.
  
  **`visibleCredentialKeys` is the one new export**, on `@pithy-sh/cloudflare`'s `src/env/devVars`. It answers which of `CLOUDFLARE_ENV_KEYS` an environment carries a non-empty value for — non-empty, because `vitest.shared.ts` pins all four to `""` and the CLI's `process.env` overlay already reads a blank as unset. That module imports nothing at all, and now must keep importing nothing: it is bundled into workerd as well as run on the host, so a `node:` import in it breaks seventeen suites at collection.
  
  **The guard is gated on doing something, which for one review it was not.** Every check around it proved seventeen configs cite the file and that the file exists. Replace its body with `export {};` and all of them stay green — 18 passed in the CLI gate, 169 in `@pithy-sh/core`'s workers project — with the whole mechanism retired in silence. That is this repository's named recurring defect one level up from where the change looked for it. So the guard records its scan on `globalThis` and `packages/core/src/worker/envIsolation.workers.test.ts` reads the record back from inside workerd, where the guard runs. The throw is the one clause still held by text, and deliberately: proving it at runtime means putting a live credential into a real workers pool.
  
  **The scaffolded config is scanned too.** `templates/starter/vitest.workers.config.ts` can state neither setup file — both are absolute paths only this checkout has — so it stays out of the walk that loads configs. It does not stay out of the source scan, which names no path and forbids a text. It is the one workers config in this tree that becomes somebody else's code, so a scaffolded `bindings: { CLOUDFLARE_API_TOKEN: … }` would ship from here and reach *their* account.
  
  **Nothing changes for an adopter's own repository.** The scaffold is unchanged, and the guard is a repository-root file that `pithy init` does not copy. What moves in these tarballs is a `setupFiles` line in seventeen `vitest.workers.config.ts` files that pack with their `src`, plus the new function — no runtime code, and nothing an import of `@pithy-sh/<capability>` reaches.

- [`f85db3b`](https://github.com/pithy-sh/pithy/commit/f85db3be3982d38a9aac96389118bf6da4d4a347) Thanks [@kingmesal](https://github.com/kingmesal)! - A Worker can decline an optional binding, and both commands respect it.
  
  Name it in `declinedBindings` in that Worker's `pithy.config.ts`, with the reason. `pithy upgrade` leaves it out of `wrangler.jsonc`; `pithy doctor` reports it as declined and prints the reason back. A stanza deleted by hand stays deleted.
  
  The reason is required. A binding simply absent is indistinguishable from one somebody forgot, which is the state this replaces.
  
  Declining a required binding, a Workflow, or a Durable Object is refused before an upgrade writes anything. A decline naming a binding nothing composes is reported and stays green — `pithy remove` leaves exactly that state.

- [`157bb56`](https://github.com/pithy-sh/pithy/commit/157bb5660cd6429c45d617ae79258b7bbcd872a3) Thanks [@kingmesal](https://github.com/kingmesal)! - Adding a language to email costs no configuration.
  
  **The send Worker is now built with the kit's own email copy rather than sent it.** It is a separate deploy with no request and no access to `pithy.config.ts`, so anything it does not bundle has to be stamped into it as a variable — and the kit's own Spanish was doing exactly that, on every provision run, filling 61% of Cloudflare's 5120-byte per-variable ceiling with data that changes only when the kit releases. Held beside the English it translates, the host is deployed with it and a project that overrides nothing deploys no catalog variable at all.
  
  **What travels is your diff.** Override one `email/` sentence and one sentence travels. Add a locale the kit ships and nothing travels, which is the property that makes adding languages free: the ceiling is no longer reachable by anything the kit writes, only by an override set large enough to outgrow a variable on its own.
  
  **A kit sentence still lives in exactly one place, and which package that is now follows how it reaches a reader.** `@pithy-sh/i18n` keeps what no capability can hold — the error taxonomy, whose domains are not capability names, and the screens, which are copied into an adopter's repository rather than imported. A capability keeps its own domain in every language, which is what `Capability.messages` already meant and what the domain rule already said. It also keeps principle 4 intact in both directions: no capability imports another, which a dependency edge for this data would have broken.

- [`0966b3f`](https://github.com/pithy-sh/pithy/commit/0966b3f01426857b2024662f6e5f98aac4336411) Thanks [@kingmesal](https://github.com/kingmesal)! - A scaffolded project resolves one React.
  
  Nothing under `@pithy-sh/*` is published, so a kit is consumed from a sibling checkout by symlink — and Vite resolves a symlinked package from its realpath, so a kit package importing `react` gets the *kit checkout's* copy. Two copies of React is `invalid hook call` on every kit component the project mounts, and the stack blames the component rather than the resolution.
  
  Two files ship the fix, and they need different mechanisms. The Worker's `vite.config.ts` gets `resolve.dedupe`, which works there because that config's root is the Worker directory, where React is installed. The project's `vitest.config.ts` gets an explicit alias, because `dedupe` resolves from the config's root — the repository root, which in a `pithy init` layout has no React at all. It finds nothing, changes nothing, and says nothing about it, which is the failure that is worst to debug.
  
  Two alias rules per package, an exact one and a prefixed one, or `react-dom` is rewritten through the `react` entry.
  
  A project scaffolded before this gets neither half from a re-run — `pithy init` does not run twice, and `pithy ui add` never overwrites an existing `vite.config.ts`. `docs/UI.md` § One React says which half you are missing and what to paste.
  
  It is not a workaround for the symlink. It is what every linked-package setup needs, and it costs nothing once the kit is published.

- [#456](https://github.com/pithy-sh/pithy/pull/456) [`f4e243d`](https://github.com/pithy-sh/pithy/commit/f4e243d023ff38e02a7958b228c8308b780b42a5) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy feature create` cuts from local `main`, and a failed create can be destroyed.
  
  The base was `origin/main` whenever that ref existed, so a repository holding unpushed work started every
  feature before that work — 159 commits, on the adopter that found it. The symptom was a config error
  naming a field the branch was too old to have, which says nothing about the base; where the older tree
  still loads there is no symptom at all and the branch is simply rooted in the past. It cuts from local
  the local trunk now — named by `origin/HEAD` so a repository whose trunk is `master` is not handed a
  stale local `main` — reports how far behind its remote that trunk is rather than refusing, and falls back
  to `HEAD` where there is no local trunk. The report carries the ref it cut from, and it is null when
  nothing was cut: an attached branch's base is whatever somebody else chose, so the behind-remote line is
  not printed over it.
  
  `pithy feature destroy` no longer needs a Worker config to load. Its local half — free the port block,
  prune the worktree — is derived from the branch and the root config, which is what the state it exists for
  demands: a create that failed partway leaves a worktree whose config throws, and teardown used to throw on
  the same config before reaching it. The block leaked to a branch that no longer existed. The remote half
  still cannot run without those configs, so an unloadable one is refused unless `--local-only` says the
  remote half is not wanted.

- [#457](https://github.com/pithy-sh/pithy/pull/457) [`80aa063`](https://github.com/pithy-sh/pithy/commit/80aa063a2c2a0ca9e86b8649e218f43a6628cccc) Thanks [@kingmesal](https://github.com/kingmesal)! - "Cannot tell" is no longer read as "nothing".
  
  Nine commands built their audit emitter from `resolveWorkers(…).then(projectCapabilities).catch(() => [])`. An empty list means no `audit` capability was found, which is exactly what a project that never composed one looks like. So a single Worker config that would not import — a fresh CI checkout where a capability package did not install — let `pithy deploy --env prod` ship every Worker, print `Done.`, exit 0, and write no row for a project that audits. The module's own standard says why that is the worse outcome: an audit trail you cannot tell is broken is worse than none.
  
  `pithy token` derived credential policy from the same emptied set. `resolveTokenProfiles([])` returns `ci-system` and drops every capability's `ciPermissions`, so `pithy token list` told an operator auditing live credentials that capability-profile tokens do not exist, and `pithy token rotate ci-system prod` minted a replacement carrying only the base permissions before deleting the fully-permissioned one it replaced.
  
  The third state is threaded instead. A project with no Workers is `[]`. A config that will not load is an unknowable set, and it carries the sentence saying which worker and why — so a refusal names the file rather than inventing "a config will not load" for one that is simply absent. `createProjectCliAudit` is the single builder those nine copies collapse into, and an unknowable set produces an emitter that names every event it could not record instead of falling silent.
  
  **The refusal lands only where the answer is load-bearing.** `pithy token mint`, `rotate` and `list` each read the profile registry, and each refuses. `revoke` composes its name from the root config alone, so it still runs — that is the command you reach for during a credential leak, and taking it away because an unrelated Worker's config is broken on this checkout would be the fault `[#454](https://github.com/pithy-sh/pithy/issues/454)` removed, not a new safety.
  
  `pithy add` and `pithy remove` no longer load every Worker's config to write one. `--worker` narrows before the load, so one broken sibling stops disabling the wiring commands for the whole project — including when editing a healthy Worker was the way around the broken one.
  
  And a Worker whose `pithy.config.ts` is absent is reported rather than swallowed. `feature destroy` was handed a set that was incomplete rather than empty: the manifest pass still deleted what it had recorded, the reconcile backstop no longer scanned that Worker's bindings, and those resources leaked while the run exited 0.

- [#460](https://github.com/pithy-sh/pithy/pull/460) [`a9d0368`](https://github.com/pithy-sh/pithy/commit/a9d0368637888d18a136251e41e97de3dd08347b) Thanks [@kingmesal](https://github.com/kingmesal)! - A seed can ask where its own Worker answers.
  
  `SeedPrepareContext` carried `env`, `project`, `secret`, `preferences` and `seeded`, and nothing that said what origin the environment would answer on. So a set that registers something pointing back at the app — a self-connection, a webhook target, an OAuth callback — had nothing to ask, and wrote the address down. The kit's own first adopter did exactly that: `const DEV_ORIGIN = "http://localhost:8787"`, under a comment predicting its own failure.
  
  **The port is allocated, not configured.** Each checkout reserves a block and pins one port per Worker into `.dev.config.json`, which is the whole reason two features can run at once. That makes the literal right in the first checkout on a machine and wrong in every other one — a connection that registers cleanly, pings, and denies every real call. Worse when the first checkout is also running, because then the second one addresses the first one's Worker.
  
  `context.origin` is that address, resolved from the allocation the run was actually given.
  
  **Read back, never recomposed.** `buildDevConfig` mints `http://localhost:<port>` in exactly one place, and the seeder reads that string rather than composing a second one — two rules for one value is how the two disagree later. A test writes a config whose origin and port disagree and fails anything that recomputes it.
  
  **An address, not an identity.** It says where to reach this Worker, on this machine, now. Nothing stored and verified later — an issuer, an audience, a signing scope — may be built from it, because the same project answers on a different origin in every checkout and every environment.
  
  **`null` is an answer.** A clone that has never run `pithy dev`, a Worker added after the block was pinned, or any environment but `dev`: a deployed address is declared rather than allocated, and `pithy env` is what answers it. `resolveWorkerAddress` still returns `null` for `dev` for the same reason in reverse — a localhost URL is not a deployed Worker's address. A set that cannot work without an origin refuses and says so, because an invented one would be indistinguishable from a real one.
  
  The acceptance test drives two real port allocations against one machine-wide registry and asserts the two runs see different origins, each equal to what its own checkout was pinned. No port literal appears in an assertion — a fixture that named one would pass against the defect.

- [#461](https://github.com/pithy-sh/pithy/pull/461) [`067355c`](https://github.com/pithy-sh/pithy/commit/067355c9eb378744ea2f98a368a5f46a07e74fca) Thanks [@kingmesal](https://github.com/kingmesal)! - The documentation is on `pithy.sh/docs`, and the kit now says so.
  
  Every package README is a front door: what it is, `pithy add <name>`, and the link. 3,749 lines became 509. Five documents the site fully carries are retired, and the rest each carry a line naming the page that renders them.
  
  What stays, and why, is now one rule in `CONTRIBUTING.md`. A document a test reads off disk is specification rather than documentation — `docs/CLI.md`, the twenty-six command pages, `docs/NAMING.md`, `docs/I18N.md` — so it does not move. A document something here names reaches an adopter through a config error, so it stays where it is: eight under `docs/` and the per-package pages a manifest, a catalog entry or a source comment sends a reader to. `docs/BRAND.md`, `docs/CONVENTIONS.md` and `docs/STACK.md` are neither, because they are written for a contributor and the site does not render them.
  
  `docs/DEPLOY.md` is the fifth retirement and the only one that was also wrong. It said the scaffold is a single Worker with `wrangler.jsonc` at the root and that deploy falls back to it — but `templates/starter/apps/` is the scaffold and `scaffoldWorker` stamps into `apps/<name>/`, so the fallback it described has no scaffold to catch. Nothing in the repository read it; `docs/commands/deploy.md`, `docs/commands/migrate.md` and `docs/UI.md` linked to it, and all three now point at the site.
  
  The kit also exports what it contains. `docs/catalog.generated.json` names every capability, every command's flags and every error code the kit defines, so the site's docs check reads a value instead of a regular expression over TypeScript — the read that once lost `i18n` to a character class with no digits in it. CI fails on a stale one, because a stale export does not fail the site's check: it passes every page against a kit that has moved.
  
  `globalFlags` names the six flags parsed outside any command's `args` — `--help` and `--version` in both spellings, and the hidden `--pithier` and `--pithiest`. It is composed from the modules that answer them rather than listed, because the hidden pair was missed on the first pass and a list would have gone stale again on the seventh. Hidden from `--help` is not hidden from a docs check: `docs/commands/alias.md` documents both, and an export without them makes a page the kit's own tests pin read as citing flags that do not exist.
  
  `commands[].flags` carries every spelling citty answers to, not only the declared one — the camelCase form of a kebab-case name, and `--no-<name>` on a boolean. Both are citty's own behavior rather than ours, and both were false failures waiting to happen: `docs/commands/ui.md` puts `[--auth | --no-auth]` in its synopsis and `ui.ts`'s own description offers `--no-auth for the bare SPA`, so an export without it reported the most carefully written pages as the wrong ones.

- [#464](https://github.com/pithy-sh/pithy/pull/464) [`51cf9bf`](https://github.com/pithy-sh/pithy/commit/51cf9bf44ba79b705627504713d23b85a38036e9) Thanks [@kingmesal](https://github.com/kingmesal)! - A Worker started by `pithy dev` is told where it itself answers.
  
  `pithy dev` allocates a port block per checkout and pinned the result in `.dev.config.json`, then published every worker's origin to that worker's **siblings** as `<STEM>_ORIGIN` — and never to the worker itself. So the one address a Worker cannot work out had to be written down: `Host` is caller-controlled, so deriving it from a request takes your identity from whoever called you, and a `vars.BASE_URL` in `wrangler.jsonc` is right in the first checkout on a machine and wrong in every other one.
  
  Every wrangler-launched Worker now gets `--var BASE_URL:<its own allocated origin>`, read verbatim from `.dev.config.json` rather than rebuilt from the port. A `--var` beats a config `vars` entry, so a project that already wrote a dev `BASE_URL` down is corrected rather than asked to edit anything. Deployed environments are untouched — `applyDomains` still generates theirs from the `domains` declaration, and nothing here runs outside `dev`.
  
  **What it cost to not have.** `pithy-sh/dashboard#95`. That Worker composes `controlplane`, where `BASE_URL` is the `iss` on every token it signs. A second checkout seeded its self-connection at `http://localhost:8807` — correctly, via `SeedPrepareContext.origin` ([#458](https://github.com/pithy-sh/pithy/issues/458)) — and then signed `iss: http://localhost:8787`, because that is what the file said. `POST /api/control-plane/token` answered 200, `GET /control-plane/manifest` answered 401, and every value that could be inspected in D1 agreed with itself, because the one that disagreed was on the token. The dashboard's rail silently dropped every kind that needs a manifest, which reads as a broken product rather than a misconfigured checkout. This is [#458](https://github.com/pithy-sh/pithy/issues/458) one layer out: the seed could ask, and the Worker registering it still could not.
  
  **A capability host is handed nothing, and that is the interesting case.** A host's `BASE_URL` is the *app's* origin, not its own — it holds no public route, and a verification link it mails has to arrive back at the app. `materializeHostConfigs` already writes that into the host's generated config, so overriding it here would have pointed every callback at the mailer. `<STEM>_ORIGIN` and `BASE_URL` sit two functions apart, look alike, and mean opposite things: one is somewhere to send a request, the other is who you are. Both now say so.

- [`818a596`](https://github.com/pithy-sh/pithy/commit/818a59624d1b2fa4370cd713abb66f3bdbbc746f) Thanks [@kingmesal](https://github.com/kingmesal)! - A Worker launched by a custom `dev.command` is told its own origin too.
  
  The first half of [#462](https://github.com/pithy-sh/pithy/issues/462) handed a Worker its allocated origin as `--var BASE_URL` on the `wrangler dev` argv. That misses every UI-bearing Pithy app, which is most of them: they run through a custom `dev.command` — a Vite dev server, not wrangler — where there is no argv to append to. The Worker that motivated the issue was one of them, so the first half fixed the four workers that were already fine and not the one that was broken.
  
  `@cloudflare/vite-plugin` takes a Worker's `vars` from `wrangler.jsonc` and offers exactly one way in: the `config` customizer. So the value travels in that child's **environment** — `PITHY_WORKER_ORIGIN`, declared in `@pithy-sh/core`'s `worker/identity.ts` beside `ENVIRONMENT_VAR`, because `pithy dev` writes it and `@pithy-sh/vite` reads it and those two packages cannot import each other — and `devWorkerConfig()` turns it into the binding:
  
  ```ts
  cloudflare({ config: devWorkerConfig() })
  ```
  
  `pithy init` scaffolds that line. An existing project adds it once; there is no way around that, because the customizer lives in the adopter's `vite.config.ts` and nothing else can reach the Worker's vars.
  
  **Two carriers, one value.** `ownOriginFor` is what both the argv path and the environment path read, so they cannot drift — and a capability host is exempt from both by one function rather than by a condition repeated at each. Its `BASE_URL` stays the *app's* origin, because a host holds no public route and a verification link it mails has to arrive back at the app.
  
  **Per child, which is why it could not go in the shared table.** `buildWorkerEnv` is built once for every child: `<STEM>_ORIGIN` is the same table of *other people's* addresses for everybody. "Where do I answer" is the one fact that differs per child, so `childEnvFor` adds it to that child's environment and to no one else's.
  
  Outside `pithy dev` the helper contributes nothing and the declared value stands — which is what a deployed environment wants, since `applyDomains` generated it from `domains`. It never invents an origin; it only passes on one that was allocated.
  
  Verified end to end against `pithy-sh/dashboard` in a checkout allocated block index 2: the seed registered the self-connection at `http://localhost:8827`, the Worker minted `iss: http://localhost:8827`, and `GET /control-plane/manifest` answered **200** with the composed capability list. Before this it answered 401.

- [#76](https://github.com/pithy-sh/pithy/pull/76) [`dd224b1`](https://github.com/pithy-sh/pithy/commit/dd224b1aeffcb0bc9b0c105015acc5b460817d94) Thanks [@kingmesal](https://github.com/kingmesal)! - Fix two migration-order collisions that broke `pithy migrate`.
  
  Migration orders must be unique per database. `auth` and `media` both claimed 300, and `rating` and `ledger` both claimed 600 — so `pithy migrate` threw `duplicate migration order` for any project composing either pair. Storing media against an identity is the ordinary case, so the first pair broke most projects that used both.
  
  Media moves to 350, after the auth tables its records reference. Ledger moves to 650. Nothing has been released, so no applied migration key changes.
  
  The reason these survived is that every test composed synthetic capabilities and none composed the real set — the check in `createMigrationRegistry` only fires when a project actually pairs the two. A meta-test now reads every declared order out of the tree and fails on a duplicate within a database, and fails again if a new capability declares an order without registering it.

- [#85](https://github.com/pithy-sh/pithy/pull/85) [`3c8ffb3`](https://github.com/pithy-sh/pithy/commit/3c8ffb30480595354e83447c8dda2e2e9611f4a1) Thanks [@kingmesal](https://github.com/kingmesal)! - `@pithy-sh/wallet` is now `@pithy-sh/ledger`.
  
  A wallet sitting next to a payments capability invites the wrong inference — that a verified purchase tops up the wallet. It does not, and it never will: the two share no seam. `ledger` is what the thing has always been. The README's first line said so, the domain module said so, the migration said so. Only the package name did not.
  
  The rename is total. Package `@pithy-sh/ledger`, capability `ledger`, tables `pithy_ledger_*`, migration namespace `ledger`, error codes `ledger/*`, admin scope `ledger:admin`, routes under `/ledger`. `@pithy-sh/multiplayer`'s wager seam follows: `WalletEffect` is `LedgerEffect`, `applyWalletEffects` is `applyLedgerEffects`. The migration order stays 650 — renumbering a released capability re-runs its migrations, so the constant was renamed, never renumbered.
  
  Two names that stuttered under the new one are resolved. The migration is `ledger_0001_accounts`, named for the tables it creates, composing to `0650_ledger_0001_accounts`. The primitive moves up to `@pithy-sh/ledger/src/ledger` and is `openLedger(env.DB)`, so it no longer collides with the `ledger()` capability factory.
  
  Nothing had been published, so there is no deprecation path and no adopter carrying `pithy_wallet_*` tables. That window closes at the first release; this is the last cheap moment to do it.
  
  **Any database that already ran the old migration needs resetting.** The composed key moved from `0650_wallet_0001_ledger` to `0650_ledger_0001_accounts`, and Kysely refuses to migrate a database whose bookkeeping names a migration the provider no longer offers — `pithy migrate` fails with `corrupted migrations: previously executed migration 0650_wallet_0001_ledger is missing`. Nothing published is affected; what is affected is a dev machine or a preview environment migrated before this landed. Locally, delete the project root's `.wrangler/state` and migrate again — it is dev data, and no `down` exists for a key this branch no longer ships. For a provisioned feature environment, tear it down and re-provision.

- [`353d559`](https://github.com/pithy-sh/pithy/commit/353d559bbbbd9eb5ef85887f4ed52bcc6d501dd9) Thanks [@kingmesal](https://github.com/kingmesal)! - Pithy can cut a release, and a release says whether it mattered.
  
  There was no release process. The root `release` script exited 1, no workflow published anything, and a Changeset carried a semver bump and a summary — neither of which says whether a patch closed a token-reuse hole or fixed a log typo. Both are `patch`, and anyone asking "should I upgrade urgently" had to read every note in between and judge.
  
  `.github/workflows/release.yml` is the pipeline: started by hand, gated on the full suite, versioning through Changesets, publishing over npm trusted publishing with provenance, tagging, and reporting what shipped. `dry_run` versions and prints the plan without publishing anything.
  
  A security-relevant change now says so where it is written — a `Security:` line in the changeset body naming **what the exposure was**, which is a different sentence from the note describing the fix. In the body rather than the frontmatter, because `@changesets/parse` reads every frontmatter key as a package name. Visible on purpose: it flows into `CHANGELOG.md`, so git becomes the durable record once the changeset files are consumed.
  
  Each release emits one record per package, with the version already split into components so a comparison is a column predicate rather than semver logic in SQL. Collected around `changeset version` rather than after it, because that command deletes the files the notes live in. The write to the dashboard is configured and off until the dashboard exists, and it can never fail a release — so `replay` rebuilds the records from the CHANGELOGs and the tags, idempotent and keyed on package and version. Verified against this repository's own 381 changesets: replay reproduces all 22 live records byte for byte.
  
  `bun run release:local` cuts the one release CI cannot: npm attaches a trusted publisher only to a package that already exists, so the first version of each package is published from a laptop under `npm login`'s two-hour session — no stored token, nothing to rotate. It refuses a checkout that is not ready and says every reason at once, and `--dry-run` versions the packages, prints what would ship, and puts the tree back exactly as it was.
  
  Every published package now declares `repository`, without which npm generates no provenance at all — silently, and it also declares `files`. Nothing did before, so `npm publish` took whatever git did not ignore: half of `@pithy-sh/core`'s tarball was its own test files, and `@pithy-sh/payments` shipped 93 of them while declaring a `files` field that listed what to include and never the negation that leaves tests out. Two gates hold it now — one on the manifests, one on the packed artifact, because `files` does not fail on a missing path and a manifest named but absent is a capability `pithy add` cannot see.
  
  **Only `main` can publish, and only the release step holds the key.** An npm trusted publisher matches on repository and workflow filename and has no branch field, while `workflow_dispatch` runs the workflow definition from whichever ref it is pointed at — so anyone able to push a branch could have run a rewritten `release.yml` and published all 22 packages, with genuine provenance making the result look more trustworthy rather than less. A protected `npm-publish` environment pins the ref, and every trusted publisher is registered against it. The gates run in a second job holding `contents: read` and no OIDC, so the publish credential is never in the same process as the test suite.
  
  The spelling gate reaches the prose that ships. `.changeset/*.md` becomes `CHANGELOG.md` inside the tarball, and it was outside the gate's scope — 112 en-GB spellings were queued to reach adopters on the first release. `scripts/` and `.github/` came in with it, the sweep is done, and the boundary that deferred it is gone.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - A dev secrets file that will not parse is its own diagnosis, and doctor says nothing else.
  
  `pithy doctor` already withheld `missing` and `undeclared` on an unparseable file: both are decided against what the file states, and a file that will not parse states nothing. `misplaced` was not withheld, and it is decided the same way — by comparing each `.dev.vars` copy with the envelope the file holds. With no envelope to compare, every copy fell through to `unmoved`, and the report told the adopter to go move pithy's own injected lines.
  
  That is the one action that breaks dev before [#153](https://github.com/pithy-sh/pithy/issues/153) lands, recommended by the same run that had just said the file was broken. Now a project with an unreadable file hears exactly one sentence about it.

- [#188](https://github.com/pithy-sh/pithy/pull/188) [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6) Thanks [@kingmesal](https://github.com/kingmesal)! - The filesystem races Node cannot close are written down, so the next reader finds a decision rather than an oversight.
  
  `docs/ACCEPTED-LIMITS.md` records six of them: the `lstat` → `readlink` window in `resolveWritePath`, the inode check → `rename` window in `ensureUnswapped`, a pre-positioned file we own reaching `adoptableModeOf`, a bind mount that resolves inside the project and carries `removeScaffoldPath` out of it, Windows having no uid to compare, and the source-text half of the tripwires. Each names the function rather than a line, because a line number in a document is wrong by the next commit.
  
  It states the threat model that decides how much they matter — every one needs an attacker who can already write to the project directory, and that attacker already has code execution through `postinstall`, a git hook, or `pithy.config.ts`. The bar these fail is relevance, not severity.
  
  Two blockers were re-checked rather than repeated. Biome does ship `style/noRestrictedImports` and per-path `overrides`, so the tripwires stay a test because the rule is a conjunction Biome cannot express, not because the feature is missing. And `typescript@7.0.2` ships `unstable/ast` and `unstable/sync` — what it has no equivalent of is a string-to-AST parser, which is the thing an AST rule would need.
  
  It also lists what was **not** accepted, with the issue behind each, so the record cannot be read as a shrug.

- [#225](https://github.com/pithy-sh/pithy/pull/225) [`128f0d3`](https://github.com/pithy-sh/pithy/commit/128f0d32907cbcc3856c38dc4b2d590e1423b156) Thanks [@kingmesal](https://github.com/kingmesal)! - Twenty refusals named a remedy their `catch` could not know.
  
  [#207](https://github.com/pithy-sh/pithy/issues/207) fixed one: a `pithy.config.ts` that would not load told every adopter to run `bun install`, whether the failure was a missing dependency or a stray brace. The survey it asked for found twenty more of the same shape — a `catch` reachable by more than one underlying failure, whose `action` names one specific remedy. A wrong action is worse than no action, because it is followed.
  
  Fourteen were the identical line in seven capability loaders: several `import()` calls in one `try`, and `action` was always ``Run `pithy add <cap>` ``. That is wrong precisely when the capability **is** installed and one of its own transitive dependencies is not — [#207](https://github.com/pithy-sh/pithy/issues/207)'s bug, one level down the graph. `classifyCapabilityLoadFailure` now decides between the capability being absent, a dependency of it being absent, the package being present and broken, and not knowing — and the last of those names no remedy at all.
  
  The other six each answered their own way. `pithy feature`'s registry and manifest readers said *check permissions* for every errno that is not `ENOENT`, including a directory sitting where the file belongs. `resolvePortsRegistryPath` said *run pithy from inside a git repository* to a machine with no `git` on `PATH`. `pithy ui`'s `package.json` reader and `pithy add --eject`'s manifest reader each wrapped a read and a parse in one `try` and asserted absence — `pithy ui` also merged into whatever parsed, so a `package.json` holding `[]` would have been written back as an array with dependencies hung off it. The dashboard client answered a timeout, a DNS failure, a refused port, an expired certificate, a 401 and a 500 with *check the dashboard origin with --origin*. `@pithy-sh/vite`'s config loader carried [#207](https://github.com/pithy-sh/pithy/issues/207)'s defect verbatim and now classifies the same four ways.
  
  Everything that reads a cause is duck-typed. The `bin` ships on Bun, whose `ResolveMessage` and `BuildMessage` are not `instanceof Error`, and vitest runs on Node — so an `instanceof` gate passes the whole suite and drops the parser's sentence on the only runtime adopters use. That is how [#207](https://github.com/pithy-sh/pithy/issues/207) shipped its first implementation, and it is why the classifiers are exported and tested directly against both runtimes' real shapes.
  
  The rule is written down in `docs/CONVENTIONS.md`: **if a `catch` can be reached by more than one underlying failure, `action` may not name a single specific remedy.** Classify, or hedge. `capabilities/manifests.ts` worked that out first and left it in a comment in one file, where it stayed. Twenty is why it is a convention now and not a twenty-first patch.

- [#232](https://github.com/pithy-sh/pithy/pull/232) [`67d2cc4`](https://github.com/pithy-sh/pithy/commit/67d2cc4633f0fd66e328092e2aabce1dead48713) Thanks [@kingmesal](https://github.com/kingmesal)! - A `pithy.config.ts` with two syntax errors stops classifying worse than one ([#223](https://github.com/pithy-sh/pithy/issues/223)).
  
  [#207](https://github.com/pithy-sh/pithy/issues/207) taught a config that will not load to name its own cause: a missing dependency says `bun install`, a
  stray brace says where the file is broken. It worked for a file with **one** diagnostic. Bun hands one
  diagnostic over bare and **two or more inside an `AggregateError`**, and a stray brace cascades — a single
  missing `}` produced four — so the shape [#207](https://github.com/pithy-sh/pithy/issues/207) fixed is the rarer one. The wrapper's `Object.keys` is empty
  and its message is `4 errors building "<path>"`, which matched nothing the classifier looks for, so the
  commonest syntax error in the world fell through to *the config threw while loading, run the file
  directly*. The line and column were in hand and thrown away.
  
  ```
  Before:  The config threw while loading. Run the file directly to see what it throws.
  After:   The config does not parse: Expected identifier but found ";". Line 4, column 1.
           Fix the file — installing dependencies will not help.
  ```
  
  **The second import of the same broken file is a different error again**, and that one is what
  `pithy doctor` renders. Bun caches a failed module and re-throws the wrapper with its `errors` gone —
  count and path, nothing else — so unwrapping cannot help, and `doctor` loads the root config twice by
  design, because resolving the project's Cloudflare account ([#206](https://github.com/pithy-sh/pithy/issues/206)) reads it before the report does. The
  wrapper's own message is enough to know a build ran and produced diagnostics, so it is named a parse error
  with no reason and no position rather than mis-blamed on the config's runtime. Nothing else degrades this
  way: a `ResolveMessage`, a bare `BuildMessage` and a config's own `Error` are identical on every import.
  
  `@pithy-sh/core` gains `src/error/cause.ts` — `rootCause`, `isBuildFailureWrapper`, and the duck-typed
  `prop` both are built on. Three classifiers read this failure (`cli`'s `classifyConfigLoadFailure` and
  `classifyCapabilityLoadFailure`, and `vite`'s `classifyWorkerConfigFailure`, which restates the first
  because the plugin must not depend on the CLI), and all three had got the same runtime wrong. What they
  share now is **what Bun does to an error on its way out** — a fact none of them can derive locally, and
  the only part they cannot be allowed to disagree about. The refusals stay their own; they are not the same
  sentence and never were. `@pithy-sh/vite` still depends on `@pithy-sh/core` alone.
  
  Nothing an adopter can read changed shape at the boundary [#207](https://github.com/pithy-sh/pithy/issues/207) drew: `message` is still exactly
  `Could not load <path>.`, and `action` still carries no newline, no ANSI escape, no stack frame and no
  absolute path — asserted per cause, wrapper included, because a build diagnostic is a multi-line colored
  box quoting the file.
  
  [#207](https://github.com/pithy-sh/pithy/issues/207) survived its own Bun testing because the repro used one deliberate typo. The suite now spawns Bun,
  imports a config missing one brace, and asserts the wrapper it really gets — twice, so both shapes are
  pinned. A Bun that stops wrapping fails that test instead of silently restoring this bug.

- [#225](https://github.com/pithy-sh/pithy/pull/225) [`128f0d3`](https://github.com/pithy-sh/pithy/commit/128f0d32907cbcc3856c38dc4b2d590e1423b156) Thanks [@kingmesal](https://github.com/kingmesal)! - The source walker can be told to enter a dotted directory, and the license audit's reach is checkable.
  
  `sourcePaths` skips dotted directories, and that rule is what keeps `.smoke-*`, `.e2e-*` and `.worktrees/` out of every tripwire in this repository. It had no opt-out, and `keep` narrows which *files* are taken while nothing widened which *directories* are entered. `dotted: true` is that opt-in — **off by default, so every existing caller keeps the rule protecting it**, and it widens the dotted rule and nothing else: dependencies, build output, the caller's own `skip`, the vendored `packages/cli/templates` copy and a symlinked directory are all still refused with it on.
  
  That matters for the shape of question the license audit asks. It is not asking about this tree's source; it is asking whether every file a template *ships* carries the right header, and a template that grew a `.vscode/`, a `.husky/` or a `.github/` would ship every file in it unchecked while the audit reported clean. No template holds a dotted directory today — two dotted files, which were never affected — so this is latent rather than live, and it is the shape this repository keeps producing: a gate whose reach is narrower than the rule it enforces.
  
  **Both walks in `tooling/license-headers` do enter one, and now something says so.** `audit.test.ts` plants a stamped file inside `packages/ui-react/templates/.vscode/` and `templates/starter/.husky/deep/` and requires both reported as `unexpected-header`; a second plants an unheadered `packages/core/src/.generated/client.ts` and requires `missing-header`; `workspace.test.ts` asserts the same reach directly. Each fails if either walk starts skipping a dotted directory. Without that, the next narrowing is invisible again.
  
  **One reason in the exception list is corrected, and this time it leaves.** [#202](https://github.com/pithy-sh/pithy/issues/202) said `audit.ts` could not use the shared walker because of the `templates` skip; [#211](https://github.com/pithy-sh/pithy/issues/211) checked that and found it false — the primitive skips `packages/cli/templates` by path and nothing else, and that path is a byte-for-byte copy existing only between `prepack` and `postpack`. [#211](https://github.com/pithy-sh/pithy/issues/211) recorded the real blocker, the dotted-directory skip, and it is closed here. What keeps that walk separate now is direction alone, the same reason as its neighbor: `tooling/license-headers` is the gate that stamps `packages/cli`'s own headers and it runs in `lint-staged` on every commit, so making the linter a dependent of the largest thing it lints points the graph backwards.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - A file cannot carry a character review is unable to see.
  
  [#216](https://github.com/pithy-sh/pithy/issues/216) gated the one class of invisible character git itself notices: a byte that makes a file binary, so
  its diff never renders. This is the other class — characters git renders perfectly happily, and a
  reviewer still cannot see. **No committed file may hold a bidirectional control, or a C0 control other
  than tab, newline and carriage return.**
  
  **U+202E is why it is worth a gate.** A right-to-left override reorders how the text after it *displays*
  without changing a byte of what the compiler reads — the Trojan Source technique (CVE-2021-42574).
  Source that says one thing to a human and another to `tsc`. This repository is the right kind of target:
  the kit is MIT and public, adopters run `pithy` against their own Cloudflare accounts, and the CLI mints
  and reads credentials. An override landing in a template, a generated config line or a capability
  manifest would be invisible in exactly the review that is supposed to catch it. The bidi set is the one
  rustc's `text_direction_codepoint_in_literal` lint uses: U+202A–U+202E, U+2066–U+2069, U+200E, U+200F,
  U+061C.
  
  **The first run found ten, across five files, and only two were meant.** The override and the BEL in
  `packages/testers/src/nudge/copy.test.ts` are deliberate input to the suite that proves hostile control
  characters never reach a nudge body — the right thing to test, and the two occurrences [#221](https://github.com/pithy-sh/pithy/issues/221) was filed
  on. The other eight were a raw ESC nobody intended: seven in an esbuild error fixture copied between
  three packages, and **one in shipped source.** `@pithy-sh/vite`'s ANSI-stripping regex held the byte
  where two other copies of the same pattern spelled the escape — drift, in a filter, that no review could
  have seen. [#228](https://github.com/pithy-sh/pithy/issues/228) consolidated the three copies into `@pithy-sh/core` and took it with them.
  
  That is the argument, no longer hypothetical: **the repository had no way to tell the deliberate two
  from the accidental eight.** It is [#216](https://github.com/pithy-sh/pithy/issues/216)'s argument about a NUL, which found two more the moment it
  looked.
  
  `copy.test.ts` keeps its coverage and builds both characters — `String.fromCharCode(0x202e)` — exactly
  as [#216](https://github.com/pithy-sh/pithy/issues/216)'s gate builds its NUL. The input is byte-identical; only the spelling changed.
  
  **The scan reads the whole file, and the file set is git's index**, for [#216](https://github.com/pithy-sh/pithy/issues/216)'s reasons. The first one
  matters more here: git decides binary from the first 8000 bytes, so a gate that asks git turns itself
  off as a file grows, and there is nothing about an override that confines it to a file's first page.
  
  The exception list is empty and should stay that way: a file that needs one of these as input builds it.
  Seven ESC bytes across three test fixtures are written down as debt instead, each with what it costs,
  on a list that only shrinks and that fails if a path on it is quietly fixed or deleted.
  
  Proved by planting: an override and a raw ESC in a committed file each fail the gate with the path and
  the byte offset. Every refused character is a number in the gate, and constructed where one is needed —
  writing a test about an override is the easiest way to put one in the test file, and unlike a NUL, one
  that landed there would reorder the line a reviewer was reading it in.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy email provision` half-configured mail routing and reported success.
  
  Inbound routing was wired only when all three of `--routing-zone`, `--inbound-address` and `--app-worker` were present. With one or two it set nothing and carried on — no refusal, no warning, exit 0. Two flags of three looks like success, and nobody discovers otherwise until somebody replies to a message and the mail goes nowhere.
  
  It refuses now, naming the flags that are missing, and it refuses *first* — before the project name, the credentials, and every Cloudflare call, so a typo costs nothing and provisions nothing. `pithy support` has made this decision correctly all along; this is one command adopting its sibling's rule.
  
  `pithy testers` swallowed loader failures. `buildEnqueue` and the provisioner's sending-identity block both ended in a bare `catch { … undefined }`, so an `@pithy-sh/email` that was installed and broken was indistinguishable from one that was absent: the run reported `sends: false` and printed *"no email capability is configured in this project"* about a capability the adopter had installed. That sentence is right for one of the four failures the catch admitted and wrong for the three that mean the package is right there — a dependency that will not resolve, an export map that does not, and source that will not parse.
  
  Both now go through `classifyCapabilityLoadFailure`, per `docs/CONVENTIONS.md` §Refusals. Absent is still the quiet answer, because email really is optional to a roster run; everything else refuses and says which it was. The classifier is exercised as a pure function against both Node's and Bun's cause shapes, since the `bin` runs on Bun and Bun's resolver errors are not `instanceof Error`.

- [#188](https://github.com/pithy-sh/pithy/pull/188) [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6) Thanks [@kingmesal](https://github.com/kingmesal)! - The gates that assert about other packages' files run on the PRs that change those files.
  
  `--affected` maps a changed file to its owning package and that package's dependents. That is the
  whole model, and a test asserting about **another** package's files is invisible to it.
  `packages/cli` is no dependent of `packages/leaderboard`, so editing
  `packages/leaderboard/pithy.manifest.json` planned `leaderboard, multiplayer` — measured, `count: 2`
  — and the sweep in `capabilities/reconcile.test.ts` holding every shipped manifest default to 120
  columns did not run on the change it exists to gate. Green, and unverified.
  
  That is the second time this shape landed. [#148](https://github.com/pithy-sh/pithy/issues/148) was the same defect on `templates/starter`, closed by
  hardcoding `^templates/` in the workflow, and this one was found on the branch that closed it — a
  hand-maintained list being another place to forget is not a hypothetical here, it is the history.
  
  So nothing is hardcoded now. `.github/scripts/crossPackageReads.ts` derives the mapping from the
  tests themselves on every run: it resolves the relative-path literals in each package's test files
  and keeps the ones landing outside the package that owns them. Eight paths, one package, no list —
  `packages/leaderboard/pithy.manifest.json` now plans `cli, leaderboard, multiplayer`, and
  `templates/starter/pithy.config.ts` still plans `cli`. A read added tomorrow is planned tomorrow.
  
  The resolved path has to exist on disk, which is the rule separating a path a test reads from one it
  rejects: `testers/src/crypto/token.test.ts` feeds `"../../../etc/passwd"` to a traversal guard as
  hostile input and never opens it.
  
  Not turbo's own knobs, and this was measured on turbo 2.10.7 rather than assumed.
  `inputs: ["$TURBO_ROOT$/packages/*/pithy.manifest.json"]` on the CLI's `test:node` leaves the
  affected set byte-identical — `--affected` never reads task inputs. `globalDependencies` does reach
  the change mapper, but only for files no package owns: `templates/**` there works and escalates to
  all 23 packages, while `packages/*/pithy.manifest.json` is ignored outright because those files
  already have an owner. Turbo has no way to say "this path belongs to that package's tests".
  
  `packages/cli/src/ci/crossPackageReads.test.ts` holds the derivation to a written-down set of paths,
  so the next cross-package read is added by someone who meant to.

- [#225](https://github.com/pithy-sh/pithy/pull/225) [`128f0d3`](https://github.com/pithy-sh/pithy/commit/128f0d32907cbcc3856c38dc4b2d590e1423b156) Thanks [@kingmesal](https://github.com/kingmesal)! - Both scripts CI plans with are type-checked, and the constraint that keeps them runnable is asserted.
  
  `.github/scripts/` was covered by no `tsconfig`, so `turbo run typecheck` checked neither
  `planShards.ts` nor `crossPackageReads.ts`. Biome parsed them and CI ran them; nothing looked at a type.
  That was thin cover while both imported two `node:` builtins each, and [#211](https://github.com/pithy-sh/pithy/issues/211) ended it by giving
  `planShards.ts` an import **across the tree** into `packages/cli/src/ci/sourceFiles.ts` — a module three
  issues have now changed. The failure mode is specific: a rename there breaks the planner, and nothing
  says so until the `plan` job fails. That is the job which decides which tests run, and a gate that
  cannot be planned is a gate that does not run ([#148](https://github.com/pithy-sh/pithy/issues/148), [#173](https://github.com/pithy-sh/pithy/issues/173)).
  
  They are a fourth program in `packages/cli` now — `tsconfig.ciScripts.json`, alongside the second and
  third that exist for the same reason. **It lives there rather than at the repo root because this
  repository installs isolated rather than hoisted**: the root `node_modules` holds seven entries and
  neither `typescript` nor `@types/node` is among them, so a `tsconfig` in `.github/` would resolve its
  compiler and its `node` types from nowhere. `packages/cli` is where both are, and it is the package the
  scripts reach into, so the program that checks the import owns the module being imported.
  
  A deliberate type error in each script fails `turbo run typecheck`, and so does an arity change on the
  symbol `planShards.ts` imports across the tree — which is the acceptance criterion this exists for.
  
  **One seam had to be closed with it.** A turbo task's default inputs are the files in its own package,
  so editing `.github/scripts/planShards.ts` alone would have hit a cached `typecheck` and reported a pass
  on source it never compiled. `@pithy-sh/cli#typecheck` names those files as extra inputs. Measured both
  ways on turbo 2.10.7: with the entry, a byte changed in `planShards.ts` moves the task hash; without it,
  the hash is identical.
  
  **The program must not license an import the `plan` job cannot have.** That job runs before
  `bun install`, deliberately — a dry run reads the workspace manifests and nothing else — so the scripts
  may import builtins and relative paths and nothing else. A type check resolves a bare specifier through
  `node_modules` perfectly happily, which is exactly how a green typecheck could hand CI a script that
  throws before it plans anything. So the closure is asserted rather than assumed: every module reachable
  from either entry point, every specifier in each of the four spellings that reach a module, and the
  graph written down as well as derived. Three modules, five distinct specifiers, no bare one. Adding
  `import { z } from "zod"` to `planShards.ts` fails it by name.

- [#261](https://github.com/pithy-sh/pithy/pull/261) [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c) Thanks [@kingmesal](https://github.com/kingmesal)! - The binary and invisible-character gates see a file before it is committed.
  
  Both scanned `git ls-files`, which reads the index — so a file that exists and has never been `git add`ed was invisible to them. The pre-commit hook runs Biome on staged files rather than the suite, so the first scan that could see a new file was the one *after* the commit that tracked it. That is how a NUL byte reached `main` once already: not because the rule was wrong, but because the set it was quantified over did not yet hold the file.
  
  The listing now adds `--others --exclude-standard`. Everything `.gitignore` covers stays out, so this repository's own scaffolded fixtures are not findings, and what is left is a file somebody wrote and means to commit — which is the file the rule is about.

- [#195](https://github.com/pithy-sh/pithy/pull/195) [`10c65c5`](https://github.com/pithy-sh/pithy/commit/10c65c5be50dfec0c9f3d838fbed7e2b17c08319) Thanks [@kingmesal](https://github.com/kingmesal)! - `docs/CLI.md` describes the CLI that exists, and something fails when it stops.
  
  Three passages still described the `.dev.vars` symlink that [#154](https://github.com/pithy-sh/pithy/issues/154) removed: a shared file at the project root, a link into each `apps/<worker>/`, `pithy dev` re-making the links every run, and `pithy feature sync --skip-data` reconciling them. None of it exists. Each Worker's `.dev.vars` is generated from the machine-local sources — `dev.json`'s bootstrap values, then the root `.dev.vars.local`, then that Worker's own — so there is no link to wire, dangle, delete or detach, `pithy init` writes no `.dev.vars` at all, and `feature sync` touches none. An adopter reading those sections went looking for links that were not there.
  
  `pithy feature sync --help` stops promising something the command does not do. Its summary offered "ports, dev.vars, migrate + seed" and `--skip-data` offered to "Reconcile ports and dev.vars only" — both written before [#154](https://github.com/pithy-sh/pithy/issues/154), and both false since. `feature sync` touches no `.dev.vars` at all; each Worker's is generated by `pithy dev` from sources already on the machine. The two strings now say ports, and a developer whose bindings are missing is no longer sent to the command least able to help.
  
  `pithy doctor`'s `Secrets:` line names `pithy secrets edit` as well as the path. That file is outside the checkout, which is the point of it — and which means no editor's file tree reaches it and no `ls` in the project finds it. The line was the one place the toolchain named the path, and naming a path is not yet offering a way to open it. The same rule the `Alias:` line already follows.
  
  Two blocks that arrived undocumented are documented: `doctor`'s `manifests:` section under Project health, and the `manifestFaults` field `pithy add --list --json` and `pithy upgrade --json` both carry. `doctor`'s whole `--json` payload is specified now, having never been.
  
  Three of those four gaps landed within a week of each other with every documentation pin green, because the pins held the transcripts that existed rather than requiring one per feature. Three gates now ask the wider question, each derived from the code rather than from a list: every block label the renderer can print is named in §5.6, §5.6's `--json` sample carries exactly the keys the payload does, and every `--json` field of every command §5.7 specifies is named there. A payload assembled by spreading a typed object stays out of reach of the last one — no key is visible where it is written — and the gate says so rather than reporting a pass over what it could not read.

- [`79edd0a`](https://github.com/pithy-sh/pithy/commit/79edd0a88584a7ba005b7008282fc49a2107efd3) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy token mint`/`rotate` now honor every repeated `--permission` flag (citty kept only the last, silently dropping the rest). `pithy remove` prints honest guidance for leftover tables — naming the `pithy_<cap>_*` tables to drop and pointing at `--drop` for next time.

- [#220](https://github.com/pithy-sh/pithy/pull/220) [`b37e6c2`](https://github.com/pithy-sh/pithy/commit/b37e6c2ed52a8d1c506393977b06de6027fade36) Thanks [@kingmesal](https://github.com/kingmesal)! - A project name is validated where it becomes a path segment, not at every call site that happens to have normalized it.
  
  `devSecretsDir` and `devPreferencesPath` joined a project name into `<config>/<project>/` with the rule that the name was safe to put in a path living at each caller. **Nothing was broken**: every caller passes a name already through `requireProjectName` or `kebab`. This is the step that keeps it that way.
  
  That is the [#183](https://github.com/pithy-sh/pithy/issues/183) shape — [#171](https://github.com/pithy-sh/pithy/issues/171) narrowed a manifest's default values, [#174](https://github.com/pithy-sh/pithy/issues/174) an option's key and describe, [#183](https://github.com/pithy-sh/pithy/issues/183) the capability's own name: three rounds for one rule that was never stated where it belonged. And the reason each caller here is safe is that it *happens* to have normalized earlier, which is a property of the call graph. [#206](https://github.com/pithy-sh/pithy/issues/206) added a caller to this family within a day of the last one.
  
  Worth closing while it is theoretical because of what that directory now holds: `secrets.jsonc`, `dev.json`, `tokens.json`, and since [#206](https://github.com/pithy-sh/pithy/issues/206) the account-scoped credentials beside it. The gates that guard project writes do not reach it — `ensureScaffoldPath` guards writes *inside a project*, and this path is outside every checkout. There is no second line of defense.
  
  Both functions now resolve through one door, `projectConfigDir`, which validates in two halves because a name arrives two ways ([#206](https://github.com/pithy-sh/pithy/issues/206)'s phrasing). `assertValidProjectName` is read *after* kebabbing, deliberately: `Acme Corp` is a legal project name because it becomes `acme-corp`. So it is a statement about the slug, not about the string in hand — `My/Project` passes it whole, and joined verbatim it is two path segments. The second half is that the value **is** its own normalized form, so the typed name and the slug are held to one rule instead of the rule being true of only one of them.
  
  A gate states the invariant: **no config string is joined into the config directory without passing a validator**. It is stated about the segment rather than as a list of the two joiners known today, since enumerating is what produced the second and third instance of every other class of this here. What it carries instead is a list of *validators*, each with the argument that it is one — a list that grows when somebody makes a new kind of string safe, not when somebody writes a new join.

- [`309a384`](https://github.com/pithy-sh/pithy/commit/309a38476c57f4d33e01f67cc08f06436bf292e2) Thanks [@kingmesal](https://github.com/kingmesal)! - New in `@pithy-sh/core`: a two-mode `Logger`. Mode one unifies local CLI and Worker diagnostics — human-readable, or `--json` for agents. Mode two emits structured, request-correlated records with Cloudflare Workers Logs on by default and a tail/Logpush hook. Capabilities resolve `c.var.log` instead of calling `console`, and the `@pithy-sh/audit` recorder now logs through it.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - A dev secret is delivered to the Worker, or the run says it was not.
  
  `writeDevVars` became the one writer so a value could not be quoted wrong or land in a file nothing opens. It still had three ways of not arriving, and all three were silent.
  
  **A feature worktree got nothing.** `pithy feature create` and `pithy worker add` build one shared `.dev.vars` for the whole repo: the worktree root and every worker inside it are symlinks at the main checkout's file. The atomic write renamed a new file over the root's link — cutting the worktree off the shared file — and left every worker pointing at the untouched original. Verified against a real worktree: `pithy feature create`, seed, then `wrangler dev`, and the Worker served the superseded secret while the result read `written: ["auth-session-secret"], shadowed: []`. The write now follows the link to the file it names, and each worker's link is resolved and compared against the file that was written. Same worktree, same command: the Worker serves the new value and the sharing survives.
  
  **A failed `symlink()` was swallowed** and the directory counted as linked regardless — a delivery that did not happen, reported as one. It is now named, with the reason, in `undelivered`, which `pithy dev`, `pithy add` and `pithy seed` all print.
  
  **A refusal is fail-closed.** A value no quoting survives used to leave the superseded line in `.dev.vars` — the only place dev reads until [#153](https://github.com/pithy-sh/pithy/issues/153) — so the Worker kept signing with the old secret while every report said the value was replaced. The stale line goes with the refusal, and the refusal says so. A Worker that will not start beats one quietly running on a secret nobody thinks is current.
  
  And the encoder's own tests never ran through the writer, so reintroducing the exact truncation left the whole suite green. Every hostile value is now round-tripped through `writeDevVars` and read back out of the file.
  
  The raw `upsertDevVars` — unquoted, at whatever path, delivering to nobody — is deleted. It was the obvious thing the next producer would reach for, and it had no callers left.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - Every dev secret is encoded for `.dev.vars`, and reaches the Worker that reads it.
  
  wrangler parses `.dev.vars` with dotenv, whose unquoted grammar ends at the first `#`. A value with one
  in it was truncated silently and failed at the first request looking present. And the line was written
  to the project root, which `pithy dev` never gives the Worker: wrangler runs in `apps/<worker>` and
  reads the file beside its own config. One writer now does both, verified against wrangler's own parser.

- [#232](https://github.com/pithy-sh/pithy/pull/232) [`67d2cc4`](https://github.com/pithy-sh/pithy/commit/67d2cc4633f0fd66e328092e2aabce1dead48713) Thanks [@kingmesal](https://github.com/kingmesal)! - The CLI reference is one page per command, and the gate that holds a page to the payload it documents now reads every one of them ([#223](https://github.com/pithy-sh/pithy/issues/223)).
  
  `docs/CLI.md` was 1577 lines organized by topic, and a handful of commands had a section at all. Nineteen commands were specified nowhere, which is a strange state for a reference about to be published. So the document splits: `docs/CLI.md` keeps what every command shares — the command shape, the flag conventions, the alias, the output styling, the help text, the update notifier — and indexes twenty-five pages under `docs/commands/`, one per command, each carrying the same six sections.
  
  Nothing was rewritten to get there. The four sections that already existed — `doctor`, `dev`, `ui`, `seed` — moved with every transcript byte for byte, because those transcripts are pinned and the pins are what makes them trustworthy. A pointer sits where each section was, so the thirty-odd citations of `docs/CLI.md §5.6` and `§6.2` in this repo's own source still land somewhere true.
  
  **The gate is the point of the exercise.** [#186](https://github.com/pithy-sh/pithy/issues/186) held a section to naming every `--json` key of the commands it specified, and enrollment was the mechanism: a section that documented a payload had to document all of it, and a command nobody had written about was free. That property survives the split with a filename in place of a sentence. A command page that specifies `--json` names every key written at that command's call sites; a command with no page was not failed by it, right up until the last page landed — and now that they all have, `every command has a page` is a check rather than an intention.
  
  What the scan cannot read is named rather than implied. Thirty of sixty-five `formatJsonLine` sites build their payload by spreading a typed object, where no key exists at the call site; four commands pass something the object pattern cannot parse at all; three write nothing it can read. Those three lists are asserted against the scan itself, so the honesty cannot decay into a stale paragraph — a command that changes shape fails until the list agrees with it again.
  
  It found one thing on the way in. `pithy seed --json` writes `formatJsonLine({ ...report, devSecrets })`, and `devSecrets` had never been documented — nor pinned, because the pin rendered `{ ...report }` and compared that, so the one key written outside the report was the one key neither the doc nor its test could see. The sample carries it now, and so does the pin.

- [#188](https://github.com/pithy-sh/pithy/pull/188) [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy doctor` prints the `Secrets:` line on every run, terse report included.
  
  The line sat inside the block the terse report suppresses, so a healthy project never saw it — while three comments, `docs/CLI.md`, and [#156](https://github.com/pithy-sh/pithy/issues/156)'s own acceptance criterion all said it printed always. It is the one line in the report that nothing else can tell you: since [#156](https://github.com/pithy-sh/pithy/issues/156) the dev secrets file lives outside every checkout, nothing in the project names it, and `ls` will not find it. A report that omits it leaves an adopter with no way to find the file at all, and "where is it" is not a complaint for the terse report to swallow.
  
  It also carries the only rename trail. `devSecretsFile` is deliberately not a term in the terse predicate, so a project whose *only* anomaly is a renamed or duplicated config directory renders terse — and the trail was unreachable in exactly the case it was written for.
  
  The line's content is now built once and rendered twice: padded beside `Config dir:` and `State file:` in the verbose report, and on its own — same position, unpadded, nothing to align against — in the terse one. `docs/CLI.md`'s terse transcript prints it too, still pinned to the renderer by `doctorDocs.test.ts`.

- [#220](https://github.com/pithy-sh/pithy/pull/220) [`b37e6c2`](https://github.com/pithy-sh/pithy/commit/b37e6c2ed52a8d1c506393977b06de6027fade36) Thanks [@kingmesal](https://github.com/kingmesal)! - One unreadable rc file no longer costs the whole `pithy doctor` report.
  
  `doctor` read the shell rc file with no catch, so a `~/.bashrc` with the wrong mode, a dangling symlink, or an `EIO` threw out of `buildDoctorReport` and took **everything** with it: Cloudflare reachability, the secrets paths, project health, dev secrets. The least important line in the report cost every other line. [#203](https://github.com/pithy-sh/pithy/issues/203) made that failure legible — a `PithyError` naming the file rather than a bare `EACCES` — and it was still a failure.
  
  Catching it to `false` is not the fix, which is why [#203](https://github.com/pithy-sh/pithy/issues/203) stopped where it did. `Alias: not installed` about a file nothing could read is a lie, and the adopter's next move on reading it is `pithy alias`, which fails on the same file. So the field is tri-state, and the third state names the file:
  
  ```
  Alias: unknown — can't read ~/.bashrc. Fix that first; `pithy alias` reads the same file.
  ```
  
  It keeps the report verbose, because "I could not check" is worth the ink, and it never fails the exit — toolchain state does not. In `--json`, `alias` is an object rather than a string: `state` (`installed`, `not-installed`, `unknown`), `rcPath`, and `reason` — the refusal's own sentence, and never a byte of the file's contents, since an rc file is where a developer keeps `export GITHUB_TOKEN=…`.
  
  The rule this restores is written in `doctor`'s own source, and the rc read was the one place it was not held: **a diagnostic has to work in the environment it diagnoses.** Every other read in the command already degrades. The one remaining exposure was not a read at all — `doctor` *writes* its notifier cache, and a config directory that will not take a write is exactly the machine somebody runs `doctor` on. That write is bookkeeping for the next run and is now discarded on failure like everything else. Every other file the report touches was made unreadable in turn against a real scaffold, and the report still renders.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy doctor` describes the dev-secrets transition instead of arguing with it.
  
  It named every `d1` secret in `.dev.vars` and said "Delete that line" — including the copies pithy
  writes itself on every `pithy dev`, and deleting one is what breaks dev until [#153](https://github.com/pithy-sh/pithy/issues/153). The three cases are
  now told apart by comparing the copy with what the seeder would write.

- [#191](https://github.com/pithy-sh/pithy/pull/191) [`16163db`](https://github.com/pithy-sh/pithy/commit/16163dbc7ef1e4a2f01410edc94253f406fcd503) Thanks [@kingmesal](https://github.com/kingmesal)! - `ensureOurs` argues from arrangements that still exist. Two of its three did not.
  
  The docstring justified following a symlink at all with three worked examples. Two of them described a repository that is gone: `apps/<worker>/.dev.vars` as a link to a shared project file, and a worktree's root `.dev.vars` as a link to the main checkout's, made by `scripts/worktree.ts`. [#154](https://github.com/pithy-sh/pithy/issues/154) replaced the first with generation and removed the second, along with the `vars:local` task the same paragraph cited. Nothing in this repository creates a symlink now.
  
  A correct rule arguing from cases a reader cannot find is how a correct rule comes to look unjustified, and gets weakened by someone tidying up. So the citations are replaced, not the rule.
  
  What replaces them is stronger than the examples were. Because the kit makes no links at all, every link the walk can meet is the adopter's own — beside a planted one that is indistinguishable from it by destination. There is no arrangement of ours left to recognize by shape. And location cannot classify either: the writes that land in `<config>/<project>/` are outside every checkout by design ([#156](https://github.com/pithy-sh/pithy/issues/156)), so there is no project root available to contain to, and one that existed would refuse the adopter's link along with the planted one.
  
  [#146](https://github.com/pithy-sh/pithy/issues/146) stays, as what it is — the failure a rename over a link produces, which is why the choice is follow or refuse and never replace. A citation of a fixed defect does not rot the way a citation of a live arrangement does. `resolveWritePath`'s `apps/` reference ([#147](https://github.com/pithy-sh/pithy/issues/147)) is the same kind, and stays for the same reason.
  
  The same two citations had five producers, not one, so all five are fixed rather than the first. `atomic.test.ts` argued the containment rule from `scripts/worktree.ts` in three comments; `project/devVars.ts` described writing "through the shared file's symlink". Fixing one and filing the rest is the enumerating habit that gave this class six producers already.
  
  **Two of the five were not stale prose but instructions that fail when followed.** `packages/cloudflare/README.md` and `packages/storage/README.md` told a reader to run `bun run vars:local` before the live suites. That task was deleted with everything else in [#154](https://github.com/pithy-sh/pithy/issues/154) — it is in no `package.json` and in no `turbo.jsonc`, so the documented first step exits non-zero. Both now say what actually supplies credentials: `packages/cloudflare/.dev.vars`, a real file nothing creates, with `process.env` overlaid per key for whatever it does not set. Neither `pithy dev` nor `pithy seed` fills that gap — `apps/` is the registry, so generation reaches an adopter's Workers and never a kit package.
  
  The storage README carried a second error the first one hid, and it named the wrong package. Its live suites take credentials from `loadIntegrationCreds` in `@pithy-sh/cloudflare`, and that reads the `.dev.vars` beside *itself* — so a file in `packages/storage/` is read by nothing, whatever put it there. Anyone who followed the old step and wrote one got no error saying so, just a suite that skipped for want of credentials it was standing next to. The section now names `packages/cloudflare/.dev.vars`, and the harness says the same thing at the line that computes the path.
  
  No behavior change. The ownership rule, its two accepted limits, and every test assertion are untouched; `docs/ACCEPTED-LIMITS.md` remains where the limits are argued.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy feature sync --json` reports one `data` field where it reported `migrated` and `seeded`.
  
  Both came from one boolean — the `--skip-data` flag — so they could never disagree. Every consumer's `if (migrated && !seeded)` was a branch that could never fire and could never be tested, and if the two steps were ever split that dead branch would silently become live with whatever meaning the split invented. One flag, one field.
  
  `migrated` was also already taken. On `pithy upgrade` it means the narrower "the migration step ran", so `feature sync` spending it on "migrated *and* seeded" was itself a shared key with two meanings — the defect [#231](https://github.com/pithy-sh/pithy/issues/231) is about. It is no longer shared: the CLI's `--json` vocabulary gate records it against `upgrade` alone.
  
  Two facts that can differ was not on offer either. Both steps throw on failure, so any run that reaches the payload ran both or neither.
  
  `feature.create` and `feature.provision` **drop the pair rather than emit a constant.** Neither has a flag that can skip the steps and both steps throw, so a report existing at all was already the proof they ran; `migrated: true, seeded: true` was a constant with the grammar of a fact. If either ever grows a `--skip-data` of its own, `sync`'s `data` is the field to copy — a value that can be `false` is the only kind worth emitting.
  
  `docs/commands/feature.md`'s three `--json` tables say so, held to the code by the gate that fails a payload changed without its page.

- [#213](https://github.com/pithy-sh/pithy/pull/213) [`0ff0cd5`](https://github.com/pithy-sh/pithy/commit/0ff0cd54cb926a015b3bac7383976a36729788d4) Thanks [@kingmesal](https://github.com/kingmesal)! - The ENOENT gate's two known gaps are closed, and its remaining limit is a number rather than a sentence ([#204](https://github.com/pithy-sh/pithy/issues/204)).
  
  **A read the scan could not see.** `project/envInventory.ts` spelled out an `ENOENT` branch for a read it
  performs through `readWranglerConfig`. The branch was correct — it rethrew — and invisible to the gate,
  which recognizes the leaf calls that hand bytes back and knows nothing about who wraps them.
  `readWranglerConfig` reads through `readOptionalFile` now, which puts the wrapper inside the rule instead
  of outside it, and `envInventory` asks for the answer rather than deriving it from an errno. Nineteen
  modules read a `wrangler.jsonc` through that wrapper; all nineteen get a `PithyError` naming the file
  where they used to get node's raw error, and `readOptionalWranglerConfig` is the one that answers `null`
  for an absent file so `pithy env` can carry on with the other Workers.
  
  **The general question, answered.** Seventy-four exported functions across sixty modules perform a content
  read and forty modules call one, so a read behind a wrapper is the ordinary case here. But the population
  that takes either rule's shape is nine call sites, eight of them `wrangler.jsonc` reads, seven of those on
  read-only `doctor` and `deploy` surfaces the discard rule is scoped away from on purpose. Two remain —
  both in `capabilities/reconcile.ts`, already declared for its own `readFile`. Teaching the gate to resolve
  wrappers means a whole-tree symbol pass living inside a test to find one site that was already correct and
  one module already on the list. It is not worth it, that is written down in the gate rather than left to
  be rediscovered, and the count is what will say when the answer changes.
  
  **The last path from "the read succeeded" to "empty base".** `readManifestDocument` returned `{}` when
  `pithy.worker.jsonc` parsed to something that was not an object, and the next write rebuilt the file from
  it. `null` walked straight through the `typeof value === "object"` check written to stop it, an array
  passed and then lost every key `stringify` drops off one, and comment-json boxes a top-level scalar so a
  file holding `"react"` was an `"object"` too. Absent is `{}`; present-but-not-a-document is a refusal
  naming the file and the shape found in it, never a byte of what it holds.

- [#54](https://github.com/pithy-sh/pithy/pull/54) [`1c01950`](https://github.com/pithy-sh/pithy/commit/1c01950be691b196fde6c8265eba42f88dbf7635) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy` now writes `wrangler.jsonc` and `.dev.vars` atomically and through one shared helper, so a crash mid-write can't corrupt them and config formatting stays consistent across commands.

- [#220](https://github.com/pithy-sh/pithy/pull/220) [`b37e6c2`](https://github.com/pithy-sh/pithy/commit/b37e6c2ed52a8d1c506393977b06de6027fade36) Thanks [@kingmesal](https://github.com/kingmesal)! - A config that will not load names its own cause, instead of guessing one.
  
  A `pithy.config.ts` that would not import produced one sentence whatever went wrong: `Could not load <path>.` plus *"Install the project's dependencies (e.g. bun install), then check the config for errors."* A missing dependency and a stray brace were byte-identical. The real reason — the `SyntaxError`, or the specifier that did not resolve — was captured into `detail`, and the CLI renderer never prints `detail`.
  
  That is worse than silence, because the advice is followed. `bun install` cannot fix a stray brace. The adopter runs it, nothing changes, and the parser's own message was discarded one frame up. [#172](https://github.com/pithy-sh/pithy/issues/172) was this same defect wearing a different hat: a config that would not load naming the wrong cause, misdiagnosed twice before anyone traced the import edge. It was fixed as a bug in one barrel; it was also a bug in how a config-load failure is reported, and only the first half was fixed.
  
  The failure is now classified, and the `action` chosen from it rather than asserted over it. An unresolved import names the specifier and says to install, which is where `bun install` was always right. A parse error gives the parser's own reason and its position, and says installing will not help. A config that throws while loading says what it threw. A cause that matches none of them gets **no** remedy at all — a wrong action is worse than no action.
  
  The security boundary is unchanged and now tested. `message` stays exactly `Could not load <path>.`, and nothing from the throw site reaches `action` either: the cause's message is used only when the whole of it is one short line with no absolute path and no stack frame, which is what separates `Expected identifier but found "{"` from the multi-line ANSI box that quotes the file and its source. Everything dropped is still in `detail`, where the renderer cannot print it and the HTTP codec strips it.
  
  `classifyConfigLoadFailure` is exported and tested directly, because `bin` runs on Bun and the suite runs on Node. Bun's `ResolveMessage` and `BuildMessage` are not `instanceof Error` — an earlier draft gated on that, passed its whole suite against `Error`-based fixtures, and silently dropped the parser's sentence on the only runtime that ships.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - A `--json` key means one thing across the CLI, every payload names the command that wrote it, and a gate keeps it that way.
  
  `pithy upgrade --json` dropped `deployedAs` on a real run. `ReconcilePlan` carried it, `ReconcileApplied` did not, and both come back in the same `workers` array with `dryRun` saying which — so a consumer that read the deployed script name worked under `--dry-run` and read `undefined` on the run that actually wrote something. The applied entry carries it now.
  
  `pithy alias --json` lost its `action` key on the unknown-shell path — the one path where nothing was written to any file, and so the one a caller most needs to classify. Every alias payload leads with `command` and `action` now; `alias` was also the only command in the CLI whose payload never named itself.
  
  The durable part is the gate. Every documented payload names its `command`, and every top-level key more than one command emits is enrolled in a shared vocabulary asserted equal to the pages in both directions. A scan cannot read meaning, and the wording of two pages that agree is free to differ, so the gate does not pretend to compare sentences — it makes a shared name impossible to introduce silently. A key a second command starts using fails until someone writes it down beside the command that already had it, which is the comparison that was never being made. Proven by planting a collision, rather than asserted.
  
  `pithy doctor --json` is the one payload still not naming its command, listed and asserted rather than excused, so closing it fails the gate until the list shrinks with it.

- [`5d69fb5`](https://github.com/pithy-sh/pithy/commit/5d69fb57c06d6a8d28a2bce43ccc3cf6e0c04097) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/leaderboard` — rank your players on your own Cloudflare account. Submit a score, read the standings, read your own rank, daily through all-time. One store, always: D1. There is no engine flag, because a Durable Object bills rows exactly as D1 does, adds request and duration billing D1 lacks, and is single-threaded with the same 10 GB cap — so it fixes neither cost nor hot-board serialization. Scale is a cadence dial, and the dial is pure D1. A board definition is the unit of config: `direction` (immutable), `aggregation` (`best` | `latest` | `sum`), and an optional CRON `window`. Retention defaults to keep-all — storage is never the cost driver, so nothing is deleted unless a board sets `retain` (keep the newest N closed windows, a product limit) or `retainDays` (delete data older than N days, a compliance limit); the two are mutually exclusive per board. CRON rather than a fixed enum is what makes calendar months and years expressible — Apple caps recurrence at 30 fixed days and Google ships no monthly at all. Entries are keyed `(board, window, player)`, so each window carries its own aggregation state. Ties break by earliest `achievedAt` then `userId`, making the ordering total — so dense-vs-competition ranking never arises and neither is implemented. `rank: "live"` is the default: correct, no moving parts, and $0 under ~10k players; `rank: { materialize: <cron> }` stores the rank and refreshes it in keyset-walked chunks bounded by D1's 100-bound-parameter cap and 30-second query limit, which is the documented path past ~100k players. The refresh runs as a cron-triggered Cloudflare Workflow that checkpoints the keyset cursor per batch — a board of any size ranks across as many durable steps as it needs and resumes from the last checkpoint on a crash, so there is no per-run entry ceiling. It needs a cron trigger but not a dedicated worker; it can be folded into the app worker, and stays inside Cloudflare's free Workflow allowances at any realistic cadence (all state is D1, awaiting steps burn no CPU). A D1 advisory lock (`pithy_leaderboard_locks`) serializes refreshes: if a cron fires again while one is still running, the second instance cannot take the lock and skips, so two passes never interleave their chunked writes into an incoherent rank set; a crashed instance's lock ages out and is reclaimed by the next fire. Ranking uses no window functions — `RANK() OVER` is undocumented on D1, and a Miniflare pass is not evidence about production — and a query-plan test reads D1's own `EXPLAIN QUERY PLAN` to prove the ranking index is chosen. Writes are server-authoritative by default, inverting the vendor norm: a submission needs the board's submit scope and carries a score and nothing else, with the player from the AuthContext seam and the timestamp from the server. Per-board `min`/`max` bounds, player-controlled visibility, and a moderator hide/remove API are the anti-cheat baseline; friends/segment views and tiers are dimensions over the same store, not second boards. Read-your-own-writes rides the D1 Sessions API on an `x-pithy-d1-bookmark` header, so replication lag never hides a player's own submission. Editing a board's immutable fields after entries exist fails with `leaderboard/board_immutable` rather than silently reinterpreting stored scores. Each board carries an immutable `store` discriminant (`"d1"` today, enforced by the same drift guard as direction/aggregation/window) so a future column-oriented, approximate board type can be added per board without disturbing exact D1 ranking. A per-board `trackActivity` flag (default off) guards non-improving `best` submissions to zero rows written — the capability's largest cost lever, since submission writes dominate the bill; setting it true keeps `submittedAt` a true last-seen timestamp at full write cost. The entries table uses a plain `INTEGER PRIMARY KEY` rather than `AUTOINCREMENT`, measured to save a `sqlite_sequence` write on every upsert and keep guarded no-ops truly free. Both submission writes and the materialize refresh write are priced from D1's own `meta.rows_written` (a submission writes 2, a rank-only refresh 1), and the board drift guard re-reads the winning record on the first-submission path so a divergent definition cannot slip through a concurrent insert. Every route declares a verification strategy and is auth-gated; runtime throws `leaderboard/*` errors. Ships a reproducible, test-pinned cost model (`bun run --filter @pithy-sh/leaderboard costs`) whose write figures are measured against D1's own `meta.rows_written`, `docs/costs.md`, and the vendor comparison at pithy.sh/docs/capabilities/leaderboard/differentiation — an honest cross-vendor price comparison (the free platform SDKs and PlayFab are cheaper; the trade is cross-platform reach and adopter-owned data). Licensed MIT.
  
  `@pithy-sh/core` gains the six `leaderboard/*` members of the `ErrorPayload` union. `@pithy-sh/cli` corrects the leaderboard catalog rationale.

- [`d60788a`](https://github.com/pithy-sh/pithy/commit/d60788ac98e4317368156bdac438cebd621788a2) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/ledger` — a per-user balance ledger for whatever an app's economy runs on (chips, gold, gems, credits), currency-agnostic, in your own D1. Correctness is enforced by the database, not by hopeful application code: every movement is a single `DB.batch` (atomic — the ledger entry and the balance change commit together or not at all), idempotent on a caller-supplied `ref` written as a `UNIQUE` row (a payout delivered twice pays once), and overdraft-safe by a `CHECK (balance >= 0 AND held >= 0 AND held <= balance)` on the account (a debit or hold past solvency aborts its transaction, even against a balance a concurrent operation just lowered — no race slips past SQLite). Statements are built with Kysely (so `CamelCasePlugin` owns the columns and reads go through the codecs) and compiled into the batch. Operations are credit, debit, atomic transfer, and the wagering primitives — hold (reserve a stake), release (return it), capture (spend it) — which is what makes betting safe, so it pairs with `@pithy-sh/multiplayer`. Amounts are integers in the currency's minor unit, never floats. It takes no position on whether the units map to money, or the regulation that implies — that is the adopter's. A thin HTTP surface lets players read their own balance and history; moving another player's funds is server-authoritative and needs the `ledger:admin` scope. `core` gains the `ledger/*` error codes; the CLI adds it to the capability catalog. Licensed MIT.

- [#188](https://github.com/pithy-sh/pithy/pull/188) [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6) Thanks [@kingmesal](https://github.com/kingmesal)! - The rest of the line a manifest writes into a generated config.
  
  [#171](https://github.com/pithy-sh/pithy/issues/171) narrowed what a manifest may state as an option's **value**, so the renderer could only be handed shapes it prints the way Biome would. It left the option's `key` and its `describe` as `z.string().min(1)`, and both are interpolated raw into the TypeScript `pithy add` and `pithy upgrade` write. `renderConfigValue` guarded the keys of a *nested* object and threw; the line's own key had no guard at all.
  
  The schema parsed every one of these and the renderer emitted every one of them: `content-type` became `content-type: "x",`, which is not TypeScript — Biome answers with three parse errors. So did `a"b`, `1`, `a b`, and `}) ; evil(`. A `describe` carrying a newline put its second line into `pithy.config.ts` as bare code; one with trailing whitespace failed `biome format`.
  
  This is not only a formatting bug. A manifest is read from `node_modules/@pithy-sh/<cap>/pithy.manifest.json` — third-party data — and an option key is that data interpolated unescaped into generated source. `}) ; evil(` is the shape that makes the point. Nothing shipped today carries such a key: all 15 manifests and their 40 options are bare, so this was latent, and it predates [#171](https://github.com/pithy-sh/pithy/issues/171).
  
  `ConfigOption.key` is now a bare identifier and `ConfigOption.describe` is one line with no trailing whitespace — [#171](https://github.com/pithy-sh/pithy/issues/171)'s own argument applied to the rest of the line. The refusal names the manifest and the option: `@pithy-sh/audit ships a malformed pithy.manifest.json: configOptions[1].key — A config option key must be a bare identifier, and "content-type" is not`. `renderConfigOptionLine` refuses the same keys, because `--set` reaches it without passing through a manifest.
  
  The comment above the line had two producers, which is how the line below it came to have two in the first place. `renderConfigOptionComment` is now that one function, and `pithy add` and `pithy upgrade` both call it. `MissingConfigKey` stops copying the manifest's contract for `key` and `describe` and refers to it, as its `default` already did.
  
  Every boundary here was measured by running Biome, not guessed. A line terminator ends a `//` comment and trailing whitespace fails the formatter; leading whitespace, an interior tab, non-ASCII, `${x}` and a comment of any length do not. A test renders both lines for every option in every manifest the repo ships into a real scaffold and runs that scaffold's own `biome check` over the result, with a control that proves the gate bites.

- [#191](https://github.com/pithy-sh/pithy/pull/191) [`16163db`](https://github.com/pithy-sh/pithy/commit/16163dbc7ef1e4a2f01410edc94253f406fcd503) Thanks [@kingmesal](https://github.com/kingmesal)! - A capability that is installed and broken no longer disappears without a word.
  
  `availableManifests` caught every failure from loading a manifest and skipped the package. The catch is there to skip packages that ship no manifest, which is ordinary — `@pithy-sh/cli` is not a capability. It also swallowed a manifest that **is** there and is **invalid**, so a schema refusal made the capability vanish from `pithy add --list`, `pithy upgrade` and `pithy doctor` with nothing said anywhere. The three commands an adopter runs *because* something is missing were the three that stayed silent.
  
  Missing and invalid are different answers and this code gave them the same one. Only `ENOENT` is a silent skip now. A parse failure, a schema refusal, or a file that will not open is reported, naming the package and the reason — and the reason is the schema's own refusal text, so it reads the same as `loadManifest`'s on the direct path.
  
  Each caller reports it the way it reports: `pithy add --list` names the package on stderr and still prints the other fifteen entries, because one broken package must not cost the listing; `pithy upgrade` prints a warning above the Workers, since manifests install once at the project root and belong to no Worker; `pithy doctor` carries a `manifests` check in `Project health` that fails the exit, so CI gates on it. `--json` carries `manifestFaults` on both commands.
  
  `loadManifest` had the same shape on its own path: every read failure became "No capability named X is installed", which for an unreadable file sends the adopter to `pithy add` — the command that has just declined to run. It now tells the two apart.
  
  Third instance of this defect. `readDevVarsSource` read every errno on `.dev.vars` as absence, and `readDevJson` did the same for `dev.json`; both now say only `ENOENT` means gone. Tests cover missing, unparseable, schema-invalid and unreadable separately, because they were one case in the code.

- [#191](https://github.com/pithy-sh/pithy/pull/191) [`16163db`](https://github.com/pithy-sh/pithy/commit/16163dbc7ef1e4a2f01410edc94253f406fcd503) Thanks [@kingmesal](https://github.com/kingmesal)! - A capability's own name and package, and the rule that stops the fourth one.
  
  [#171](https://github.com/pithy-sh/pithy/issues/171) narrowed a manifest option's **value**. [#174](https://github.com/pithy-sh/pithy/issues/174) narrowed its **key** and its **describe**. Neither touched the capability's own `name`, which reaches generated TypeScript twice — the import binding and the registration call — or its `package`, which reaches the import specifier. Both were still `z.string().min(1)`.
  
  Reproduced with the real CLI. A manifest declaring `"name": "audit }) ; evil("` was accepted, and `pithy add audit` wrote
  
  ```ts
  import { audit }) ; evil( } from "@pithy-sh/audit/src/index";
      audit }) ; evil((),
  ```
  
  then reported `Done.` A `"package": "@pithy-sh/audit/src/index\"; evil(); //"` closed the quoted specifier and appended a statement, and reported `Done.` too. A manifest is third-party data read from `node_modules`; this is that data interpolated unescaped into a file the adopter's own `bun run lint`, `tsc` and runtime all read.
  
  `CapabilityManifest.name` is now a bare identifier and `package` an npm package name. `peerCapabilities` and `optionalCapabilities` are held to the same rule as `name`, because that is what they are. The refusal names the manifest and the field, as [#174](https://github.com/pithy-sh/pithy/issues/174)'s does: `@pithy-sh/audit ships a malformed pithy.manifest.json: name — A capability name must be a bare identifier, and "audit }) ; evil(" is not`.
  
  The two lines have producers now, as the option's two lines got in [#174](https://github.com/pithy-sh/pithy/issues/174): `renderCapabilityImport` and `renderCapabilityRegistration` in `@pithy-sh/core`, total over what the schema parses. `pithy add` writes both through them; `pithy upgrade` writes the registration head through the second when it converts a one-liner into a block, which was the third place the name was interpolated by hand.
  
  **The part that matters is the gate.** Three rounds, three fields, one rule that kept living at the call site that had just been fixed — so the rule is stated at the schema and enforced by a test that walks it: every string a manifest may state carries a pattern or a refinement, or it is named in `NEVER_RENDERED` with the reason no generated file can carry it. A string field added to `CapabilityManifest` with neither fails the build on the commit that adds it, whatever it is called. Deny by default, because enumerating the fields known at the time is exactly what produced the first two misses. A second test renders the **whole** config `pithy add` would write for every capability the repo ships — imports, registrations, option lines — and puts it through a real scaffold's own `biome check`, with a control that proves the gate bites.
  
  Every consumer of `name` was checked under the narrowed type. The catalog now has a test that every built-in entry states a name and a package the manifest schema would accept, since a mismatch there would read as "not installed" forever. `pithy add --eject` builds its fork directory from the name, so the names that could escape `./capabilities/` are exactly the names the schema now refuses. `remove`'s test fixtures go through `parse` rather than a cast.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - The last reader that cast now checks, and a write that writes nothing stops refusing ([#222](https://github.com/pithy-sh/pithy/issues/222)).
  
  **`readManifestDocument` validates instead of asserting.** `ui/workerUi.ts` was [#204](https://github.com/pithy-sh/pithy/issues/204)'s original instance and the one reader in this family that could take the merge-base read and did not. It refused on a parse failure and then *cast* to `ManifestDocument` — a type claiming `dev` and `ui` are objects — so a `pithy.worker.jsonc` whose `ui` is the string `"react"` reached the merge as if valid and `stringify` renamed the result over the adopter's file. A cast is the assertion no test can fail. It takes the read now, and the cast is a schema.
  
  Two things came with that. `readMergeBase` grew one seam — **which parser turns the bytes into a value** — because `JSON.parse` cannot read a manifest with a comment in it, and that is a property of the file rather than a decision about what a failure means. The four refusals and the dropped parser error are unchanged by it. And the manifest's schema validates *without rebuilding*: comment-json hangs the file's notes off the object as symbol-keyed properties, and every Zod object schema constructs a new object from the keys it validated, so parsing rather than checking would have traded the cast for a quieter version of the same loss — every comment in the manifest gone at the next write.
  
  **No refusal quotes a line of any of these files.** `detail` may name a path, an errno, a shape or the key path that failed; neither `message` nor `detail` carries a byte of what was in the file. This reader used to put comment-json's own message straight into `detail`, and comment-json quotes the line it choked on exactly as `JSON.parse` does.
  
  **A write that writes nothing now reads like the report it is.** `writeBootstrapVars(dir, {})` and `removeBootstrapVars(dir, [])` read a merge base and could refuse although they wrote nothing — reached by `writeDevVars({ values: {} })` in the turnstile teardown, where it turns a regeneration into a failure over a file the run was never going to touch. The split in that module is by *power*, not by file, so the early return moves ahead of the read and the set it answers is `readBootstrapVars`'s. `removeBootstrapVars` keeps its strict read for every non-empty `names`, and that is the same rule rather than an exception to it: the early return belongs before the read exactly when the caller's own arguments settle whether anything is written, and "that name is not in the file" is a claim about contents that a file nothing could read does not support.

- [#225](https://github.com/pithy-sh/pithy/pull/225) [`128f0d3`](https://github.com/pithy-sh/pithy/commit/128f0d32907cbcc3856c38dc4b2d590e1423b156) Thanks [@kingmesal](https://github.com/kingmesal)! - A merge base is now known-good, not merely non-throwing.
  
  [#209](https://github.com/pithy-sh/pithy/issues/209) closed one of the three ways a credential file could be read as `{}` and written over: a `tokens.json` or `dev.json` that parsed to something which is not a record. Two were left, and the likelier of them was left wide. **A file that will not parse** — `{ not json`, a stray brace after someone opened the file to look at what was in it — read as an empty document, and the next `writeMintedToken` renamed one environment's token over three. **A record that fails its schema** — `{"dev":{"CF_TOKEN":12345}}`, `{"vars":{"K":7}}` — did the same. `tokens.json` is keyed by environment and `dev.json` has other tenants, so what a write replaced was other people's live Cloudflare credentials and a developer's dev-login preference, with the run reporting a clean write.
  
  Both were pinned by reader assertions, deliberately. `readBootstrapVars` argues the case at length — *"every failure is an empty set, and that is deliberate here where it is a defect elsewhere"* — because nothing is rewritten from that call and a hand-edited preferences file must not stop `pithy dev`. **That argument is sound, and it is about that call rather than about the file.** It was being read as if it belonged to the file, which is how the reader and the writer came to be the same function.
  
  So this is a split rather than a tightening. `readMergeBase`, beside `readOptionalFile` and `requireRecord` in the module that already owns *what did this read mean*, refuses in every state but one: unopenable, not JSON, parsed-but-not-a-record, and parsed-but-not-this-document are four refusals, each in the calling file's own words and error class. **Absent is the only state that licenses starting from empty**, and what "empty" is belongs to the schema. The lenient reads keep answering `{}` exactly where they did: `readMintedTokens` for a reporting read that rewrites nothing, `readBootstrapVars` for the generation `pithy dev` starts through.
  
  **The lenient read cannot be reached by a writer, and that is a type rather than a sentence.** All five instances of this defect happened the same way — a call site picked the lenient one of two and nothing said so until a file had been replaced — so a rule in a docstring is precisely what they all had. `readMergeBase` hands back a `MergeBase`: the document and the file it came from, which only that function mints. Every merge takes one, and every write goes back to `base.path` rather than to a path derived a second time. A writer handed a reader's `{}` is a compile error at the merge instead of a replaced credential file at the rename, and the gate for that is in `readOptionalFile.test.ts`.
  
  The parser's own error is dropped rather than carried, which is the one place in that module a cause is deliberately lost. `JSON.parse` puts the offending text in its message — `Unexpected token 'n', "{ not json" is not valid JSON` — and every file this was written for is credentials. A refusal names the path, and where a schema broke it names the key path and never the value on it.

- [`532e438`](https://github.com/pithy-sh/pithy/commit/532e4381fe863d723734cb16841411d5d7541c52) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/multiplayer` — authoritative, turn-based multiplayer sessions on your own Cloudflare account, and Pithy's first Durable Object. The one thing a relay cannot do: the server holds game state no client can be trusted with, resolves it, and writes a durable result to your D1. A session is game-agnostic — membership bound to an authenticated user (never client-asserted), a lifecycle, hidden per-player state, an alarm-driven deadline (never a timer, so the object hibernates between turns), the WebSocket Hibernation API, and a one-way publish of results to `@pithy-sh/leaderboard`. What a game *is* lives behind a `GameModel` seam resolved from a registry by `kind`. On top of it, three reusable pattern helpers own the lifecycle plumbing — `simultaneous` (collect one hidden submission per player, resolve together), `turnBased` (turn order and advancement), and `wageringTable` (a persistent casino table's bet book, holds, and settlement) — and three example games ship layered on them: `battle` (secret simultaneous moves; an offense scores unless any opponent blocked it, a duel or an N-player free-for-all), `connect-n` (tic-tac-toe, Connect Four, gomoku in one config), and `craps` (pass/don't-pass/field, come-out and point phases, shooter rotation). Adopters register their own game the same way. It also provides a wagering stack: provably-fair randomness (a per-session crypto seed committed by SHA-256 up front and revealed at the end, feeding a deterministic dice/shuffle stream the DO advances and persists — an auditor can replay every roll); a persistent `table` mode where players buy in and cash out between rounds; and a wager seam where a pure model *declares* ledger effects (hold a stake, capture a loss, credit a win) that the DO settles through `@pithy-sh/ledger` before the state commits, so a stake a player cannot cover rejects the action and a deterministic model's stable refs make a replay pay once. It is not rooms, chat, presence, or real-time action netcode — Cloudflare's PartyServer ships those. `core` gains a `durable_object` binding type and the `multiplayer/*` error codes; the CLI wires the DO namespace binding and its `new_sqlite_classes` class-migration tag into `wrangler.jsonc` for every environment on `pithy add multiplayer`, and reverses both on remove. Licensed MIT.

- [#188](https://github.com/pithy-sh/pithy/pull/188) [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6) Thanks [@kingmesal](https://github.com/kingmesal)! - Multiplayer's config loads outside workerd, and every capability's entry point is held to it.
  
  `@pithy-sh/multiplayer/src/index` re-exported the `MultiplayerSession` Durable Object, and the routes imported two constants out of that same module — so the entry point an adopter's `pithy.config.ts` imports dragged `cloudflare:workers` in and threw everywhere but workerd. `pithy upgrade --dry-run` on any project composing multiplayer died with "Could not load pithy.config.ts", naming the wrong cause ([#172](https://github.com/pithy-sh/pithy/issues/172)).
  
  The factory and the Durable Object are two things with two runtimes, and they are now two entry points. `multiplayer()` and its config come from `@pithy-sh/multiplayer/src/index`; the class comes from `@pithy-sh/multiplayer/src/session/durableObject`, which is where the manifest's scaffold step already told adopters to export it from. The header and RPC sentinel both sides share moved to a pure `session/protocol` module. A worker that re-exported the class from `src/index` re-points that one line at the deep path.
  
  The invariant is a gate, not a fixed bug: `configEntrypoints.test.ts` imports every cataloged capability's entry point in its own Node process and requires it to resolve. It names no forbidden module — it performs the import — so the next entry point that reaches for a runtime-only one fails in CI rather than in an adopter's CLI.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - No credential-resolving parameter in the CLI is optional any more. `OPTIONAL_ACCOUNT_OWED` is empty.
  
  [#226](https://github.com/pithy-sh/pithy/issues/226) made `buildEnvInventory`'s `account` required and left a written inventory of the rest: five more declarations that could be omitted, each with what making it required would cost. This is that inventory, emptied.
  
  `MigrationFanOutOptions`, `DropCapabilityOptions`, `SeedDriverOptions` and `AddBootstrapOptions` take a required account now, and so does `probeAccountEvidence` — which was the worst of the five and the least visible. It took the account as a **default parameter**, `= null`, so the `null` was written at the declaration and every call site said nothing at all. The verdict that path can reach is `orphaned`: *"this live database is not yours."* A project naming `cloudflare.accountName` had its resources looked for in the default account, found none, and fed that absence to a deduction whose worst answer is a confident sentence about somebody else's production database. Wrong credentials that refuse are a bad afternoon; wrong credentials that answer are what this parameter now makes unwritable.
  
  Two seams carried no account at all, so plumbing came before threading. `SeedProjectOptions` has one, so `seedProject` can hand it to the driver that opens a real D1 and a real R2. `dashboard/registry.ts`'s `OpenDriver` has one, so `openConnectionRegistry` can name an account — a `--env staging` lookup opens the app database over REST, and it was opening it against whichever file the machine defaulted to.
  
  Everything downstream follows: `pithy add`, `pithy remove --drop`, `pithy seed`, `pithy dashboard`, `pithy upgrade --migrate`, `pithy doctor`'s health and project-name checks, and all three `pithy feature` paths resolve the account their own project names. `feature create`, `provision` and `sync` read it from the **worktree's** root config, beside the project name they already read there, because the branch is what decides both.
  
  Verified with two accounts on one machine — `cloudflare.alpha.json`, `cloudflare.beta.json`, an unnamed `cloudflare.json`, and a hostile `CLOUDFLARE_ACCOUNT_ID` exported throughout. Each project's commands reach its own account and no other; a project naming none gets the unnamed file; and a pinned `cloudflare.accountId` the credentials contradict refuses with no network call made.
  
  **`pithy doctor` refuses that mismatch without exiting.** `cloudflareEnv` throws on it, which is right for a command resolving its own credentials — but a diagnostic that dies on the fault it exists to report tells nobody anything. So the probe keeps the refusal and drops the throw: no account is asked, nothing is established, and the verdict stays on the local deduction and out of reach of `orphaned`. The mismatch is already a line of the same report, and one fact belongs in one line.
  
  `cloudflare/accountArgument.test.ts` gains the other half of its gate. The walk can only fail an account that is *optional*; a declaration deleted or moved leaves it nothing to find, which is the quietest possible revert. Every module that reached required is now pinned by name, asserted in both directions.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - A malformed the dev secrets file no longer prints its own contents.
  
  `comment-json` embeds the entire source in its `SyntaxError.message`. The write path re-parsed with a
  bare `parse` and no catch, so one missing brace put every value in the file on the terminal. Every parse
  in the module now raises the loader's sanitized error — a path, a line, a column, and nothing else.

- [#220](https://github.com/pithy-sh/pithy/pull/220) [`b37e6c2`](https://github.com/pithy-sh/pithy/commit/b37e6c2ed52a8d1c506393977b06de6027fade36) Thanks [@kingmesal](https://github.com/kingmesal)! - A credential file that parsed to something other than a document is refused, not used as an empty base.
  
  `readMintedTokens` answered `{}` for a `tokens.json` that parsed to `null`, a string, a number, a boolean or an array, and `writeMintedToken` used that same reader as its merge base. `readDevJson` did the same for `dev.json`, and `writeBootstrapVars` and `removeBootstrapVars` wrote over it. In both cases one malformed top-level value turned the next write into a replacement: `tokens.json` is keyed by environment, so every *other* environment's minted Cloudflare credential went with it, and `dev.json` has other tenants — the dev-login preference beside the bootstrap set. The run reported a clean write.
  
  Neither existing defense could see it. `readOptionalFile` ([#190](https://github.com/pithy-sh/pithy/issues/190)) distinguishes absent from unreadable, which closes "the file would not open"; this read succeeded. The `ENOENT` gate names no errno here and discards no failure, so it sees nothing either. The loss happens one step later, when a writer treats an unexpected shape as an empty one.
  
  Absent is still `{}`, and so is a file that will not **parse** — nothing can be made of it either way, and a half-typed `dev.json` must not stop `pithy dev`. A value that *parsed* is a claim about what is in the file, and it is now a refusal naming the path and the shape, with nothing written.
  
  The check lives in `readOptionalFile.ts` rather than at the third, fourth and fifth call site. Three readers made this assumption independently — `pithy.worker.jsonc` ([#204](https://github.com/pithy-sh/pithy/issues/204)) and these two — which is this repository's count for a rule belonging at the thing being called. [#204](https://github.com/pithy-sh/pithy/issues/204)'s own copy of the tag check is routed through it rather than left beside it, so there is one implementation and not two; each reader keeps its own sentence, exactly as each already keeps its own refusal for a file that would not open. It asks the value's own tag rather than `typeof`, because `typeof null === "object"` and **comment-json boxes a top-level scalar** so it has somewhere to hang the file's comments: `parse('"react"')` is a `String` object, not `null`, and `typeof` calls it an `"object"` too. A `null` check reads as the whole rule and is a quarter of it.
  
  The two docstrings that claimed the writer was the one that refused now say what is true: for a non-record it never was.

- [#225](https://github.com/pithy-sh/pithy/pull/225) [`128f0d3`](https://github.com/pithy-sh/pithy/commit/128f0d32907cbcc3856c38dc4b2d590e1423b156) Thanks [@kingmesal](https://github.com/kingmesal)! - The script that decides which gates run is reviewable, and so is every other file in the tree.
  
  `.github/scripts/crossPackageReads.ts` held a literal NUL byte at its dedup separator, from the day it
  was written. A NUL is what makes git call a file binary, so `git diff` printed `Bin 10043 -> 10128
  bytes`, `--numstat` printed `-`, and **not one line of that file has ever been reviewable as a diff.**
  It is the script that derives the cross-package read map [#173](https://github.com/pithy-sh/pithy/issues/173) built so a gate runs on the pull requests
  it gates — the file whose job is to make gates run was the one file whose changes nobody could read. It
  is also the likeliest reason two comments in it spent three commits asserting something false: the
  reviewer who would have caught the contradiction was never shown it ([#211](https://github.com/pithy-sh/pithy/issues/211)).
  
  The separator is the two-character escape `\0` now. The runtime key is the same byte, so the derivation
  is unchanged — `--json` is byte-identical against a payload saved before the edit, thirty reads across
  eight targets — and `git diff` renders it as `1 1`.
  
  **It was not the only one, and it was not special to `.github/`.** The gate found two more on its first
  run, both written the same way — a control character typed as a raw byte where its neighbors on the
  same line are escapes:
  
  - `packages/support/src/mime/sanitize.workers.test.ts` feeds `"java\0script:alert(1)"` to `isSafeHref`
    beside `\n`, `\t` and `\r` spelled as escapes.
  - `packages/testers/src/nudge/copy.test.ts` feeds a NUL to the control-character stripper. That file was
    **binary to git**, so the suite that proves hostile control characters never reach a nudge body was
    itself unreadable in review.
  
  **The gate reads the bytes rather than asking git, and that is the point.** git decides binary from the
  first 8000 bytes only. The byte in `crossPackageReads.ts` sat inside that window for three commits and
  sits at offset 8251 today, so git had quietly started rendering the file as text — the defect had not
  gone away, the file had grown past the window. A gate that asks git turns itself off as a file gets
  longer and back on when somebody deletes a paragraph.
  
  The file set is git's index, not the source walk: `.changeset/`, `.husky/` and `.vscode/` all hold
  committed text that the walk skips by design. `git ls-files` does the listing, so the rule that this
  repository writes one walk is untouched. The exception list is empty, and this repository has never
  committed a binary file — no image, no font, no fixture. Adding a line to it costs an argument.
  
  Proven by planting one: a NUL in `planShards.ts` makes `--numstat` report `-` and fails the gate with
  the path and the offset. The byte is built with `String.fromCharCode(0)` throughout the test, because
  writing a test about a NUL is the easiest way to put one in the test file.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - `PITHY_OFFLINE` no longer changes what a unit test says.
  
  [#218](https://github.com/pithy-sh/pithy/issues/218) added the variable so a developer or an agent can stop worrying about reaching a real account, and
  this repository recommends it. Setting it turned a suite red: `PITHY_OFFLINE=1 bunx vitest run
  src/doctor/probeAccountEvidence.test.ts` reported four failures that a plain run does not, and one more
  in `src/commands/add.test.ts`. Under turbo, as CI runs it, nothing sets the variable and everything
  passed. **A guard that silently changes a test outcome teaches people not to use it** — and it had
  already cost a false report, an agent naming those four as pre-existing breakage on `main`, which they
  were not.
  
  **The gate was not at fault, and that was established before anything changed.** `PITHY_OFFLINE` refuses
  the `process.env` credential overlay and nothing else; a resolution handed its own `env` through the
  seam reads that object, so a test supplying credentials through a seam is untouched. Both suites supply
  theirs through the overlay — `vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok")` — because the credentials left
  the checkout in [#182](https://github.com/pithy-sh/pithy/issues/182) and the overlay is the other real supply route. Offline refusing them is offline
  working. Every other suite in the tree was checked the same way and none is affected.
  
  So the fix is where [#198](https://github.com/pithy-sh/pithy/issues/198)'s already was: the unit configs pin it. `NO_ACCOUNT` in `vitest.shared.ts` now
  carries `PITHY_OFFLINE: ""` beside the four blanked credential keys, for the same sentence — **a unit
  result is a fact about the code, not about the shell it ran in.** Blank is not offline, matching how the
  overlay itself reads a blank value. Integration configs state neither: reaching a real account is what
  they are for, and offline is the one thing that legitimately stops them.
  
  The name is spelled in `vitest.shared.ts` rather than imported from the CLI that owns it, and that is a
  cost rather than a preference: vite's config loader externalises bare specifiers, so importing
  `cloudflare/config` reaches `@pithy-sh/core`'s error module externalised and node cannot resolve its
  extensionless relative import — every config in the tree fails to load before a test runs. The copy is
  not gated yet, and the constant says so: the assertion belongs in `ci/testIsolation.test.ts`, which loads
  every config already and can import the real name because a test file is transformed rather than
  externalised.
  
  `probeAccountEvidence` now asserts the offline case rather than depending on its absence: with the pair
  still exported, offline probes no account and claims nothing. `CONTRIBUTING.md` recommends
  `PITHY_CONFIG_DIR` and `PITHY_OFFLINE=1` together, without a caveat.

- [#175](https://github.com/pithy-sh/pithy/pull/175) [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e) Thanks [@kingmesal](https://github.com/kingmesal)! - The seeder and `pithy add` tell pithy's own injected copy from an adopter's `.dev.vars` line.
  
  Once a secret had been seeded, the transitional copy left in `.dev.vars` read as the pre-[#149](https://github.com/pithy-sh/pithy/issues/149) migration
  case — so deleting the secret from the dev secrets file suppressed it permanently: never minted again,
  never seeded, never reported. An encoded envelope is this tool's writing; a bare string is the adopter's.
  
  Also: a lookup keyed by a secret name is prototype-free at every boundary, and a sentence both halves of
  `pithy add` reach is printed once.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - One filter decides what a runtime's error may say to an adopter ([#228](https://github.com/pithy-sh/pithy/issues/228)).
  
  `safeReason` is the control that stops a parser diagnostic — a multi-line ANSI box quoting an absolute path and the adopter's own source line — from landing in a `PithyError`'s `action`, which the CLI renderer prints and the HTTP codec does not strip. It existed three times, near-verbatim: `project/config.ts`, `capabilities/loadFailure.ts`, and the vite plugin's `workerConfig.ts`, each with its own `ABSOLUTE_PATH`, its own ANSI regex, and its own copy of the tests around them.
  
  A security control in triplicate is one fix away from being a security control in duplicate, and that already happened once. [#223](https://github.com/pithy-sh/pithy/issues/223) found that testing *content* let Bun's build-failure wrapper through — `2 errors building "app/config:12:5.ts"` carries no leading slash, so it passed the absolute-path check and dragged a fabricated `Line 12, column 5` out of the file name with it — and closing it meant editing three files correctly, by someone who knew all three were there.
  
  [#223](https://github.com/pithy-sh/pithy/issues/223) moved `rootCause`, `prop` and `isBuildFailureWrapper` into core as recorded facts about a runtime and deliberately left the rest, on the reading that what a surface may say is that surface's business. That is true of the sentences and false of the filter. Whether a string carries a path, a stack frame or half an ANSI box is a property of the string, and three surfaces cannot hold three answers to it without two of them being wrong.
  
  So the filter moved and the policy did not. `safeReason`, `causeMessage`, `failurePosition` and `unresolvedSpecifier` are `@pithy-sh/core`'s, with the provenance suppression written **once** — a build-failure wrapper is refused before a single content test runs, and `failurePosition` refuses the same shape for the same reason, so no position is ever invented out of a file name again. What each classifier recognizes as unresolved or unparseable, and what it tells an adopter, stays where it was: the capability loader still holds a bad subpath out of its resolution branch, and the three refusals still say their own three sentences.
  
  `@pithy-sh/vite` still depends on `@pithy-sh/core` and on nothing else in the kit. That constraint is what made core the right home for `rootCause`, and it is what makes it the right home for this.
  
  The invariant is a gate rather than a claim: **no module outside core decides whether a cause's message is safe to show.** `project/config.test.ts` walks every shipped source file in the repository and fails on any module that declares a message-safety filter of its own — a function named for the safety of a reason, or its own absolute-path recognizer, the constant no copy of this managed to do without. Proven by planting a fourth copy in the vite plugin and watching it name the file. De-coloring is not flagged: `dev/logging.ts` strips ANSI to render a log line, and formatting is not a decision about what an adopter may be told.

- [#213](https://github.com/pithy-sh/pithy/pull/213) [`0ff0cd5`](https://github.com/pithy-sh/pithy/commit/0ff0cd54cb926a015b3bac7383976a36729788d4) Thanks [@kingmesal](https://github.com/kingmesal)! - One walk, and now a gate that says so instead of a changeset.
  
  [#185](https://github.com/pithy-sh/pithy/issues/185) consolidated six private traversals into `packages/cli/src/ci/sourceFiles.ts` and its changeset claimed *"every reader of this tree's own source now goes through `ci/sourceFiles.ts`"*. That sentence was wrong. Five walks were never migrated, and nothing noticed for two releases, because a release note is not something a build can fail on. Every hardening since reached the shared walker and none of them: [#185](https://github.com/pithy-sh/pithy/issues/185)'s own ENOENT tolerance, and [#192](https://github.com/pithy-sh/pithy/issues/192)'s exclusion of the vendored `packages/cli/templates` copy.
  
  Four are routed now. `capabilities/secretBackends.test.ts`, `audit/originColumns.test.ts` and `migrations/orders.test.ts` walked each package's `src` with a bare `statSync`, which throws on an entry that vanished between the listing and the probe. `orders.test.ts` was the worst of the three and not in the way it looked: the throw was caught by a `try` meant for a package with no sources, so a vanished file skipped **the whole package** silently and the failure surfaced as `DECLARED names a constant no capability declares any more` — the wrong sentence about the wrong thing. `capabilities/entitlementGap.ts` is the one that was not a test: it runs inside `pithy doctor` and `pithy dev`, over a directory the adopter is editing while it runs. All four now skip a directory they cannot list, drop a file that vanished before the read, and refuse to descend a symlink. The sets they derive are unchanged, file for file.
  
  `tooling/license-headers/src/workspace.ts` is not routed, and that is written down rather than left quiet. `tooling/*` cannot resolve `@pithy-sh/cli` — the workspace installs isolated, the package declares no such dependency, and a relative import out of `src` is refused by its `rootDir`. Routing it means adding that edge to a manifest or moving the walk somewhere both trees reach. Neither was chosen by default.
  
  The claim is now a gate. `ci/sourceFiles.test.ts` reads every `.ts` in the repository, tests and `.github/scripts` and `tooling/` included, and fails on any module that defines a function which lists a directory and calls itself. Four walks are declared with a written reason: three that cannot reach the primitive — `ui-react`'s template manifest test, whose package the CLI depends on, and the two in `tooling/license-headers` — and one that can and has not, `.github/scripts/planShards.ts`, which is listed as debt with a ratchet. `readdir(dir, { recursive: true })` is deliberately not banned: Node walks that one, so it cannot drift from the primitive the way six hand-written copies did.
  
  Two claims in [#202](https://github.com/pithy-sh/pithy/issues/202) did not survive the code, and are recorded here so the next reader does not chase them. **None of the five saw the vendored `packages/cli/templates` copy** — all three repo-source walks rooted at `packages/<pkg>/src`, and the copy is a sibling of `src`, not a child. **`entitlementGap.ts` never walked this tree at all**; it walks the adopter's Worker, which is why its exposure was at runtime rather than in a red suite, and why its `readdir` was already ENOENT-tolerant while the `readFile` after it was not.

- [#57](https://github.com/pithy-sh/pithy/pull/57) [`24ae9cd`](https://github.com/pithy-sh/pithy/commit/24ae9cd339894399b424506902bcf7076ff6530b) Thanks [@kingmesal](https://github.com/kingmesal)! - New package: `@pithy-sh/audit` — a D1-backed, queryable audit trail with a core emit seam and a CLI companion emitter, so both Workers and CLI commands record who did what, when, and whether it succeeded — attributed to the right CF actor. Core gains the `emit()` audit seam, the `audit/*` error codes, and the shared `withD1Retry` helper; `@pithy-sh/cloudflare` gains a user/token identity reader for actor resolution.

- [#220](https://github.com/pithy-sh/pithy/pull/220) [`b37e6c2`](https://github.com/pithy-sh/pithy/commit/b37e6c2ed52a8d1c506393977b06de6027fade36) Thanks [@kingmesal](https://github.com/kingmesal)! - The planner that decides which tests run no longer has a walk that can take them all down.
  
  `.github/scripts/planShards.ts` weighs every package by counting the `*.test.ts` files under its `src`, and it counted them with its own traversal: a guarded `readdirSync` and a bare `statSync`. That is [#185](https://github.com/pithy-sh/pithy/issues/185)'s race, unhardened, in the one script every test job in the matrix is gated on. An entry that vanished between the listing and the probe threw out of `testFileCount`, out of `runnables`, out of `main`, and the `plan` job died — and a workflow that plans nothing is green. It now calls `sourcePaths` from `packages/cli/src/ci/sourceFiles.ts`, which skips a directory it cannot list, drops a file that vanished before the read, and refuses to descend a symlink.
  
  It plans identically. Measured on one saved `turbo run test:node test:workers --dry=json` payload piped through both versions, on the full graph and on two filtered scopes: byte-identical output. Per package, all 23 workspace directories: identical weights.
  
  The import constraint that made this look harder than it is holds, and it is the reason the shared walker imports nothing but `node:fs` and `node:path`. The `plan` job in `ci.yml` has no `bun install` step — a dry run reads the workspace manifests and nothing else, and that job is pure latency in front of every test job. `planShards.ts` now imports two `node:` builtins and one relative path; that module imports two `node:` builtins. No bare specifier in the graph, and it runs to completion in a tree with no `node_modules` in any ancestor.
  
  **`NOT_YET_ROUTED` is empty and its ratchet is zero.** The list of walks that merely had not been routed no longer has anything on it, and the gate in `ci/sourceFiles.test.ts` will not let it grow.
  
  `tooling/license-headers` was decided rather than left implied, and the decision is **leave it separate** — recorded where the exception is, so it costs an argument to change. The edge was one manifest line, and refusing it is about direction: that package is the gate that stamps `packages/cli`'s own headers and it runs in `lint-staged` on every commit, so making the linter a dependent of the largest thing it lints points the graph backwards and pulls every CLI change into its `--affected` set. What the edge would have bought was priced instead of assumed. Two of the three properties are already in that walk — a symlink is not descended, and the vendored `packages/cli/templates` is out of range because it reads `<pkg>/src` and the copy is a sibling of `src`. The third, [#185](https://github.com/pithy-sh/pithy/issues/185)'s unguarded listing, needed no dependency at all: `workspace.ts` now skips a directory it cannot list, with a test that fails without it.
  
  One reason in [#202](https://github.com/pithy-sh/pithy/issues/202)'s exception list did not survive being checked, and is corrected. `audit.ts` cannot be routed, but **not** because the primitive skips `templates` — it skips `packages/cli/templates` by path and nothing else, so the root starter and `packages/ui-react/templates` are both kept, and the copy it does skip is a byte-for-byte duplicate that exists only between `prepack` and `postpack`, which the license audit should want skipped rather than reported under a path `postpack` deletes. The real blocker is direction of narrowing: `templateFiles` wants every file at every depth, and the primitive skips dotted directories with no option to stop — that rule is what keeps `.smoke-*`, `.e2e-*` and `.worktrees/` out of every other caller. `keep` chooses which files are taken; nothing widens which directories are entered.

- [#205](https://github.com/pithy-sh/pithy/pull/205) [`24cb3cb`](https://github.com/pithy-sh/pithy/commit/24cb3cbf354ca577af4365b7ad33748932dc7607) Thanks [@kingmesal](https://github.com/kingmesal)! - The port-registry lock's retry budget is injectable, so a test stops racing its own timeout ([#194](https://github.com/pithy-sh/pithy/issues/194)).
  
  `LOCK_MAX_ATTEMPTS` (50) × `LOCK_RETRY_DELAY_MS` (100) is 5000ms, and 5000ms is vitest's default
  timeout to the millisecond. `ports.test.ts > lock staleness > does NOT reclaim a fresh lock` asserts
  that a lock still inside its staleness window is not stolen, so it must exhaust every retry to pass —
  and exhausting them costs exactly the timeout. It passed on an idle machine, failed on a loaded one,
  and [#173](https://github.com/pithy-sh/pithy/issues/173) made this suite run on every pull request.
  
  `allocatePortBlock`, `freePortBlock` and `reclaimPortBlocks` now take an optional `lock` budget.
  Production values are the defaults and nothing in the CLI passes it; the test passes three attempts at
  10ms and runs in 33ms instead of 5028. The assertion is unchanged — a fresh lock survives a spent
  budget, whatever its size — and still goes red if the reclaim is made unconditional.
  
  The refusal now names the budget it actually spent rather than the constant, and the defaults are
  asserted, so the seam cannot become a way for production to acquire a different one quietly.
  
  Three other retry loops in the CLI have production constants of the same shape — `verifyDeploy`'s
  5 × 1000ms, `vectorProvisioner`'s 10 × 1000ms, `orchestrator`'s 5000ms shutdown grace. All three
  already inject their sleep, and no test in the tree waits on a real one. This was the only holdout.

- [#213](https://github.com/pithy-sh/pithy/pull/213) [`0ff0cd5`](https://github.com/pithy-sh/pithy/commit/0ff0cd54cb926a015b3bac7383976a36729788d4) Thanks [@kingmesal](https://github.com/kingmesal)! - The last two readers throwing node's error at an adopter now say a sentence ([#203](https://github.com/pithy-sh/pithy/issues/203)).
  
  `readRcFile` (`platform/rc.ts`) and `nodeMediaFs.readText` (`seed/media.ts`) rethrew node's own error for
  any failure that was not `ENOENT`. An adopter whose `.zshrc` would not open got a bare `EACCES` and a
  stack trace, which is the failure this repository's error model exists to prevent — and it got it from
  `pithy alias` and `pithy doctor`, the two commands most likely to be run *because* something is already
  wrong.
  
  Both go through `readOptionalFile`'s `unreadable` callback now, so both refuse with a `PithyError` naming
  the file and what to do about it. The errno stays in `detail`, which the HTTP codec strips; node's error
  stays as `cause`; no byte of either file reaches the message, because an rc file is where a developer
  keeps `export GITHUB_TOKEN=…` and a media sidecar sits beside credentials of its own.
  
  They were like this deliberately. [#197](https://github.com/pithy-sh/pithy/issues/197) routed six hand-written `ENOENT` branches under a strict
  no-behavior-change constraint, and `readOptionalFile`'s callback returns a `PithyError` by construction —
  so it could not express "rethrow node's error", and these two went through `readFileOutcome` instead. That
  was correct for that change and is the follow-up it implied. `readFileOutcome` now has one caller,
  `capabilities/manifests.ts`, which needs it for the reason it exists: a read that must answer for fifteen
  other packages cannot throw.
  
  `pithy alias` is unchanged on a readable rc file and refuses cleanly on an unreadable one. `pithy doctor`
  already failed on an unreadable rc file — it now fails with a sentence instead of a stack.

- [#201](https://github.com/pithy-sh/pithy/pull/201) [`bd9899e`](https://github.com/pithy-sh/pithy/commit/bd9899edc6af695a1ac795e83ff4cb073fd2d929) Thanks [@kingmesal](https://github.com/kingmesal)! - Only `ENOENT` means the file is not there, and now it means it in one place.
  
  Three readers had each learned that separately, and each one had cost something first: a `.dev.vars` rewritten from an empty base over a file full of values the process never saw, a `dev.json` that would have been replaced along with a developer's dev-login preferences, and a capability that vanished from `pithy add --list` because its manifest was present and unreadable. The rule is one sentence, and it had been written three times in three files.
  
  `readOptionalFile` in `project/` is that sentence, once. It answers with the file's bytes, `null` for `ENOENT` and nothing else, and a `PithyError` naming the path and the errno for every other failure — with node's own error carried as `cause` and not a byte of the file in the message. `readFileOutcome` beside it gives the same three answers as a value, for the caller that was asked about sixteen packages and must still answer for the other fifteen. What stays at each call site is the sentence an adopter reads, which is `.dev.vars`-shaped or `dev.json`-shaped and belongs there; what moved is the decision about which errno means absence.
  
  A build-failing gate states the invariant rather than naming the three: **a module that puts bytes on disk must not read a file and discard the failure.** It reads every package's source through the one walk in `ci/sourceFiles.ts`, sees the `.catch` form and the `try` form alike, and takes an alias or a namespace import with it. Scoping it to modules that write is what keeps it free of false positives — `doctor` discards on purpose, because a diagnostic has to work in the environment it exists to diagnose and can destroy nothing it failed to read. Eight discards that cost nothing are written down with the reason they cost nothing; five that could cost something are written down with what they would cost, as a list that may only shrink.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - Four commands resolved the default Cloudflare account, because the parameter was optional.
  
  `pithy env`, `pithy migrate`, `pithy deploy`'s pending-migration count, and the `pithy testers` roster commands all reached `<config>/cloudflare.json` regardless of what the project's `pithy.config.ts` named. A project on a `cloudflare.accountName` got another account's credentials from every one of them — no name, no pin, no refusal, which is the exact state [#206](https://github.com/pithy-sh/pithy/issues/206) exists to prevent. `pithy migrate --env staging` is the one that matters: `migrateProject`'s own docstring says a remote migration alters a real schema and the wrong credentials run it against another company's database, and the command that invokes it did not supply the account.
  
  All four now pass `projectCloudflareAccount(projectDir)`. Two projects on one machine naming different accounts each resolve their own credentials file, and a pinned `cloudflare.accountId` that disagrees refuses before any network call.
  
  **The cause was that the parameter was optional, not that four people forgot.** `account?: T | null` reintroduces the failure mode a required argument removed: `null` is the deliberate "this project names none", an omission is indistinguishable from it, and it costs nothing to write. `buildEnvInventory` now takes a **required** `account`, so omitting it is a type error.
  
  `cloudflare/accountArgument.test.ts` — the gate holding every deliberate `account: null` to a written reason — could not see an omission, which is why all four passed it. It now walks the shipped source for *optional* account declarations too, in both shapes the compiler permits: an `account?:` property and an `account: … = null` default. Four remain, each listed with what it would cost to make it required. A fifth cannot appear quietly.
  
  `pithy env`'s `accountId` schema said the value comes "from `.dev.vars` or the environment". `.dev.vars` has not been a credential source since [#182](https://github.com/pithy-sh/pithy/issues/182); it names the file it actually reads.

- [#205](https://github.com/pithy-sh/pithy/pull/205) [`24cb3cb`](https://github.com/pithy-sh/pithy/commit/24cb3cbf354ca577af4365b7ad33748932dc7607) Thanks [@kingmesal](https://github.com/kingmesal)! - One module decides what a failed file read means ([#197](https://github.com/pithy-sh/pithy/issues/197)).
  
  The last six readers that spelled the `ENOENT` branch out by hand now go through `readOptionalFile`:
  `devSecrets/file.ts`, `project/devVars.ts`, `platform/rc.ts`, `feature/manifest.ts`, `feature/ports.ts`
  and `seed/media.ts`. All six were correct. They were six copies of one sentence, and a copy is what the
  seventh author reads instead of the original — which is how this repository got three data losses from
  the same line.
  
  Nothing an adopter sees changed. Each call site kept its own message, action and error class through
  `options.unreadable`; the two that rethrow node's own error untouched kept doing that through
  `readFileOutcome`. Every existing test at the six passed unmodified.
  
  What it buys is the gate. It was *a module that writes must not read a file and discard the failure* —
  scoped that way because the rule everyone wants has 32 producers in this tree, and its stated cost was
  that a reader which writes nothing is invisible to it, which is the axis the third defect came in on.
  The new rule alongside it is **only `readOptionalFile.ts` may name `ENOENT` where a file's contents were
  read**: no allowlist, no judgment about which modules write, and no evading it by aliasing an import. A
  probe's errno and a write's errno are untouched — `scaffold.ts` and `atomic.ts` are the rule applied,
  not exempted from it.
  
  The discard rule stays beside it, because the shortest wrong thing — `.catch(() => null)` — names no
  errno at all and the new rule cannot see a silence. Its two lists are re-earned against that split
  rather than carried over.

- [#195](https://github.com/pithy-sh/pithy/pull/195) [`10c65c5`](https://github.com/pithy-sh/pithy/commit/10c65c5be50dfec0c9f3d838fbed7e2b17c08319) Thanks [@kingmesal](https://github.com/kingmesal)! - A module that imports `cloudflare:workers` exports nothing a non-runtime module could want.
  
  That has been the rule since [#172](https://github.com/pithy-sh/pithy/issues/172) and [#180](https://github.com/pithy-sh/pithy/issues/180) — the same defect twice, where a Node-side caller imported a constant out of a Durable Object module and got the whole Workers runtime behind it. The symptom is `Could not load pithy.config.ts`, which names the config rather than the import, and [#172](https://github.com/pithy-sh/pithy/issues/172) cost real time for exactly that reason.
  
  Three modules still offered one. `REFRESH_BATCH_CHUNKS` moves from `leaderboard`'s `rank/worker.entry.ts` to `rank/materialize.ts`, beside the chunk size it is counted in. `auditLogEmit` and `logReconcileReport` move from `payments`' `workflows/worker.ts` to `workflows/report.ts`, and `logPassComplete` and `logCohortFailure` from `testers`' `workflows/worker.ts` to its own `workflows/report.ts`. Each runtime module imports from its pure sibling; nothing else changes for a caller, and none of the five was live.
  
  `configEntrypoints.test.ts` now states the invariant rather than listing the files. It reads every runtime module in the tree and requires each value export to be a class extending a `cloudflare:workers` base, or the worker's default handler — a type export is free, since it erases. Enumerating known instances is what produced the second and third of every defect class here, so this asks the question about the module.
  
  The two `report.ts` modules' tests are node tests now. They were workers-project tests only because the functions sat beside a `WorkflowEntrypoint`; that they load in a plain Node process at all is the proof.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - Four `--json` key names carried two types each. Each now names what it holds.
  
  `if (result.removed)` was true for `pithy alias --remove`'s `boolean` and for `pithy feature sync`'s non-empty `string[]`. `result.revoked` was a yes/no on `pithy dashboard revoke-key` and a count on `pithy token revoke`, where `0` is an ordinary answer and `false` is a different claim. Neither reading errors; both just answer wrongly. Renamed on the outlier's side, before publication freezes them:
  
  - `pithy feature create --json` reports `worktreeCreated`, not `created`. `pithy ui add --json` emits a `created` of its own that is the list of files it wrote — one name for "what was created" and for "whether it was". The subject is already in the payload beside it, and `feature destroy` had settled the convention anyway with `portsFreed`, `worktreePruned` and `branchDeleted`.
  - `pithy feature sync --json` reports `addedWorkers` and `removedWorkers`. `removed` is a `boolean` on `alias` and on `dashboard disconnect`; this is a list of worker names. `added` is renamed with it because the two are read together, and half a qualified pair invites the misreading the qualification is for.
  - `pithy feature destroy --json` reports `deletedResources`. `pithy vector reset --json` emits `deleted` as a `string[]` of index names where this is `{kind, name, id}[]` — two collections under one name, the harder half to notice, since both are truthy and both have a `length`. It also now sits opposite `provision`'s `resources`, which is the list it undoes.
  - `pithy token revoke --json` reports `revokedCount`. Every other `<verb>ed` key in the CLI is a boolean.
  
  A fifth, `skipped`, was not a collision at all. `payments reconcile` and `vector reprocess` each pass a deployed Workflow's return value straight out under `report`, and their pages spell out what that object holds — `pages`, `scanned`, `skipped` — in a second table. The scan that records shared names was reading that table as the command's own keys. The CLI has one top-level `skipped`, on `pithy ui add`, and it is unchanged; the scan reads the table header now, which also drops `pages` and `scanned` from the shared register and narrows `dryRun` to the two commands that really share it.
  
  The register gained the half of "one key, one meaning" that is decidable. Every shared name's **type** is declared and asserted against the pages, so two pages describing one key differently have to be read together before either lands. Four names still disagree and are listed with the types they disagree on, rather than muted: `alias`, `project` and `workers` are all one shape — `pithy doctor`'s and `pithy dev`'s payloads are reports, and a report's blocks take the bare noun a result elsewhere spends on a scalar — and `environments` is a `string[]` of names in four commands and an `object[]` of records in `secrets status`.

- [#195](https://github.com/pithy-sh/pithy/pull/195) [`10c65c5`](https://github.com/pithy-sh/pithy/commit/10c65c5be50dfec0c9f3d838fbed7e2b17c08319) Thanks [@kingmesal](https://github.com/kingmesal)! - One walk over this tree's source, so a tripwire cannot flake on somebody else's teardown.
  
  `project/atomic.test.ts`'s rename tripwire read every source file in the repository and descended into `packages/cli/.smoke-*` and `.e2e-*` — whole projects other suites scaffold and delete while it walks — and into `.worktrees/`, a second checkout of this repository read as if it were this one. A full-suite run failed with `ENOENT … packages/cli/.smoke-OXGbGb/pithy.config.ts`. Timing-dependent, so it passes locally and fails in CI or the reverse, which is the worst shape for a gate whose job is to fail the build honestly. A tripwire that flakes gets muted, and a muted tripwire is the defect it was built to catch, shipping.
  
  Every reader of this tree's own source now goes through `packages/cli/src/ci/sourceFiles.ts`. It skips dotted directories — `.github` excepted, since its scripts are source CI runs — never descends a symlink, and treats a directory it cannot list and a file that vanished between the listing and the read as skipped rather than fatal. A file that is not there is not a file that breaks a rule.
  
  Migrated: the rename tripwire (`project/atomic.test.ts`), the follower and recursive-delete tripwires (`project/scaffold.test.ts`), the editor tripwire (`platform/editor.test.ts`), the runtime-export gate (`capabilities/configEntrypoints.test.ts`), and CI's change planner (`.github/scripts/crossPackageReads.ts`), which still imports nothing but `node:fs` and `node:path` so it runs before `bun install`.
  
  Six traversals were six places to get the same two things wrong separately, and they had: [#157](https://github.com/pithy-sh/pithy/issues/157)'s was hardened when it was written and `atomic.test.ts`'s was not. There is one now, and it has its own tests.

- [#205](https://github.com/pithy-sh/pithy/pull/205) [`24cb3cb`](https://github.com/pithy-sh/pithy/commit/24cb3cbf354ca577af4365b7ad33748932dc7607) Thanks [@kingmesal](https://github.com/kingmesal)! - Stop the test suite reaching the operator's machine and the operator's account.
  
  Two defects, one shape. `bun run test` minted 36 real AES master keys into a maintainer's `~/.config/pithy` and wrote `SECRETS_STORE_ID` into their real `cloudflare.json`, because `addBootstrap.test.ts` passed no seam and nothing made the config directory fake ([#200](https://github.com/pithy-sh/pithy/issues/200)). Every unit suite that resolved a credential was talking to a live Cloudflare account, because `cloudflareEnv` overlays `process.env` per key — by design, so CI can pass credentials with no file — and anyone who has run `pithy deploy` has a token exported ([#198](https://github.com/pithy-sh/pithy/issues/198)). Both were fixed once, in one package, leaving the other twenty-one exposed.
  
  Three layers, because the seam has to be impossible to forget rather than easy to remember.
  
  A repo-root `vitest.setup.ts` gives every test file its own throwaway `PITHY_CONFIG_DIR`, and every project in every package loads it. `vitest.shared.ts` exports `NO_ACCOUNT` — every `CLOUDFLARE_ENV_KEYS` name blanked, derived from the list rather than copied from it, so a fifth key is covered by the commit that adds it — and every unit project states it. Integration projects deliberately do not: reaching a real account is the whole of what they are for.
  
  **And `stateDir` refuses.** It is the single resolver behind dev secrets, dev preferences, `cloudflare.json` and the notifier state, so the invariant is checkable in one place: under vitest it answers from `PITHY_CONFIG_DIR` or from seams the caller passed, and never from `process.env` or `os.homedir()`. A safe default still lets a test opt back into the real directory by accident; a resolver that refuses cannot. A suite that means the real directory says so with `PITHY_ALLOW_REAL_CONFIG_DIR=1`, once, where a reviewer can see it. Nothing outside vitest is affected — a real `pithy` run never reaches this.
  
  The gate is `packages/cli/src/ci/testIsolation.test.ts`. It **loads** each config and inspects the object vitest is handed rather than reading the source, because [#198](https://github.com/pithy-sh/pithy/issues/198)'s first guard was a second `env:` key on one object literal, which JavaScript discards without a word — the file said covered and the run was not, for a fortnight. A guard that is present but inert now fails exactly like a missing one, as does one stated at the wrong nesting level: a root `env` reaches an inline project and a root `setupFiles` does not, so where a guard goes is measured rather than assumed.
  
  Workers projects are exempt, structurally rather than by judgment: workerd does not inherit the host environment, so there is no ambient credential to blank and no real home directory to resolve.
  
  Verified with a credential pair exported and no ambient `PITHY_CONFIG_DIR`: 2,384 CLI tests, plus the `cloudflare`, `secrets`, `core` and `audit` suites, and `~/.config/pithy` byte-identical before and after. Every socket the run opened went to `127.0.0.1`. Cleaning up a machine polluted by the old behavior is documented in `CONTRIBUTING.md`.

- [#220](https://github.com/pithy-sh/pithy/pull/220) [`b37e6c2`](https://github.com/pithy-sh/pithy/commit/b37e6c2ed52a8d1c506393977b06de6027fade36) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy doctor` stops reading a failed config as a project that declares nothing.
  
  [#199](https://github.com/pithy-sh/pithy/issues/199) fixed the producer: `resolveDevSecretsTargets` answers `{ targets, unresolvable }`, so a `pithy.config.ts` that will not import is a field rather than an absence. The consumers still took the lossy list, and each read "this Worker could not be asked" as "this Worker declares nothing". Registries merge project-wide, so a healthy sibling does not rescue the answer: its registry is real, and it is not the project's.
  
  **`doctor` was silent in the one state it was written for.** `checkDevSecrets` returned `null` for an empty target list, over a comment reading "`null` means no Worker composes `secrets`" — which was also every Worker's config failing to import. The whole `Dev secrets:` block disappeared. Same shape as [#166](https://github.com/pithy-sh/pithy/issues/166): a line that vanishes in the report that needed it. It reports now, first in the block, because it explains every line under it:
  
  ```
  Dev secrets:
    replay-board's pithy.config.ts would not import, so nothing here knows what it declares. …
    MYSTERY_KEY is in .dev.vars, and nothing here can say what reads it while replay-board will not import. Fix that first.
  ```
  
  It reports and does not refuse: the rest of the report — Cloudflare reachability, project health, the secrets paths — still prints. A diagnostic that dies on what it is diagnosing is worse than one that names it.
  
  The rule under it is one line: **`unread` is a negative claim, and a registry nobody could read is exactly what might have declared it.** `credential`, `secret` and `binding` survive a partial resolution because each rests on positive evidence — a fixed credential list, a registry that did declare the name, a composition that does want it. So a fifth root-key state, `unclassified`, is what is left when the only remaining answer would have been an inference from a file nobody could open. `devVarsLocal` withholds `devOnly` and `checkDevSecrets` withholds `undeclared` on the same rule, both of them negative claims.
  
  `--json` carries `unresolvable` on `devSecrets` and `devVars`, each entry naming the Worker, its directory and the reason. A `devSecrets` object carrying one is how a script tells "nothing loaded" from the `null` that now means only what it says: this project composes no secrets.

- [#213](https://github.com/pithy-sh/pithy/pull/213) [`0ff0cd5`](https://github.com/pithy-sh/pithy/commit/0ff0cd54cb926a015b3bac7383976a36729788d4) Thanks [@kingmesal](https://github.com/kingmesal)! - Say when a Worker's config will not import, instead of treating it as a Worker that declares nothing.
  
  Since [#179](https://github.com/pithy-sh/pithy/issues/179) a `cf-secrets-store` secret is materialised only from the registry, which means only if the Worker's `pithy.config.ts` imports. That is the right rule — a registry nobody can read has no honest answer about which secrets a Worker gets, and the previous answer came from the `dev.json` copy [#179](https://github.com/pithy-sh/pithy/issues/179) exists to delete. But the failure reached every consumer as an *absent target*, and an absent target is also what a project that never composed `secrets` looks like. The two states were indistinguishable, so nothing reported the one that mattered.
  
  `pithy dev` was where that landed. A project whose config had a typo had its `.dev.vars` regenerated down to its header, started the Worker with no bindings, and printed one line: `Starting replay-board.` Not a word about the config. `pithy seed` and `pithy doctor` both name an unloadable config for their own reasons and were never affected; `pithy dev` is the command an adopter is actually running while they edit that file.
  
  `resolveDevSecretsTargets` replaces the array with `{ targets, unresolvable }`, so a failure is a field a caller has to drop on purpose rather than an absence it takes by default. `pithy dev` now says, every run until it is fixed:
  
  ```
  replay-board starts with no bindings of its own: its pithy.config.ts did not import,
  so nothing knows which secrets it declares and none reached apps/board/.dev.vars.
  Could not load …/apps/board/pithy.config.ts. …
  ```
  
  Consequence first, then the cause, in one sentence — the adopter is mid-edit with the wrong suspect in mind, and two facts in two blocks is them correlating it.
  
  Resolution is also per Worker now. `resolveWorkers` fans out and throws on the first bad config, so one Worker's typo cost every healthy sibling in the project its registry, and therefore its secrets, for a file it does not own. A failure costs exactly one Worker.
  
  A tripwire pins the four remaining callers of the lossy list — the three `pithy doctor` checks and `pithy add` — by name, so a fifth has to add itself and read why. This defect class reached four independent producers before anyone noticed; a count would have passed while one was swapped for another.

- [#205](https://github.com/pithy-sh/pithy/pull/205) [`24cb3cb`](https://github.com/pithy-sh/pithy/commit/24cb3cbf354ca577af4365b7ad33748932dc7607) Thanks [@kingmesal](https://github.com/kingmesal)! - The source walk no longer reads the starter template twice while a pack is in flight.
  
  `packages/cli/templates` is the copy of the repo root's `templates/starter` that `prepack` vendors in and `postpack` takes out again. It is not dotted, so the walk in `ci/sourceFiles.ts` descended into it and reported five template sources under two paths at once — the real one and the copy. Every tripwire that reads this tree's own source got a different answer depending on whether a pack was running: the rename tripwire, the recursive-delete and follower tripwires, the `$EDITOR` gate, the runtime-export gate, and CI's change planner, which would have picked up the starter's own `bindings.workers.test.ts` as a `packages/cli` test file and planned suites on it.
  
  It cannot be dotted and it cannot move. `files` in the CLI's manifest carries exactly that path, and that is the whole mechanism by which a published `@pithy-sh/cli` ships a starter at all ([#143](https://github.com/pithy-sh/pithy/issues/143), [#152](https://github.com/pithy-sh/pithy/issues/152)). So the walk skips it by where it is — by path, never by name, because the repo root's `templates/` is the source of truth those same tripwires exist to read.
  
  Skipping is right whether or not a pack is running. It is a file-by-file copy of a directory the walk already visits, so descending into it can only ever report a source twice, under a second path that `postpack` is about to delete. A pack that fails after `prepack` never runs `postpack` and leaves the copy behind for good — gitignored, so `git status` says nothing — and then the duplicate is permanent rather than transient. Nothing flaked today because no template source breaks a rule; the one that eventually does would have gone red or green on timing, naming a file nobody could open ([#192](https://github.com/pithy-sh/pithy/issues/192)).
  
  `bun run pack:verify` and `packaging.test.ts` are unchanged.

- [#237](https://github.com/pithy-sh/pithy/pull/237) [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a) Thanks [@kingmesal](https://github.com/kingmesal)! - All five `pithy worker` subcommands name a Worker the same way, and `worker add` reports the port it just pinned.
  
  `add`, `list`, `remove` and `rename` reported `name` — and it was the `apps/` **directory** in `add` and the **deployed script name** in the other three. One key, two meanings, with nothing in the payload saying which; the two coincide whenever a project and its Worker are named alike, which is what kept it hidden. `sync` had been fixed already, in [#144](https://github.com/pithy-sh/pithy/issues/144), and the doc comment on `workerIdentity` has been describing this exact ambiguity ever since. All five now carry that function's `worker` and `deployedAs`. `name` is gone rather than redefined: a payload carrying both spellings would leave every consumer of the old one reading whichever half it happened to be written against.
  
  `worker add` looked its new Worker's port up by the `apps/<dir>` basename the adopter typed. The port registry is keyed on the deployed name, so the two could never match — inside a feature worktree the payload reported `"port": null` beside `"reconciled": true`, and the human path then offered to assign a port that a reconcile had just assigned. The lookup uses the name the registry uses, and the human path has three states instead of two, so the sentence about assigning a port is only printed where none has been.
  
  `pithy worker list` prints the `apps/` directory beside the deployed name it already led with. Neither can be inferred from the other, and the command that exists to say what a project has should say both.

- [#205](https://github.com/pithy-sh/pithy/pull/205) [`24cb3cb`](https://github.com/pithy-sh/pithy/commit/24cb3cbf354ca577af4365b7ad33748932dc7607) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui` never rebuilds a `pithy.worker.jsonc` it could not read ([#196](https://github.com/pithy-sh/pithy/issues/196)).
  
  `readManifestDocument` answered `{}` for every read failure. `pithy ui add` then merged its `dev` and
  `ui` blocks into that empty base and renamed the result over the file — so a manifest that was **there**
  and did not open (`EACCES` after a mode change, `EISDIR`, `EIO` on a failing disk) came back holding two
  blocks and nothing else, with the run reporting Done. Every binding, route and comment the adopter had
  written was gone.
  
  This is [#142](https://github.com/pithy-sh/pithy/issues/142) with a different file name. `pithy.worker.jsonc` is committed rather than gitignored, so
  the loss was recoverable from git — but only by someone who noticed before committing over it.
  
  The read goes through `readOptionalFile` now: only `ENOENT` starts from an empty document, and anything
  else refuses by path and errno before a byte is written. An absent manifest still reads as empty, which
  is what `pithy ui add` needs on a worker that has never had a front end.
  
  The rebuild's other half was checked and is sound: the document is round-tripped whole, so every block
  this writer does not own survives a `pithy ui add`. That is now pinned by a test rather than by reading
  the code.
- Updated dependencies [[`5367798`](https://github.com/pithy-sh/pithy/commit/5367798875f200a46ec7e7a51c223e39a8b83380), [`270be6e`](https://github.com/pithy-sh/pithy/commit/270be6e9f8ea8f8c44b6bbea67f3c6ba61e67f64), [`270be6e`](https://github.com/pithy-sh/pithy/commit/270be6e9f8ea8f8c44b6bbea67f3c6ba61e67f64), [`270be6e`](https://github.com/pithy-sh/pithy/commit/270be6e9f8ea8f8c44b6bbea67f3c6ba61e67f64), [`5d2eae2`](https://github.com/pithy-sh/pithy/commit/5d2eae2d68a3f7cb03f0bbd9164a21bf1324b414), [`bd6b339`](https://github.com/pithy-sh/pithy/commit/bd6b339d155ee5ec0746f42f5fb0e39d21a8f33d), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`7ec1566`](https://github.com/pithy-sh/pithy/commit/7ec15662a8c49c992d827afb26518a9304643c1e), [`bd9899e`](https://github.com/pithy-sh/pithy/commit/bd9899edc6af695a1ac795e83ff4cb073fd2d929), [`bd9899e`](https://github.com/pithy-sh/pithy/commit/bd9899edc6af695a1ac795e83ff4cb073fd2d929), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`0252888`](https://github.com/pithy-sh/pithy/commit/0252888498278eac7d7b693429a32c530ea8907c), [`84beb3b`](https://github.com/pithy-sh/pithy/commit/84beb3b050b9f3643cfee9a11578a780cabd08df), [`35aabdd`](https://github.com/pithy-sh/pithy/commit/35aabdd1f1153ac0ccedff35f224cf9ac596daa2), [`5e93279`](https://github.com/pithy-sh/pithy/commit/5e9327927c0f59e1d94387f2880ddba0043ec600), [`30c6404`](https://github.com/pithy-sh/pithy/commit/30c6404bfe7b17821daf4ec9458b56939866aa14), [`e38b5ff`](https://github.com/pithy-sh/pithy/commit/e38b5ffefcf9a48e61a34da8811188bee3ea74c9), [`d597eb3`](https://github.com/pithy-sh/pithy/commit/d597eb3c6f07c8bb47f5c00c19f7402f8327a46d), [`984073c`](https://github.com/pithy-sh/pithy/commit/984073c9ac9d6dc9b6867d45d43eee2969b2bf76), [`e04870f`](https://github.com/pithy-sh/pithy/commit/e04870fab31169f0721e9625ef8609f66a0a9f5d), [`27be7e1`](https://github.com/pithy-sh/pithy/commit/27be7e18ec4b014ab9a45785ae34802920c7ccc0), [`7c5b11b`](https://github.com/pithy-sh/pithy/commit/7c5b11ba3c0028d6f33ab826aaae4dfb25fa52b8), [`d282ee9`](https://github.com/pithy-sh/pithy/commit/d282ee9088595979b7d830908ac0799ec6a148de), [`7c5b11b`](https://github.com/pithy-sh/pithy/commit/7c5b11ba3c0028d6f33ab826aaae4dfb25fa52b8), [`a75a932`](https://github.com/pithy-sh/pithy/commit/a75a932b642026ed146f24bf63914ce6f0d8943f), [`da4525b`](https://github.com/pithy-sh/pithy/commit/da4525b6097fb2f8eca3a06b4a0e02ad66634b3d), [`5d2eae2`](https://github.com/pithy-sh/pithy/commit/5d2eae2d68a3f7cb03f0bbd9164a21bf1324b414), [`550252e`](https://github.com/pithy-sh/pithy/commit/550252e8304bc1f9a6bf94d440c50f8a6b974616), [`4611470`](https://github.com/pithy-sh/pithy/commit/46114709c054891101aa4339150e522bdc8154eb), [`3a75222`](https://github.com/pithy-sh/pithy/commit/3a752227e5030eb8f01668e1540a057b26cad163), [`7eef492`](https://github.com/pithy-sh/pithy/commit/7eef492699697a1c964da9d54059caef54c51ff9), [`704f8fa`](https://github.com/pithy-sh/pithy/commit/704f8faf6e94aafe115df7d74ac34b1f868b211f), [`08c317c`](https://github.com/pithy-sh/pithy/commit/08c317cd8b897be5e744c7d3483f4126f67b3b8a), [`57c6df1`](https://github.com/pithy-sh/pithy/commit/57c6df11e5e553de8b034aba66db929dbd165c3e), [`0f912a2`](https://github.com/pithy-sh/pithy/commit/0f912a2677ea731d16659cf6d3f5e98b11d3c53f), [`953ff0e`](https://github.com/pithy-sh/pithy/commit/953ff0e3939024c1c00beb95fcb900a9ac22497a), [`16115c4`](https://github.com/pithy-sh/pithy/commit/16115c463287cd9222aaa05f9658020e43ec41b7), [`973d79f`](https://github.com/pithy-sh/pithy/commit/973d79ffbd0f79ff63a2055fd41d44c4529f0a6d), [`67a367b`](https://github.com/pithy-sh/pithy/commit/67a367bb1a52e9120b86f4947e9e4c43451d54e8), [`b0275f0`](https://github.com/pithy-sh/pithy/commit/b0275f0fef37a3c6434df108958c1e2a2bc9ee1e), [`2d014a2`](https://github.com/pithy-sh/pithy/commit/2d014a29940281261a79deaba2d24a61339e3d80), [`3609c2a`](https://github.com/pithy-sh/pithy/commit/3609c2a56e7388e1931dcb52be74390df38d6472), [`1cf67d1`](https://github.com/pithy-sh/pithy/commit/1cf67d1a8f6e94be70643d6e3c4779eb0913612c), [`8eaea90`](https://github.com/pithy-sh/pithy/commit/8eaea90d1a35fd295733f8d33a04b4ce44119211), [`6ba91d8`](https://github.com/pithy-sh/pithy/commit/6ba91d8f967bd42460a81338a3629ce08b51b8a9), [`3ad79d5`](https://github.com/pithy-sh/pithy/commit/3ad79d588d0dbac87003bdbf452443775529d7a3), [`df8362f`](https://github.com/pithy-sh/pithy/commit/df8362f77007dbd9b3248785eaab0231967426ea), [`d0e1744`](https://github.com/pithy-sh/pithy/commit/d0e1744f75cd0520252d36efb7309875fe678327), [`fa29441`](https://github.com/pithy-sh/pithy/commit/fa294411c8169e47f639c92e915fb248110bac08), [`ed1d57e`](https://github.com/pithy-sh/pithy/commit/ed1d57e1befc06a795f2ddd69d5b23c0697b8b53), [`18ca8f6`](https://github.com/pithy-sh/pithy/commit/18ca8f6a6636374e8aaabc12e25fd3de9d2c8716), [`2ad6948`](https://github.com/pithy-sh/pithy/commit/2ad69483ffe68d1afaadb16785eec6aa8e3a597a), [`add3283`](https://github.com/pithy-sh/pithy/commit/add3283159d54341c627a697780660380dd533e3), [`19312ab`](https://github.com/pithy-sh/pithy/commit/19312aba66567a06fa46ef3394711eadd3f8bd1e), [`e9abef5`](https://github.com/pithy-sh/pithy/commit/e9abef565cce1fba9aecfbb3d744915a80d90086), [`8ba0ad0`](https://github.com/pithy-sh/pithy/commit/8ba0ad022abdecc9544e07461f2d427b9c4d3e85), [`ffb4dfe`](https://github.com/pithy-sh/pithy/commit/ffb4dfe135a3b3bb306d9ba7a14aaa7103db14e2), [`832a853`](https://github.com/pithy-sh/pithy/commit/832a853ba486b174a39fb891d1de09b0f3a6a2c8), [`bf0994d`](https://github.com/pithy-sh/pithy/commit/bf0994d403aecd56e686d4f18d33361b02fe2dbc), [`790ef16`](https://github.com/pithy-sh/pithy/commit/790ef163f5d549d19b04e05e81c244af29bb997a), [`de57027`](https://github.com/pithy-sh/pithy/commit/de57027baf1d17e3554ba7da0821224fc2457bb1), [`84e3325`](https://github.com/pithy-sh/pithy/commit/84e332579c3ce5ac2c8e0d4f5e7134a4d8105413), [`1943dc4`](https://github.com/pithy-sh/pithy/commit/1943dc442ce72a081158b65d4053707b668e7d67), [`cf37943`](https://github.com/pithy-sh/pithy/commit/cf37943eb1a7853462f23a55c2dc12fe9a7d5c8f), [`513483b`](https://github.com/pithy-sh/pithy/commit/513483b8476fd6c32ea5e880211b869a2bb8a7cb), [`3bca514`](https://github.com/pithy-sh/pithy/commit/3bca514e9bfbe1bab8ddc62a8da622af252780ea), [`5f1dd10`](https://github.com/pithy-sh/pithy/commit/5f1dd10965494118a94ef5f0f11c1fd8726b9674), [`31542bd`](https://github.com/pithy-sh/pithy/commit/31542bd5318ab126de7fe9c1eeae0221ecaa7d6a), [`fc7f19f`](https://github.com/pithy-sh/pithy/commit/fc7f19f6a4248eef00c98d6e907a14846a99a169), [`6e3c977`](https://github.com/pithy-sh/pithy/commit/6e3c977fe0aa7d0644aeac8a07c4032b5432d764), [`fe6081a`](https://github.com/pithy-sh/pithy/commit/fe6081a7d517789e81b7772ed2dea7a56a2fb745), [`bc3c8ec`](https://github.com/pithy-sh/pithy/commit/bc3c8ec8efb26028878aaf5bac1d276ff159149e), [`cd5c150`](https://github.com/pithy-sh/pithy/commit/cd5c1504739fbf39513cd5b0dc469093007df903), [`5ff5dd1`](https://github.com/pithy-sh/pithy/commit/5ff5dd1ad98c9ab469436c7fa2425e38c0662a18), [`b1bf0fb`](https://github.com/pithy-sh/pithy/commit/b1bf0fbee38e1f2e3854b529502e8046f7327f49), [`998cf04`](https://github.com/pithy-sh/pithy/commit/998cf0466a8a1ff2244feb4b643a6293b778c3cf), [`6bed5b6`](https://github.com/pithy-sh/pithy/commit/6bed5b6f4e88628dd789dec5b3ca77c4cf492e72), [`a2a6e83`](https://github.com/pithy-sh/pithy/commit/a2a6e832b2fde486dc1dfd3fe1e47189d7b872c4), [`c008dc4`](https://github.com/pithy-sh/pithy/commit/c008dc473f016802c8baec33952564a4f83be95c), [`0e72c11`](https://github.com/pithy-sh/pithy/commit/0e72c114da84c2c327db2174eb3a091571db654e), [`441cc56`](https://github.com/pithy-sh/pithy/commit/441cc56be62c067efc83b46ec93d78c0ef6e24c3), [`52a7896`](https://github.com/pithy-sh/pithy/commit/52a7896a425163dd00c751fa9928d4b48e7b177f), [`0d14086`](https://github.com/pithy-sh/pithy/commit/0d140860f5907f04fc362f9f9e4debe2b21328e9), [`97cd84a`](https://github.com/pithy-sh/pithy/commit/97cd84ad01b94e6392de31f48eee7fcd7d23d653), [`a35e37b`](https://github.com/pithy-sh/pithy/commit/a35e37b0b5f9116ecfa633b8f8df968ce67d964d), [`bd0f23c`](https://github.com/pithy-sh/pithy/commit/bd0f23cb5474cd1fadbe870f3cc3156cefa13782), [`afa106f`](https://github.com/pithy-sh/pithy/commit/afa106f9ab58d4664eb2688711fdc925551ead11), [`6226fc4`](https://github.com/pithy-sh/pithy/commit/6226fc48b5ca900d2e35f7c8fb6c29b7bf02b2a2), [`9abb6d3`](https://github.com/pithy-sh/pithy/commit/9abb6d3b84a0f35c88897ebebe10273838dd1562), [`7e7af9d`](https://github.com/pithy-sh/pithy/commit/7e7af9d9ff93b2692e0de920819ea12146cdb6c1), [`a81d012`](https://github.com/pithy-sh/pithy/commit/a81d0123dd13dfb41736927bc47801a6e475a095), [`bc1ddf1`](https://github.com/pithy-sh/pithy/commit/bc1ddf137d253790dc74633b09cb505fb1865bd6), [`1131567`](https://github.com/pithy-sh/pithy/commit/1131567f6a1074d65ecf4bc0129dfe2c4287d0cf), [`47e40ff`](https://github.com/pithy-sh/pithy/commit/47e40ff274e03100da64b87f5af190bf3025f2e4), [`52b27f7`](https://github.com/pithy-sh/pithy/commit/52b27f7f67b5741ead702323d57754f2c07a4aad), [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27), [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27), [`36a66e7`](https://github.com/pithy-sh/pithy/commit/36a66e70630552c86722c71e62783a42cc094f27), [`2ea39d9`](https://github.com/pithy-sh/pithy/commit/2ea39d946f458d78a25fa54f47584cd98a982dfc), [`2ea39d9`](https://github.com/pithy-sh/pithy/commit/2ea39d946f458d78a25fa54f47584cd98a982dfc), [`0986bda`](https://github.com/pithy-sh/pithy/commit/0986bdaac380f740c1fbc2953078f5e23137f356), [`0133b53`](https://github.com/pithy-sh/pithy/commit/0133b53ccec0eb03664bb3ff289a19f4c716d33c), [`8c90e2c`](https://github.com/pithy-sh/pithy/commit/8c90e2c5b22b5a16e8372450af0d8068cfdacd29), [`4ef5951`](https://github.com/pithy-sh/pithy/commit/4ef595178dddfc38e128f16c560cb9aa7769f1ae), [`05fb8b4`](https://github.com/pithy-sh/pithy/commit/05fb8b4c83d0cd2aa923709cc0dac00010b1971d), [`55af6d2`](https://github.com/pithy-sh/pithy/commit/55af6d2e421b8f476901e914124648e0c0ba0334), [`802513a`](https://github.com/pithy-sh/pithy/commit/802513a473828eee404b08d328a912b6b1faa8a4), [`31a7620`](https://github.com/pithy-sh/pithy/commit/31a7620a6bc5a05d43a4ec00cb4395af28fff0a5), [`2337456`](https://github.com/pithy-sh/pithy/commit/2337456baed2faba0372d19d88489eb4ad80254b), [`31dd6e9`](https://github.com/pithy-sh/pithy/commit/31dd6e935b157a5dac4d23eec9ca2f5b60b4f3b3), [`1071ace`](https://github.com/pithy-sh/pithy/commit/1071aceaad8a9d9e4acc9ac8b14c239cdc6ffe31), [`157bb56`](https://github.com/pithy-sh/pithy/commit/157bb5660cd6429c45d617ae79258b7bbcd872a3), [`3d532e5`](https://github.com/pithy-sh/pithy/commit/3d532e57051b854b15444e39d4089e7e0b7184e1), [`c9f2016`](https://github.com/pithy-sh/pithy/commit/c9f2016f3472213f9360bce740cac969f1efb632), [`280c41c`](https://github.com/pithy-sh/pithy/commit/280c41cf562a43d0ec3b84b904b18b3c8b816e9a), [`0966b3f`](https://github.com/pithy-sh/pithy/commit/0966b3f01426857b2024662f6e5f98aac4336411), [`8ee9a7f`](https://github.com/pithy-sh/pithy/commit/8ee9a7faa71f641bdcf362d4c05cd3cd7687c64e), [`b5a35bc`](https://github.com/pithy-sh/pithy/commit/b5a35bc70838c3b4d7ce277bf25b56aadecb5143), [`a9d0368`](https://github.com/pithy-sh/pithy/commit/a9d0368637888d18a136251e41e97de3dd08347b), [`067355c`](https://github.com/pithy-sh/pithy/commit/067355c9eb378744ea2f98a368a5f46a07e74fca), [`818a596`](https://github.com/pithy-sh/pithy/commit/818a59624d1b2fa4370cd713abb66f3bdbbc746f), [`829ead9`](https://github.com/pithy-sh/pithy/commit/829ead903f8b41574f3581d659761e88a2d56d9a), [`b9219d8`](https://github.com/pithy-sh/pithy/commit/b9219d83ab90b7bc69ede9b590f2cc7ee5855d35), [`2bfb410`](https://github.com/pithy-sh/pithy/commit/2bfb41068b43979e5ff127b20bb5193b7a724410), [`8659595`](https://github.com/pithy-sh/pithy/commit/86595955a0f190d7c8efa534c0bfed23e532b21c), [`aaaeeff`](https://github.com/pithy-sh/pithy/commit/aaaeeffce8e921e2dbf71e946768cffd1da6cace), [`bb65b40`](https://github.com/pithy-sh/pithy/commit/bb65b409a2c1fcdf262de7d39c00314ff135979c), [`dd224b1`](https://github.com/pithy-sh/pithy/commit/dd224b1aeffcb0bc9b0c105015acc5b460817d94), [`3c8ffb3`](https://github.com/pithy-sh/pithy/commit/3c8ffb30480595354e83447c8dda2e2e9611f4a1), [`0ee382b`](https://github.com/pithy-sh/pithy/commit/0ee382b9c6eafbbe42f79fd9ac225ed11bbfb03f), [`0ee382b`](https://github.com/pithy-sh/pithy/commit/0ee382b9c6eafbbe42f79fd9ac225ed11bbfb03f), [`fcb9502`](https://github.com/pithy-sh/pithy/commit/fcb950247371ca44c978b600d5bc1bdbd72b93b9), [`1f6afb8`](https://github.com/pithy-sh/pithy/commit/1f6afb89661b03639018c6854616d8a26931d24b), [`c645d19`](https://github.com/pithy-sh/pithy/commit/c645d190022da1bde420d1f03c30bbd98f007234), [`c58405e`](https://github.com/pithy-sh/pithy/commit/c58405ef35bf57cbd0ddf70c5f8651bba90d6b4f), [`0ce4cea`](https://github.com/pithy-sh/pithy/commit/0ce4cea8e8995dc5fe38601fda130a65e84b95b0), [`67d2cc4`](https://github.com/pithy-sh/pithy/commit/67d2cc4633f0fd66e328092e2aabce1dead48713), [`5668f08`](https://github.com/pithy-sh/pithy/commit/5668f0874a8df0fa9ad8477f3e1b48b46c181054), [`a4ab423`](https://github.com/pithy-sh/pithy/commit/a4ab423f07fd8d77061930c602444d5e9562d208), [`6f31178`](https://github.com/pithy-sh/pithy/commit/6f311786f8e2784d4fae7d95c9070e16e37e48c5), [`288848e`](https://github.com/pithy-sh/pithy/commit/288848e849f2aadf1f9444b3db03d94b781a0e1b), [`d74ce14`](https://github.com/pithy-sh/pithy/commit/d74ce140f5c19848eb7415d6b6ee86815107f83c), [`14ea4eb`](https://github.com/pithy-sh/pithy/commit/14ea4ebc48d29c0ee4bce102998afdadba39458f), [`af1871b`](https://github.com/pithy-sh/pithy/commit/af1871b7e467d4e69e287038deaa0023e9c94ac3), [`e92a9a0`](https://github.com/pithy-sh/pithy/commit/e92a9a0d3658745909e36d7d4c42a53716351653), [`535755a`](https://github.com/pithy-sh/pithy/commit/535755a799a16e290b745eb18cf50aba6113bbbe), [`a9fe34f`](https://github.com/pithy-sh/pithy/commit/a9fe34f7d3a1ec4bb881de3604b0f37d7ebcf982), [`f238b0a`](https://github.com/pithy-sh/pithy/commit/f238b0a63d16608bf203ffc763f800f29d535a80), [`b22db91`](https://github.com/pithy-sh/pithy/commit/b22db91d2dcd39b4c95bd53f082c98e5df952fff), [`0ad7c74`](https://github.com/pithy-sh/pithy/commit/0ad7c744a8898824e1dc9de075afec7dd81f079a), [`4b57172`](https://github.com/pithy-sh/pithy/commit/4b57172c27bf872d751f1bbe48eff412aedb9c02), [`2811006`](https://github.com/pithy-sh/pithy/commit/2811006b836a63d56002e0858ec6db697698807e), [`d42946d`](https://github.com/pithy-sh/pithy/commit/d42946d4ad2c6b78240fb99f29fb85dc5ff30ae2), [`309a384`](https://github.com/pithy-sh/pithy/commit/309a38476c57f4d33e01f67cc08f06436bf292e2), [`5dc508a`](https://github.com/pithy-sh/pithy/commit/5dc508a20d19c6e03beca35b799df8df9e772252), [`241ce03`](https://github.com/pithy-sh/pithy/commit/241ce0371d16cd9883ac7fdb7badc04247ca3a04), [`fdba68c`](https://github.com/pithy-sh/pithy/commit/fdba68c1daffe094d566b0f37ba305ca2f715f85), [`9ff81a6`](https://github.com/pithy-sh/pithy/commit/9ff81a669637f966f2c616c0e7f565d633650729), [`e5b8a60`](https://github.com/pithy-sh/pithy/commit/e5b8a6072612d8e0a331833c0bc6e2b7c86b9ce4), [`3133990`](https://github.com/pithy-sh/pithy/commit/3133990da6dda8af5f2d0dffc34fa919ff3564c5), [`16163db`](https://github.com/pithy-sh/pithy/commit/16163dbc7ef1e4a2f01410edc94253f406fcd503), [`14ea4eb`](https://github.com/pithy-sh/pithy/commit/14ea4ebc48d29c0ee4bce102998afdadba39458f), [`5d69fb5`](https://github.com/pithy-sh/pithy/commit/5d69fb57c06d6a8d28a2bce43ccc3cf6e0c04097), [`d60788a`](https://github.com/pithy-sh/pithy/commit/d60788ac98e4317368156bdac438cebd621788a2), [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6), [`16163db`](https://github.com/pithy-sh/pithy/commit/16163dbc7ef1e4a2f01410edc94253f406fcd503), [`1e8c8c7`](https://github.com/pithy-sh/pithy/commit/1e8c8c7f80ca5f3b96ad48c859c90ac264c6c3f3), [`0ff0cd5`](https://github.com/pithy-sh/pithy/commit/0ff0cd54cb926a015b3bac7383976a36729788d4), [`532e438`](https://github.com/pithy-sh/pithy/commit/532e4381fe863d723734cb16841411d5d7541c52), [`128f0d3`](https://github.com/pithy-sh/pithy/commit/128f0d32907cbcc3856c38dc4b2d590e1423b156), [`96e5f51`](https://github.com/pithy-sh/pithy/commit/96e5f5120fd496665bb1019d8465183ae9e02e5a), [`24ae9cd`](https://github.com/pithy-sh/pithy/commit/24ae9cd339894399b424506902bcf7076ff6530b), [`9b5f242`](https://github.com/pithy-sh/pithy/commit/9b5f242a1e522feb1f7c04d7357bcdbc590bce9d), [`b84ec9e`](https://github.com/pithy-sh/pithy/commit/b84ec9ec2b785d4756067f6fdc8c4780bf978e1e), [`0bb29e2`](https://github.com/pithy-sh/pithy/commit/0bb29e26617e3003ea1229415b623e0bb658f205), [`6d17f2c`](https://github.com/pithy-sh/pithy/commit/6d17f2cc6fb964993cd6005115834c3ad1540ee6), [`20c4f6c`](https://github.com/pithy-sh/pithy/commit/20c4f6c55b628318a700840ca9584b433eeaca3d), [`3c011eb`](https://github.com/pithy-sh/pithy/commit/3c011eba0febe0f9c2a179388e48905beae17e1e), [`3a65e71`](https://github.com/pithy-sh/pithy/commit/3a65e71641d23d34a73d0b73128c7c02f0e65410), [`6f31178`](https://github.com/pithy-sh/pithy/commit/6f311786f8e2784d4fae7d95c9070e16e37e48c5), [`324d771`](https://github.com/pithy-sh/pithy/commit/324d771a67866cf6ecc9aee82c36fd5d31512a60), [`3a65e71`](https://github.com/pithy-sh/pithy/commit/3a65e71641d23d34a73d0b73128c7c02f0e65410)]:
  - @pithy-sh/cloudflare@0.1.0
  - @pithy-sh/core@0.1.0
  - @pithy-sh/secrets@0.1.0
  - @pithy-sh/ui-react@0.1.0
  - @pithy-sh/turnstile@0.1.0
  - @pithy-sh/email@0.1.0
