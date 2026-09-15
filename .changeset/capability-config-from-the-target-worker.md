---
"@pithy-sh/cli": patch
---

`vector`, `storage`, `media`, `payments` and `support` provision the capability the `--worker` target composes.

Each read its config from the first Worker composing the capability and wrote into `--worker`. With two Workers, `pithy vector provision --worker web` created `api`'s indexes and recorded them in `web`, which composed no vector, while `api` got no `VECTOR_PROVISIONED` record. The other four deployed or bound one Worker's capability against another's app database.

One resolution now names the Worker and reads the capability off it. A Worker that does not compose the capability is refused before anything is created: `web does not compose the vector capability.` `pithy turnstile` resolves through the same function. `pithy payments reconcile` writes into no Worker and still reads the first Worker composing `payments`.
