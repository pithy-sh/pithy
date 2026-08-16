---
"@pithy-sh/auth": patch
"@pithy-sh/payments": patch
"@pithy-sh/support": patch
"@pithy-sh/turnstile": patch
---

The four client projections declare what they project, so a capability cannot quietly change it.

`Capability.client` is typed `(context) => ClientProjection` — `{ enabled: boolean }` and a JSON catchall. It accepts anything a projection could return, so each capability's real shape existed only as an inferred object literal inside a closure and was erased at the interface. A projection that stopped emitting a field compiled; a projection that started emitting a store-only SKU compiled; `virtual:pithy/*` said otherwise in a browser.

Each of the four now declares its shape and returns it: `AuthClientProjection`, `PaymentsClientProjection` (with `PaymentsClientProduct`), `SupportClientProjection`, `TurnstileClientProjection`, each in its package's `src/client/projection.ts`.

**The declaration is the source of truth, not a restatement of the literal.** Nothing in it is derived from the producer — no `ReturnType`, no `typeof`, no inference from the config schema — so widening the config does not widen the projection, it goes red. A third Turnstile widget mode, a fourth product kind, and a fourth Paddle checkout mode are each a compile error at the `client:` that would have carried them into a bundle. So is a dropped field, at every depth, and a grown one — a product's Apple SKU, auth's `baseURL`, support's per-account rate.

`PaymentsClientProduct` is annotated on the `.map` callback rather than on the array it builds, and the difference was measured: on the array, the element literals are no longer fresh by the time they are checked, and a product that grew an `apple` SKU passed silently.

The projected values do not move. `@pithy-sh/vite`'s `clientEnv.test.ts` — the gate that holds `templates/client-env.d.ts` against these projections — is unchanged and green.
