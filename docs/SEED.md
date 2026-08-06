# Seeding data (`pithy seed`)

`pithy seed` loads test data into a Pithy project from the same Zod schemas and codecs that define your tables and KV stores.

There is no separate fixture format to learn.

A seed fixture is a set of app-shape values — the same shape your application code reads and writes — and the write path re-validates every one of them before anything touches a database.

This document is the authoring guide: how a capability (or your app) declares a seed set, how sets from every capability compose into one ordered run, the media upload model, the standard Cloudflare-asset metadata convention, and the layered safety model that keeps `pithy seed` from ever touching production by accident.

For the command's flags and output, see `docs/CLI.md` Section 7.

## The mental model

`pithy seed` is the direct analog of `pithy migrate`.

A migration describes schema changes; a seed set describes rows, entries, and assets.

Both are namespaced per capability, ordered, composed library-before-app into one registry, and run by a single CLI command against a named `--env`.

Where a migration's unit of work is a table change, a seed set's unit of work is a batch of fixtures for D1, KV, R2, and the shared media stores (Images and Stream).

## Authoring a seed set: `defineSeed`

A capability (or your app) exports one or more `SeedSet` values built with `defineSeed`, the peer of `defineCapability`.

```ts
import { defineSeed, d1SeedGroup } from "@pithy-sh/core/src/seed/seed";
import { BoardEntry } from "./data/entry";

export const demoBoardSeed = defineSeed({
  name: "demo_board",
  order: 1,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", "boardEntries", BoardEntry, [
      { id: "demo-1", boardId: "weekly", userId: "demo-user-1", score: 4200, createdAt: new Date() },
      { id: "demo-2", boardId: "weekly", userId: "demo-user-2", score: 3100, createdAt: new Date() },
    ]),
  ],
});
```

A few things to notice:

- **Rows are app-shape values.** `createdAt` above is a real `Date`, not an epoch number — the same shape your application code produces. `d1SeedGroup`'s third argument is the table's Zod schema, used only at compile time to bind the fourth argument's row type to `z.output<Table>`; it is not stored on the group. The write path resolves the live schema itself from the project's composed database registry, so a fixture never redeclares it and can never drift from the real table shape.
- **`order` controls composition order**, exactly like a migration's ordinal — libraries seed before the app, and ties break on the namespaced key. It must be an integer in `0..9999`.
- **`environments` is the allowlist.** This set is only ever composed into a run targeting `dev` or `staging`. Listing `"production"` is the only way a set is ever seeded into production — there is no default-on environment.
- **`example: true`** marks a demo/quick-look fixture. Example sets are entirely absent from the registry unless the project opts in (see "Project configuration" below) — they are not filtered per-run, they simply do not exist until enabled.

`kvSeedGroup` is the KV equivalent, binding entries to a store's key/value/metadata schemas the same way:

```ts
import { kvSeedGroup } from "@pithy-sh/core/src/seed/seed";
import { sessionStore } from "./kv/sessions";

const sessionSeed = kvSeedGroup("app", "sessions", sessionStore, [
  { key: { userId: "demo-user-1" }, value: { token: "demo-token", expiresAt: Date.now() + 3600_000 } },
]);
```

R2 objects have no schema layer — an `R2SeedItem` is just `{ binding, key, body, contentType, metadata? }`, written as-is.

## Composing per-capability and per-app

A capability contributes its seed sets on `Capability.seeds` (a peer of `databases`, `migrations`, and `kvNamespaces`).

`pithy seed` composes every installed capability's sets — plus your app's own — into one ordered, namespaced registry: each set's composed key is `NNNN_<capability>_<name>` (the zero-padded `order`, then the capability, then the set's own name), so the run order is stable across releases and dependency-correct: libraries before the app.

A seed set name must be unique within its own capability; reusing one is an authoring mistake caught at compose time, not silently overwritten.

A set whose `environments` does not list the target `--env` is dropped from the run, but its key is still reported — `pithy seed` tells you it refused a set rather than quietly doing nothing.

## Writing: validation, then insertion

Every row and entry is validated before anything is written.

For D1, that means `schema.encode(row)` — the exact inverse of the `schema.parse(row)` your application reads with — runs on every row in a group before the group's insert executes. A single bad fixture fails the whole group with a clear, field-level validation error, and nothing for that group lands. For KV, the store's own `put` validates the value (and metadata) against its schemas the same way.

Once validated, the write itself is deliberately boring:

- D1 rows insert with `INSERT OR IGNORE` — re-running `pithy seed` against an environment that already has the fixtures loaded inserts nothing new and never overwrites what's there.
- KV entries `put` by key, which is naturally idempotent.
- `pithy seed` never updates or deletes existing data. It only ever adds rows and entries that are not already present.

