---
"@pithy-sh/cli": patch
---

A command no longer loads a network client to print its own flag list.

`pithy add --help` took 786 ms. A `--cpu-prof` said that roughly 53% of it was Node's own module loader — resolving and parsing files the command never intended to use. Zod was 2.3% of the profile and citty imported in 6 ms, so it was neither the schemas nor the command tree. It was two leaves: `miniflare` (~290 ms), reached through `migrations/run.ts`, and the Cloudflare SDK (~300 ms), reached through anything naming `CloudflareClients` as a value.

Both now load at the point of use. `const { Miniflare } = await import("miniflare")` inside the three functions that start one, and every REST client the CLI builds goes through one `cloudflareClients()` helper that imports the module when a command has decided to talk to Cloudflare.

Measured as the minimum of twelve warm runs, before and after interleaved on one machine:

| | before | after |
|---|---:|---:|
| `pithy add --help` | 786 ms | 255 ms |
| `pithy doctor --help` | 813 ms | 263 ms |
| `pithy deploy --help` | 816 ms | 206 ms |
| `pithy migrate --help` | 771 ms | 326 ms |
| `pithy --help` (loads all 25) | 1076 ms | 668 ms |
| `pithy --version` | 43 ms | 43 ms |

`pithy token --help` is the one command still reaching the SDK, because `TOKEN_STORES` is interpolated into the `--store` flag's description and citty evaluates that at import. It is written down in the gate with what it would take to remove.

A gate holds the rest. `ci/lazyHeavyImports.test.ts` derives the static import graph from every command module, follows it across package boundaries, and fails on any reach into a named heavy package that is not recorded — in both directions, so an exception that has been fixed has to be deleted rather than left standing. Nothing about the next such import will look wrong, and its cost is invisible: no test fails and no output changes, the command is simply a third of a second slower for everybody who ran a different one.
