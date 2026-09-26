---
"@pithy-sh/cli": patch
---

A feature deployment now binds the Workflows and Durable Objects the app declares, so it serves a request instead of answering 500.

`pithy provision --feature` derived a feature name for every kit host's Workflow and nothing at all for the ones the adopter declares in their own `pithy.config.ts`, whose classes are exported by their own Worker. Staging and prod carry theirs — `pithy worker sync` writes them into the tracked `wrangler.jsonc` — and a feature's stanza is regenerated from that file on every run with every binding array emptied, so the branch deployed with no `workflows` entry for its own jobs. Every route answered `Missing required bindings: workflow:…`, `/health` included.

The names come from the same derivation `pithy worker sync` plans a declared environment's table with, handed the provisioning scope rather than an environment string, so a feature's table and staging's cannot come to mean different things by "the app's own". Nothing about a declared environment's stanza changes: that file is `pithy worker sync`'s to write and is reviewed in a pull request.

Durable Object namespaces were lost the same way, and hand-written `services` entries with them. A class in the Worker's own `main` is carried into the feature's stanza; one in another Worker of the same project — and a `service` naming that same Worker — is retargeted at the feature's copy of it. One naming a script this project does not deploy is **stripped**, and the run says which: a feature that bound it would read and write inside a live Worker somebody else owns, and an absent binding fails loudly on the first request where a shared one corrupts quietly. A `script_name` resolves against deploy names only, never an `apps/<name>` directory, and two Workers deploying under one name is refused rather than resolved to either.

A feature's stanza now states its own cron schedule, including an empty one. `triggers` is a key wrangler inherits, so a stanza that said nothing ran whatever the top level's schedule was. A schedule the adopter wrote into a tracked `env.feature` is theirs and is left exactly as written.

A `send_email` binding the top level declares is carried into a **feature's** stanza. Nothing in the CLI would ever have written one back — `email` is neither a written nor a provisioned binding kind — so an emptied one failed at the first send as `undefined`. A declared environment's first stanza still gets none: the entry carries a routing decision, and seeding `env.prod` from the top level would put the address on a developer's laptop into production.

A job declared with no `className` **and no `optional`** is refused before a feature run creates anything, naming the job and the fix. It was refused by the stanza writer, after every database, namespace, bucket and store entry already existed, and every re-run refused in the same place. A class-less job that declares itself optional is the case `WorkflowSpec.className` sanctions — a job whose host config is hand-maintained — and is left out of the derived table rather than refused.

A feature's slug budget now counts the app's own Workflow names. It read only capabilities owning a kit Worker, so a branch whose slug fitted every kit name and not the app's was accepted and then refused at provision time, after the resources it had already created.
