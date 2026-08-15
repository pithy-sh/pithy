---
"@pithy-sh/secrets": minor
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
---

`pithy secrets rotate` — a secret declared how it rotates, and now something rotates it

#322 landed the declaration: `rotation.kind` of `local`, `provider` or `manual`, per secret, crossing into `pithy.manifest.json` so any client can branch on it. Nothing acted on it. `pithy secrets` had `create`, `update`, `rm`, `ls`, `edit`, `provision` and `deprovision`, and a management client could not honestly draw a rotate control over a command that did not exist.

```
pithy secrets rotate <NAME> --env <env> [--dry-run] [--json]
```

**Built around the one failure it cannot undo: a provider roll succeeds and the store write fails.** The old credential is dead at the issuer, the new one exists only in the process that received it, and rolling again issues a third value and loses the second — so the retry meant to save it is what destroys it. The ordering is the design. Every refusal happens before anything is called; the value is produced exactly once; the store is retried three times against that same value and never reaches back for a fresh one.

That state is reported as its own outcome, with the secret named and the environments still holding the retired credential named beside it, and it exits **3** — distinct from `1`, which means the previous value is still live and the command can simply be run again. It carries its own error code, `secrets/rotation_unrecorded`.

**The value is discarded when the store will not take it, and the failure says so.** Printing it would leave a live production credential in shell scrollback, in the CI log, and in whatever recorded the session — permanently. The failure instead names the issuer, its documentation page, and the `pithy secrets update` that records a value rolled by hand, all composed from the declaration #322 added. The rotation result has no field that could carry a value, so this is structural rather than a habit.

- **`local`** re-mints from the same recipe that created the value. **`provider`** calls a rotator attached to the registry entry — the seam `rotation/valueRotator.ts` declared inert and this makes live. **`manual`** prints the console, the page, and the command that records the result, calls nothing, and never prints `Done.`
- **`--dry-run`** resolves the declaration and stops. No account, no credentials, nothing rolled.
- **No `--all`.** A fleet rotation wants more than one confirmation *and* an audit entry naming the operator, and a CLI audit records `system, actorResolutionFailed` when no Cloudflare token names one. The act most certain to be reviewed afterwards would be recorded as *somebody with the token*. `pithy secrets ls` and a shell loop force the operator to see the list first.
- `SECRETS_ENCRYPTION_KEYS` is refused by name: it is the key every other secret is read through, and it rotates on its own axis inside the manager.
- Rotations are audited as `secrets/rotated`, `critical` on the unrecorded state, carrying the name and the environments and nothing else.

Driven end to end with the real binary against a local stand-in for the Cloudflare Workflows API, including the forced roll-succeeded-store-failed path — asserting the rotator rolled exactly once across three store attempts, and that no value it issued reaches either stream or any file the CLI writes.
