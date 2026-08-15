---
"@pithy-sh/cli": minor
---

`pithy doctor`'s eleven probes each keep their own failure, and none of them can take the report.

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
