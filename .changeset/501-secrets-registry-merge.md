---
"@pithy-sh/cli": patch
---

`pithy secrets` sees every capability's secrets, not just the secrets capability's own.

A capability declares the secrets it reads: `auth` its session secret and both OAuth credential pairs, `email` its link signing key, `payments` its provider credentials. `resolveSecretRegistry` read `secrets({ registry })`'s own slice and nothing else, so from the CLI those secrets did not exist. `pithy add auth` ends by naming `pithy secrets create auth-session-secret`, and that command answered `Secret 'auth-session-secret' is not declared in the registry.`

It survived because nothing surfaced until a deployed environment was needed. The capabilities mint their own dev values, and `doctor` already reads the union — so local work was fine and the first deploy was not, with no path at all for five secrets including every externally issued credential in the product.

It now aggregates the same slices the Worker does, through the same function the `secrets` capability's `compose` hook calls, so one merge rule governs both and a contradictory redeclaration of one name is refused in one place. Composing would not have been enough: the hook keeps its combined registry in a closure and never writes it back.
