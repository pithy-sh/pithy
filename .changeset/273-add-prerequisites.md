---
"@pithy-sh/cli": patch
---

`pithy add auth` left a project that could not boot.

`auth` composes against `secrets` and `email` — it reads provider credentials and a session secret through one, and sends magic links and OTPs through the other — and `createBackend` has always refused to assemble without them: `Capability "auth" requires the "secrets" capability, which is not composed.` `pithy add` registered neither. So the command reported `Done.`, `pithy doctor` reported a healthy project, and `pithy dev` failed to start. The first five minutes ended on a stack trace from a command that had said it was finished.

**A capability declares what it composes against, and `pithy add` acts on the declaration.** `peerCapabilities` was already in every `pithy.manifest.json`; nothing read it. Not a special case for auth: `payments`, `support`, `storage`, `media` and `turnstile` all declare `secrets`, `testers` declares `email`, and hand-listing them at the command is how the next one gets missed.

They resolve as a **graph**, deepest first — `secrets`, then `email`, then `auth` — because `email` reads a secret at boot, and a plan that echoed the manifest's array would compose them in whatever order it was written in. Each prerequisite is a real `pithy add`: its package, its bindings in every environment stanza, its dev secrets, its own audit event. Their notes come back ahead of the capability's own, so the dev master key `pithy add secrets` mints is still printed exactly once.

**Add, or refuse?** Both, decided by what the run can be asked. A terminal is asked once for the whole cascade. `--with-prerequisites` composes them without asking. Anything else — `--json`, no TTY, an agent — is refused, exit 1, naming the exact commands in the order they must run, with nothing written. Composing something nobody asked for is not a thing to do behind an adopter's back; reporting success on a project that cannot boot is worse.

**`pithy doctor` reports it and fails the exit.** A new `prereqs` line, first in each Worker's block, because it is the only check there that is not drift: a Worker failing it does not start, so every line under it describes a Worker that is down.

**And `pithy add` now applies the migrations it says it runs.** Found while proving the above end to end. `add` re-reads the Worker config it has just written to build the migration registry, and the module cache returned the module from *before* the write — Bun keys it on the resolved path, and neither a query string nor a differently-spelled path busts it. So every `pithy add` reported a clean run and applied nothing, and the Worker that finally booted answered 500 on every route that touched a table. The post-write read now goes through a uniquely-named copy beside the original.

The five-minute path — `pithy init`, `pithy add auth --with-prerequisites`, `pithy dev`, sign in — works end to end, and is covered by tests that spawn the real binary.