This is why `pithy seed` is safe to run repeatedly, and safe to run as a step in an automated CI pipeline that provisions an ephemeral environment.

It also means editing a fixture's values and re-running `pithy seed` does nothing — the row already exists, so it is left alone.

`pithy seed --redo` is the escape hatch: not a per-row refresh, but a full schema reset (every migration's `down`, then every `up`, then a normal seed) that destroys and recreates every table the migration registry owns before writing the fixtures fresh. See `docs/CLI.md` Section 7.5 for its exact behavior and safety gate.

## Media: `once` and `always`, and UUID write-back

Some fixtures need real bytes — an avatar, a demo thumbnail — uploaded to Cloudflare Images or Stream, not just a database row. A `MediaSeedItem` describes one of these:

```ts
{
  store: "images",
  mode: "once",
  file: "./fixtures/avatar.png",
  ref: "./fixtures/avatar.ref.json",
  metadata: { userId: "demo-user-1" },
  record: { database: "app", table: "userAvatars", row: { userId: "demo-user-1" } },
}
```

`file` and `ref` are paths relative to the seed module's own directory (or absolute).

- **`file`** points at the asset bytes to upload.
- **`ref`** points at a small JSON sidecar — `{ "id": "<minted-uuid>" }` — that records the id Cloudflare mints for the upload.

Two upload policies:

- **`once` (the default).** The first run has no recorded id, so it uploads the bytes and writes the minted UUID back into the `ref` sidecar, atomically (a temp file, then a rename — a crash mid-write never leaves a torn sidecar). Every later run reads the sidecar, finds the recorded id, and skips the upload entirely — no re-upload, no new id minted. This is what makes a demo avatar or a shared fixture image stable across every `pithy seed` run from every developer's machine: the first person to seed a fresh environment mints it, and it stays that one asset from then on.
- **`always`.** Every run re-uploads the bytes and never writes a UUID back. Use this only for assets that are genuinely meant to be replaced each run — it is the exception, not the default.

If `record` is set, `pithy seed` writes (or ignores, per the same `INSERT OR IGNORE` rule) a D1 row that references the minted id — the row's `id` field is filled in automatically with the freshly minted (or previously recorded) UUID if the fixture leaves it unset, so a media fixture and its asset row always agree on the id without you wiring it by hand.

Media uploads are the one part of `pithy seed` that always talks to a live Cloudflare account — Images and Stream have no local emulator, so seeding media (even with `--env dev`) needs real Cloudflare credentials. A `dev` run with no media items in its sets never needs them.

## The standard Cloudflare-asset metadata convention

Every asset `pithy seed` uploads to Images or Stream is stamped with a small, stable metadata block, built by `buildAssetMetadata(env, extra?)`:

```ts
{ ...extra, pithyEnv: env }
```

The one standard key today is `pithyEnv` — the environment the asset was created in. It is applied *after* any app-defined `extra` fields, so your own metadata (like `userId` above) can never accidentally shadow the scoping key.

This convention is not specific to seeding — it is the account-wide rule for any write to a shared Images or Stream store. Seeded assets are simply its first consumer. The reason it matters: it is what lets a staging teardown find and remove only staging's assets, never touching anything a production write created. Keep relying on `pithyEnv` (and any future standard key) rather than inventing a parallel scheme per capability.

## Late-bound fixtures: `prepare`

A fixture is normally a literal. Some cannot be — a row that has to agree with a value the running app will verify, like a signed cookie or an id derived from a secret, is not knowable when the module is written.

A set may declare a `prepare` hook for exactly that. It runs once per Worker, immediately before that set's static rows are written, and returns more of the same groups plus any transient files:

```ts
defineSeed({
  name: "dev-session",
  order: 110,
  environments: ["dev"],
  prepare: async (context) => {
    const secret = await context.secret("auth-session-secret");
    return {
      d1: [d1SeedGroup("app", "sessions", Session, [buildSession(secret)])],
      artifacts: [{ file: "session.json", contents: "…" }],
    };
  },
});
```

The context is deliberately narrow: `env`, `project`, a `secret(name)` reader, and the developer's machine-local `preferences`. It hands over **values and callbacks, never the filesystem** — a capability module is bundled into the Worker, where `node:fs` is a build error, so the CLI does every read and write on its behalf.

- Prepared groups go through the identical `schema.encode` validation as static ones. A prepared row is not a privileged row.
- `artifacts` are written **after** the rows land, into the project's gitignored `logs/`. The directory is not the fixture's to choose, and a file name with any directory part is refused.
- `secret` resolves from `.dev.vars`, which is where local dev's secrets genuinely live. A deployed environment's secrets are not on the operator's disk, so a set that needs one must be `dev`-only.
- A dry run never calls `prepare`. Planning touches no backend and needs no credentials.

### The dev login

`@pithy-sh/auth` ships the first of these. Sign-in is passwordless, so every local sign-in is a magic link — correct in production, a tax in development, and impossible for anything automated.

With `seed.includeExamples` on, `auth`'s `dev-session` set mints a **real** session for a seeded user and writes `logs/dev-login.json`. `pithy dev` reads it and prints, on the ready banner, a line you paste into the browser console to be signed in.

It is opt-in per machine, not per repo. Create `~/.config/<project>/dev.json` (or `$XDG_CONFIG_HOME/<project>/dev.json`):

```json
{ "user": "ada@example.com" }
```

No file, no session — the default stays "there is no way in but a magic link". A file naming a user no seed creates fails with the seeded emails rather than quietly seeding nothing.

The cookie is signed the way Better Auth signs its own, and its token is derived from a fingerprint of the auth secret. That makes it deterministic across reseeds — the same cookie keeps working in every worktree once each is seeded — while rotating the secret invalidates every previously seeded cookie for free.

**The file is a live credential** for your local database. It lives under `logs/`, which the starter template gitignores. Do not move it, and do not commit it.

## The layered env-safety model

Nothing about `pithy seed` trusts a single check. Three independent layers stand between a fixture and a write, and each is enforced at a different point so bypassing one still leaves the others:

1. **The allowlist, enforced at compose.** A set is only ever part of a run's registry if its own `environments` array lists the target `--env`. This is not a flag you pass at the command line — it is authored once, on the fixture itself, by whoever wrote it. `production` is never in a set's `environments` unless someone deliberately put it there.
2. **The allowlist, re-enforced at write time.** Even though compose already filtered disallowed sets out, the write path re-checks each set's `environments` immediately before writing it. A set can never reach a disallowed environment through any code path that skips compose.
3. **Escalating confirmation, enforced by the command.** `dev` runs freely. `staging` (and any other non-`dev`, non-production name) requires `--yes`. A production environment requires `--yes` **and** an exact, case-insensitive, trimmed match of the phrase `yes, i really want to seed production` — typed interactively when a human is at a real terminal, or passed via `--confirm-production` in CI. See `docs/CLI.md` Section 7.3 for the exact flags and output.

An environment counts as production if it is named `production` or `prod`, **or** if you list its name in `seed.productionEnvironments`. If your production environment is named anything else — `live`, `prod-eu`, `main` — declare it there, or it escalates only to `--yes` and never demands the phrase:

```ts
export default definePithyConfig({
  // ...
  seed: {
    productionEnvironments: ["live", "prod-eu"],
  },
});
```

Because every write is also idempotent and non-destructive (D1 `INSERT OR IGNORE`, KV `put`-by-key, `once` media that only ever uploads once), even a seed run that was authorized by mistake can never overwrite or delete anything that already exists — it can only add fixtures that were not there yet.

## Project configuration: `seed.includeExamples`

Some capabilities ship a tiny example seed set — a demo leaderboard, a couple of sample rows — flagged `example: true`, meant for a quick first look at a fresh `pithy init`.

Example sets are opt-in and off by default. Enable them in `pithy.config.ts`:

```ts
export default definePithyConfig({
  // ...
  seed: {
    includeExamples: true,
  },
});
```

With `includeExamples` off (the default), example sets are not merely skipped — they are absent from the registry entirely, so `pithy seed --dry-run` never even lists them. An example set never targets `production` regardless of this setting; it is a dev/staging convenience, not a production data source.

### A connected cast, not scattered rows

Pithy's own example seeds are wired together around a small, fixed cast of test users. `@pithy-sh/core` exports `EXAMPLE_IDENTITIES` — three canonical demo users (Ada, Grace, Alan), each a stable `id` and an `example.com` email — from `@pithy-sh/core/src/seed/exampleIdentities`.

Every capability's example set references that same cast. `auth` seeds the three as verified passwordless users; `leaderboard` gives them scores on a `demo` board; `ledger` opens a balance for each in a demo `coins` currency; `payments` gives Ada a live Apple subscription, Grace a Stripe non-consumable, and Alan a refunded Google consumable — one row per rail, one per product type; `multiplayer` records one resolved match Ada wins; and `audit` writes a short timeline of security events attributed to them — a login, a denied attempt, an entitlement grant, an admin change, a critical token-reuse alert, a debit — so the licensed dashboard has real data to render. So a fresh project with `includeExamples` on comes up with a backend where the same three people own connected data across every table — the point of seeding, made visible.

`EXAMPLE_IDENTITIES` is the seam that makes this possible without coupling capabilities to each other: each reads the ids from core, the one dependency they all already share, never from `@pithy-sh/auth`. Compose order encodes the dependency — `auth` (order 100) seeds the users before the sets that reference them (200–300) run. When you author your own connected fixtures, do the same: pick stable ids in one shared module and reference them everywhere.
