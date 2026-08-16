---
"@pithy-sh/auth": patch
---

Asking for a social provider this deployment does not hold is proven with a live request again.

`sign-in/social` for a provider nobody enabled answers Better Auth's own 404 `PROVIDER_NOT_FOUND`, and one that is enabled but whose credential will not read answers this kit's 503 `auth/provider_unavailable`. That distinction is #381's whole fix, and half of it was asserted without dispatching a request. It is a live dispatch now, and the reason it was not is worth writing down, because it was not what it looked like.

**It was never Better Auth, and never `onAPIError`.** Before workerd's 2026-03-03 behaviour change, an `async` function that **returned** a rejected promise instead of awaiting it fired `unhandledrejection` even where the caller awaited the result and caught it — the handler is attached by the promise-adoption job, and the check ran first. Nothing was unhandled. Better Auth's `runWithEndpointContext` and `runWithRequestState` are exactly that shape, so every endpoint refusal left two phantom rejections behind and vitest counted them against the run. Measured: it reproduces with `onAPIError: { throw: true }`, without it, and with an `onError` handler alike, and it reproduces in eight lines with no Better Auth in them at all.

**A deployed Pithy Worker never had this.** `pithy init` scaffolds `compatibility_date: "2026-06-01"` and `workersManager` defaults to `2026-04-07` — both past the fix. Only `@pithy-sh/auth`'s own Workers-runtime test config was still pinned at `2025-01-01`, fifteen months behind the runtime it is evidence about. It now names `unhandled_rejection_after_microtask_checkpoint` explicitly: the one behaviour this suite was wrong about, rather than every change in those fifteen months at once.

**If your own Worker predates 2026-03-03, you will see it.** Anyone can post a provider name, so the path is trivially reachable. Move the compatibility date past 2026-03-03, or add the flag.
