---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
"@pithy-sh/auth": patch
"@pithy-sh/email": patch
"@pithy-sh/testers": patch
"@pithy-sh/payments": patch
---

No capability asks an adopter to write down an origin.

`originFor` landed the derivation; nothing scaffolded it and every capability still shipped a URL as its default, so `pithy add auth` wrote `baseURL: "https://api.example.com"` into a config that had no other answer. `pithy init` now scaffolds the shape the first adopter arrived at by hand:

```ts
const DOMAINS = { /* staging, prod */ };
export const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);
const config = { domains: DOMAINS, capabilities: [ … ], app };
```

Hoisted, because the origin has to exist before the capabilities that take it are constructed — and `domains: DOMAINS` beside them is the same object, so there is one declaration with two readers. The domain prompt fills that const rather than inserting a second `domains` key, which is what the previous writer would have done to a config carrying one.

A manifest option whose value is an origin now names a **constant** rather than stating a URL, and `pithy add` and `pithy upgrade` both render it unquoted. The vocabulary is closed — a manifest names `publicOrigin`, never an expression — for the same reason a capability's own name is constrained: a manifest is third-party data written into the adopter's TypeScript. A `--set` override still wins, and a project scaffolded before the constant existed keeps the literal rather than being handed an identifier nothing defines.

`auth.baseURL`, `email.baseUrl` and `testers.baseUrl` derive. The gate found the third: the issue named three capabilities and the fourth was sitting there unreported. `controlplane.issuer` deliberately does not — it is an identity, not an address, and a connection minted in staging must stay verifiable in production — and it is the one named exemption on a gate that fails any other origin-shaped default.
