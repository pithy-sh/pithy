---
"@pithy-sh/cli": patch
---

`doctor` no longer tells you to promote every unexplained `.dev.vars.local` key. A key named like a binding the Worker's `wrangler.jsonc` declares — any kind, at the top level or in any `env.<name>` — is its own finding: it shadows that binding in dev, and copying it into `vars` would shadow it in production too. The line names the binding's kind and says remove it. The root file is judged against every Worker's bindings. Any other dev-only key gets both outcomes, because doctor cannot know which is true: declare it in `wrangler.jsonc` `vars` if production needs it, delete it if nothing reads it. A store secret's binding reads as the secret it shadows, as a registry key always did. `--json` carries the new finding as `devVarsLocal.shadowingBinding`.
