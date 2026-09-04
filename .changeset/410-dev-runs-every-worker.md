---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
"@pithy-sh/email": minor
---

`pithy dev` runs every Worker your project composes, and mail sent from localhost is delivered for real.

Signing in with a magic link against `pithy dev` wrote a row, called `sender.create(...)` on a Workflow binding naming a Worker that was not running, swallowed the throw on purpose, and left the job `pending` forever while the screen said "Check your inbox." The safety net that justifies the swallow is a cron on the same absent Worker. A developer's first conclusion is that their Cloudflare Email Service setup is wrong, and they go and check it, because the product told them the mail was sent.

**It was never an email problem.** Nine capabilities ship a committed host-Worker template — email, media, payments, storage, support, testers, vector, secrets and leaderboard — and `discoverWorkers` enumerates `apps/*` and only `apps/*`. No capability host had ever run under `pithy dev`. Email is simply the one with a symptom a person notices, because a magic link is the first thing anyone tries.

**A host Worker is now an ordinary member of the dev set:** a pinned port, a label and color in the terminal and `logs/dev.log`, an entry in `.dev-state.json`, reaped with everything else. One `wrangler dev` per Worker — the process model did not change.

**Pithy wires the dispatch; wrangler does not.** `<STEM>_PORT` and `<STEM>_ORIGIN` were already how a Pithy Worker reaches a sibling, so a Workflow dispatch travels that wire in three shared pieces in `@pithy-sh/core/src/workflow/`: a dispatch route a host mounts, which starts an instance against its own same-script binding and is **refused outside `dev`**; a loopback dispatcher satisfying the one-method seam by posting to `<STEM>_ORIGIN`; and a host env contract. Deployed environments keep the cross-script binding untouched.

**A host states what it is missing, at boot.** `EmailWorkerEnv` is fourteen fields and nothing validated any of them: a missing `BASE_URL` became a link to `undefined/…`, an unparseable `EMAIL_THEME` threw inside a render step, a `SCHEDULER_BATCH_SIZE` somebody typed as `"fifty"` became `NaN` and the scheduler claimed nothing, quietly, forever. Every one of those was discovered as a mail that did not arrive. Now it is a Zod object with a `.describe()` per field, validated at startup, logging each missing value beside the binding, var, command or config key that provides it.

**`enqueue` stopped reporting a send it knows cannot happen.** A structurally absent dispatcher is a configuration fact known at compose time, not a transient error, so the row is born `undispatched` and the result says so. A dispatcher that is present and throws keeps exactly its old behavior — the safety net is real then. `undispatched` is not a dead end: the scheduler claims those rows beside `pending` under the same grace window, because a tick running at all is the host existing.

**`dev` sends for real by default** — `"remote": true` on the host's `send_email` binding, the same pipeline and DKIM as `prod`. When there is no usable Cloudflare login or the sending domain is not onboarded, that is said before somebody is waiting on an inbox, and the session falls back to the local simulator with one line in the banner rather than dying or going quiet. The simulator is also reachable deliberately, which is what CI and a plane want.

The feature port block widened from 10 to 20, pinned against the host count, because eight hosts plus a two-Worker scaffold filled a block of 10 exactly and a third Worker threw.
