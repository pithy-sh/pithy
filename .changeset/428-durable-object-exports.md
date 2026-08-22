---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
"@pithy-sh/matchmaking": patch
"@pithy-sh/multiplayer": patch
---

A Durable Object class the config names is exported by the entry, so the project deploys.

`pithy add multiplayer` wrote both halves of the wrangler config for a Durable Object — the `durable_objects.bindings` entry naming a `class_name`, and the `new_sqlite_classes` migration tag registering that class against the script — and neither half says where the class *is*. wrangler resolves `class_name` against the entry's module `main` names and refuses the deploy when nothing there exports it:

```
Your Worker depends on the following Durable Objects, which are not exported in your entrypoint file:
MultiplayerSession.
```

The scaffolded entry is `export default createEntrypoint(config);` and nothing else, and `createEntrypoint` returns a value — a value cannot add a named export to the module holding it. So the last line was left to a human whose only prompt was a sentence of manifest prose. `pithy add multiplayer` and `pithy add matchmaking` produced projects that did not deploy, three classes between them, and the failure arrived at `wrangler deploy` rather than at the command that caused it.

**The module is now the capability's to state.** `BindingSpec` gains `classModule` beside `className`, required for a `durable_object` binding and refused as a bare word — it is written into generated TypeScript, so it is validated as a module specifier rather than trusted as a JSON string. Every writer that touches a binding now writes the matching export: `add`, `remove`, `upgrade` and `--eject`. `pithy upgrade` had the identical defect and is fixed with the rest of them; a capability added by one command and reconciled by another cannot have two answers.

**Reported, too, and not only written.** `pithy upgrade`'s plan carries `missingEntryExports` per capability and `pithy doctor` fails on it under `bindings` — a Durable Object is one binding written in two files, and a check that read only the `wrangler.jsonc` half called a project healthy that `wrangler deploy` refuses. That is the same defect one level up, so the plan reports what the apply writes.

**The gate derives the rule instead of listing the classes.** For every manifest the repository ships, it takes the classes the real writer put in `durable_objects.bindings` and the exports the real scaffolder wrote into the entry — parsed with oxc, honouring `exportKind` so a type-only export does not count — and requires the second to cover the first. Neither side is enumerated, so a fourth class added tomorrow is covered by a test nobody has to remember to update. Watched failing against all three classes before any writer existed, and again with a `classModule` pointed at a module that does not exist.
