---
"@pithy-sh/cli": patch
---

`pithy provision` reports a missing secret at the address the Worker actually binds.

`secretsStoreBindings` composed each entry's name from the registry entry's own `scope`, then returned only the binding for the ones it could not find. So the report recomposed the name, and the only scope a caller holding a bare binding can supply is a guess: `"environment"`, for every missing secret. For a `global` one that is the wrong address — an operator reading `--json` and creating the value there creates it, is told nothing is wrong, and still deploys a Worker with an unbound secret.

The producer knows the scope, so the answer travels instead of being derived twice: a missing secret is `{ binding, entry }`. Both scopes are asserted in one test, because a producer that hardcoded either satisfies a test that checks only the other.
