---
"@pithy-sh/cli": patch
---

A feature deployment now binds the Workflows and Durable Objects the app declares, so it serves a request instead of answering 500.

`pithy provision --feature` derived a feature name for every kit host's Workflow and nothing at all for the ones the adopter declares in their own `pithy.config.ts`, whose classes are exported by their own Worker. Staging and prod carry theirs — `pithy worker sync` writes them into the tracked `wrangler.jsonc` — and a feature's stanza is regenerated from that file on every run with every binding array emptied, so the branch deployed with no `workflows` entry for its own jobs. Every route answered `Missing required bindings: workflow:…`, `/health` included.

The names come from the same derivation `pithy worker sync` plans a declared environment's table with, handed the provisioning scope rather than an environment string, so a feature's table and staging's cannot come to mean different things by "the app's own". Nothing about a declared environment's stanza changes: that file is `pithy worker sync`'s to write and is reviewed in a pull request.

Durable Object namespaces were lost the same way. A class in the Worker's own `main` is carried into the feature's stanza; one in another Worker of the same project is retargeted at the feature's copy of that Worker, through the same resolution a `service` binding to it already goes through. Only an entry naming a Worker outside the project stays as written, and the run says which, rather than leaving it to be met at runtime.

A feature's stanza now states its own cron schedule, including an empty one. `triggers` is a key wrangler inherits, so a stanza that said nothing ran whatever the top level's schedule was.

A `send_email` binding is carried into every environment's stanza whole. It names an account-level Cloudflare Email Service address, so nothing in it belongs to an environment, and nothing in the CLI would ever have written one back: an emptied binding failed at the first send as `undefined`.

A job declared with no `className` is refused before a feature run creates anything, naming the job and the fix. It was refused by the stanza writer, after every database, namespace, bucket and store entry already existed, and every re-run refused in the same place.

A feature's slug budget now counts the app's own Workflow names. It read only capabilities owning a kit Worker, so a branch whose slug fitted every kit name and not the app's was accepted and then refused at provision time, after the resources it had already created.
