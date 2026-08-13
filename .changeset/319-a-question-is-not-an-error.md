---
"@pithy-sh/cli": patch
---

Bare `pithy` printed the help and then called it an error.

```
$ bun run pithy
A backend kit for Cloudflare Workers. (pithy v0.0.0)

USAGE pithy init|add|remove|worker|…

No command specified.
error: script "pithy" exited with code 1
```

It answered correctly and then told the user they had done something wrong, twice. Somebody typing `pithy` with no arguments is asking what it does; the command list is the answer, and it is the most common thing anyone types on their first day. Exit 1 breaks `pithy && next`, fails a bare invocation in a CI step, and — under `bun run` — hands the last word to a line that names a script rather than anything the user did.

The rule now, stated once: **a command that names no action is asking what it can do, and being answered is a success.** Bare `pithy` prints the help and exits 0. So does a group with no subcommand — `pithy secrets`, `pithy worker`, all thirteen — because it is the same question one level down. Nothing is printed after the help.

A name that is not a command is a different thing and is unchanged: `pithy nonsense` names what was not recognised, shows the help, and exits non-zero.

Fourteen commands took the failing path, so the rule is not written fourteen times. `dispatch.ts` answers before citty parses, because citty cannot be told otherwise — `runCommand` throws `E_NO_COMMAND` for the root and for every group, and `runMain` catches every `CLIError` into usage, the message, and `process.exit(1)`. Adding a `run` to each group would also have been subtly wrong: citty runs a parent's `run` after dispatching to a subcommand, so each would have needed to know whether it had been dispatched through. A group added next year inherits the rule with nothing to remember, and the gate checks it over every group the root declares rather than over the two the report happened to name.
