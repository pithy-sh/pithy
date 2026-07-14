# Ejecting a capability

Pithy keeps your repo thin: a capability's handler logic lives in its `@pithy-sh/*` package and upgrades with minor releases (principle 3). `pithy add <capability>` scaffolds only **config** — the registration, bindings, and options in `pithy.config.ts` and `wrangler.jsonc`. It never writes handler source.

Sometimes you need to fork that logic — bend a route, change a flow, do something the config options don't expose. `--eject` is the escape hatch.

## What eject does

```bash
pithy add auth --eject
```

This installs and adds the capability the normal way, then ejects it:

- **Copies the source.** The capability's entire `src/` is copied from `node_modules/@pithy-sh/auth/` into `<project>/capabilities/auth/`, structure and relative imports preserved. Routes, middleware, schemas, migrations — all local and editable.
- **Repoints the wiring.** The `pithy.config.ts` import moves from `@pithy-sh/auth/src/index` to `./capabilities/auth`. The registration, bindings, and config options are unchanged.
- **Promotes dependencies.** The capability's runtime dependencies (e.g. `better-auth`, `zod`) — transitive through the package until now — are added to your `package.json`, so the local copy builds standalone. `@pithy-sh/auth` is left installed but unimported, and safe to remove.

After eject, your project imports nothing from `@pithy-sh/auth`. The ejected code still resolves `@pithy-sh/core` (the contract seam) and third-party libraries.

## The trade-off

**This is the only path that writes handler source into your repo, and it is one-way.** The capability is now yours: no part of it upgrades. Security fixes and improvements in `@pithy-sh/auth` no longer reach it — maintaining the fork is your responsibility. `pithy upgrade` reconciles only package-served capabilities; it detects an ejected capability by its local `./capabilities/<name>` import and skips it.

There is no un-eject. Re-attaching a fork to the package is not supported by design.

## Guardrails

- **Idempotent.** `pithy add <cap> --eject` installs, adds, and ejects in one command; because `add` is idempotent, running it against an already-added capability simply ejects it.
- **No clobber.** If a local copy already exists, eject refuses rather than overwrite your edits. `--force` re-copies from the package, discarding local changes (it removes the old copy first, so stale files don't linger).
- **Agent-drivable.** Non-interactive, with `--json` naming the copied path and the promoted dependencies. Every failure is a `PithyError` with a problem line and an action line.
