---
"@pithy-sh/cli": patch
---

A Worker can decline an optional binding, and both commands respect it.

Name it in `declinedBindings` in that Worker's `pithy.config.ts`, with the reason. `pithy upgrade` leaves it out of `wrangler.jsonc`; `pithy doctor` reports it as declined and prints the reason back. A stanza deleted by hand stays deleted.

The reason is required. A binding simply absent is indistinguishable from one somebody forgot, which is the state this replaces.

Declining a required binding, a Workflow, or a Durable Object is refused before an upgrade writes anything. A decline naming a binding nothing composes is reported and stays green — `pithy remove` leaves exactly that state.
