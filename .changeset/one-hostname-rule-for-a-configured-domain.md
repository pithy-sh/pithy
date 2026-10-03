---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

A custom domain in `pithy.config.ts` is held to the same rule as every other hostname the kit reads.

`WorkerDomain` handed the hostname pattern to a regex of its own, so `pithy.config.ts` accepted two things `pithy seed --host` refused for the same string: a punycode `xn--` label, and a name over the 253-character DNS limit. A declaration that validated before may now be refused.

A refused declaration stops the command and names the field. Every reader throws — `pithy deploy`, `pithy env`, `pithy doctor`, `pithy worker sync`, `pithy seed`, the token minter and the capability provisioners — rather than resolving some other address through a route the adopter did not declare. An invalid domain is a config error, and the remedy is the field.

The refusal names the rule it broke. For an internationalized domain it names Cloudflare Workers as the source of the limit, because that is whose limit it is: a Worker Custom Domain on one is refused outright, so an address no Worker can answer on is better refused where it is written. `docs/ACCEPTED-LIMITS.md` carries the evidence and the condition that would lift it.
