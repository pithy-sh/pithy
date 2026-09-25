---
"@pithy-sh/cli": patch
---

A feature deployment now binds the Workflows and Durable Objects the app declares, so it serves a request instead of answering 500.

`pithy provision --feature` derived a feature name for every kit host's Workflow and nothing at all for the ones the adopter declares in their own `pithy.config.ts`, whose classes are exported by their own Worker. Staging and prod carry theirs — `pithy worker sync` writes them into the tracked `wrangler.jsonc` — and a feature's stanza is regenerated from that file on every run with every binding array emptied, so the branch deployed with no `workflows` entry for its own jobs. Every route answered `Missing required bindings: workflow:…`, `/health` included.

The names come from the same derivation `pithy worker sync` plans a declared environment's table with, handed the provisioning scope rather than an environment string, so a feature's table and staging's cannot come to mean different things by "the app's own". Nothing about a declared environment's stanza changes: that file is `pithy worker sync`'s to write and is reviewed in a pull request.

Same-script Durable Object namespaces were lost the same way and are carried into the feature's stanza too. An entry naming another script is left alone — a feature has no derivation for it, and binding production's namespace would be worse than the absent binding.

A feature's slug budget now counts the app's own Workflow names. It read only capabilities owning a kit Worker, so a branch whose slug fitted every kit name and not the app's was accepted and then refused at provision time, after the resources it had already created.
