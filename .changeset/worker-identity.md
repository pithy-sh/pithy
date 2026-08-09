---
"@pithy-sh/cli": patch
---

All five `pithy worker` subcommands name a Worker the same way, and `worker add` reports the port it just pinned.

`add`, `list`, `remove` and `rename` reported `name` — and it was the `apps/` **directory** in `add` and the **deployed script name** in the other three. One key, two meanings, with nothing in the payload saying which; the two coincide whenever a project and its Worker are named alike, which is what kept it hidden. `sync` had been fixed already, in #144, and the doc comment on `workerIdentity` has been describing this exact ambiguity ever since. All five now carry that function's `worker` and `deployedAs`. `name` is gone rather than redefined: a payload carrying both spellings would leave every consumer of the old one reading whichever half it happened to be written against.

`worker add` looked its new Worker's port up by the `apps/<dir>` basename the adopter typed. The port registry is keyed on the deployed name, so the two could never match — inside a feature worktree the payload reported `"port": null` beside `"reconciled": true`, and the human path then offered to assign a port that a reconcile had just assigned. The lookup uses the name the registry uses, and the human path has three states instead of two, so the sentence about assigning a port is only printed where none has been.

`pithy worker list` prints the `apps/` directory beside the deployed name it already led with. Neither can be inferred from the other, and the command that exists to say what a project has should say both.
