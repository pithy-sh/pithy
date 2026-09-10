---
"@pithy-sh/cli": patch
---

`pithy provision` says what it will do, then says what it is doing.

It reached an account, resolved every Worker, minted secrets and created databases without printing a character until all of it had settled. A run against a slow account and a hung command looked the same, which is how an operator comes to interrupt work that was fine.

`docs/CLI.md` §3.1 already specified this — an operation in progress prefixes with `▸` and a trailing `...`, and §3.2 ends with `Done.` — and `provision` implemented none of it. The lines were not missing either: the summary already composed `<name>: created.` per resource and simply held every one of them until the end.

So a plan comes first, printed where the confirmation lives — `assertProvisionConfirmed` is the moment an operator is asked to authorize real Cloudflare resources, and it asked without naming one. Then a `▸` line as each resource is reached, and the settled line in place beside it rather than in a block at the end. The plan is the run's own input: the resource set, the Worker set and the store entries come from the same resolution the work loop takes, so a plan cannot drift from what follows it.

Most of the silence was *before* the loop, which is why streaming it alone was not the fix. And the pairing is what makes an interrupted run readable — provisioning is idempotent, but idempotence only helps someone who knows where it stopped, and the last `▸` names the resource that was in flight.

Plain lines, printed once, never redrawn: a repainting spinner would collapse the history this exists to leave behind and write cursor escapes into every CI log. `--json` is untouched — still exactly one line, byte for byte, pinned by a test.

`pithy secrets provision` needs the same treatment and does not have it yet.
