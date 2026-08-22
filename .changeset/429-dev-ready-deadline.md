---
"@pithy-sh/cli": minor
---

`pithy dev` names the worker that started and never became ready.

`wrangler dev` does not exit when a build fails. It prints the error and keeps running. So the child stayed alive, never matched its ready signal, and every mechanism `pithy dev` had was watching for the wrong thing: the banner waited for a set that would never complete, and the exit handler tears a session down when a child *dies*. This one does not die. The error was real and it was in the scrollback, above forty lines of other workers' startup, and then the session carried on looking healthy.

That is how #426 reached an adopter. Three capability workers had been failing to build, the support classification Workflow was not running, and what eventually surfaced it was a person reading a warning above an error in a log.

Each worker now gets a deadline, and missing it prints who has not arrived, by name:

```
Still waiting on: support.
```

**Still waiting, not failed** — the orchestrator does not know which it is, and a worker this line names may be one bundle away from the banner. The deadline is ninety seconds, longer than any healthy cold start measured here, because a line that cries wolf teaches you to scroll past the one line that was ever going to reach you. It repeats every thirty seconds while the set is non-empty, because a single line at the deadline scrolls away exactly like the error did. `docs/commands/dev.md` states both numbers and a test pins the prose to the constants.

**The line names the mechanism, never a cause.** A build error is what prompted this and is not the only thing it catches — a startup that hangs, a port that never binds, a binding that never resolves, and a `dev.command` worker where wrangler is not in the picture at all. What all of them share is the property that made the session look healthy: the child is alive, so nothing else in the run was ever going to mention it. The line says that, and points at the worker's own output for the reason, which is the only place the reason exists. It also says to restart, because a `wrangler dev` whose first build fails does not rebuild when you fix the file — measured against wrangler 4.123 — so editing and waiting is the one thing that cannot work.

Under `--json` the report is a record rather than the sentence, so an agent driving `pithy dev --json` gets a machine-readable signal instead of a session that silently never emits its ready line.

**And `pithy dev --json` now writes JSON to stdout and everything else to stderr.** Every line a person is told — the `Starting …` line, the delivery verdict, and the workers' own output, which is the bulk of the stream and every line wrangler and Vite print — used to share the descriptor with the machine-readable one, so `pithy dev --json | jq` choked on the first thing wrangler said. The rule is now one a consumer can apply: every line on stdout is one object. Both halves still reach the terminal, and `logs/dev.log` carries the lot in either mode.

The deadline is measured from the moment the last worker is spawned, and the page says so. It used to say *after startup*, which charged a cold project's port verification, secrets and `.dev.vars` to a worker's budget — tens of seconds of a number an adopter reads to know when to expect the report.
