---
"@pithy-sh/core": minor
---

The control-plane seam answers CORS preflights, so a browser can reach it.

A control-plane token rides the `pithy-control-plane` header, which is not one a browser sends cross-origin without asking first. Nothing answered that question, so the browser-direct path — the one that exists so your data goes straight from your browser to your own Worker instead of transiting a management client's origin — failed on every call, as a `TypeError` naming your host. A Worker that was up and healthy read as one that could not be reached.

Every admin route now answers `OPTIONS`: the seam's own, and every capability's. The covered paths are derived from the same `adminRoutes` descriptors the manifest is built from, so a capability that adds an admin route gets its preflight with it and there is no second list to keep in step.

The hosted dashboard works on a stock Worker with no configuration. Add your own console with `allowedOrigins`, which is **additive** — an entry there never removes `issuer`, so putting your own UI on top cannot lock out the dashboard that was already working:

```ts
controlplane({ allowedOrigins: ["https://ops.example.com"] })
```

In local dev you configure nothing: when `ENVIRONMENT` is `dev`, any address on your own machine is answered, on any port. The dev port allocator picks a console's port per feature, so no value you could write down would stay true across checkouts.

`pithy-worker-version` and `pithy-worker-version-created` are named in `Access-Control-Expose-Headers`, so a client can finally tell "the Worker did not say" from "the browser was not allowed to look" — different facts when you are deciding whether a deploy has landed. `corsMaxAgeSeconds` caps how long a browser caches a preflight; set it to `0` while you are working an allow-list out, because a browser that cached a refusal keeps refusing after you have fixed the config.

Two things are deliberate. The allow-list is read from config and never from a connection row: a preflight is the one request here answered before any credential, so consulting the database would let anyone ask which origins you have registered. And an origin that is not allowed gets the same `204` and the same empty body as one that is, minus the header that permits the read — the browser blocks it, and the answer says nothing about what the list contains.
