---
"@pithy-sh/core": minor
"@pithy-sh/email": minor
---

A Workflow can send mail. `enqueueFromEnv(this.env, input)` reaches the composed email capability from inside a durable step, with the from-identity and theme `pithy.config.ts` resolved and nothing restated.

A `compose` hook hands every composed capability to every other one, so a route can hold `@pithy-sh/email`'s bound `enqueue` and call it — `@pithy-sh/auth` does exactly that for magic links. A Workflow class cannot: the runtime constructs it with the worker `env` and nothing else, and a composed seam is a closure rather than a binding. The two ways past it were both the adopter's to take and both wrong — rebuild the seam from `env` plus a restated sending identity, free to drift from the config that owns it, or pass the closure through Workflow params, which are serialised.

So a durable job could not send mail, and `pithy-sh/dashboard`'s key-rotation notice was written, tested, and reachable by nothing: a monthly unattended pass over credentials into other people's production systems, whose most valuable notification was the one that could not be delivered.

`createBackend` now records the composed set after every `compose` hook has run, and `@pithy-sh/core/src/capability/composition` publishes `composedCapabilities()` and `composedCapability(name, guard)` to read it. It is reasoned rather than convenient: `createBackend` runs at module load and Cloudflare requires a Workflow class to be exported from the same worker entrypoint as the `fetch` handler, so the composition has already happened in that isolate before any step body runs — the same footing `@pithy-sh/secrets`' shared accessor stands on. A second assembly replaces the first rather than merging, and an un-composed isolate raises a wiring fault naming what to compose rather than answering emptily.

This is not a service locator for application code. A route has `c.var` and a capability has its `compose` hook; both are better and both stay the way to reach a seam. It is for the one caller that has neither.
