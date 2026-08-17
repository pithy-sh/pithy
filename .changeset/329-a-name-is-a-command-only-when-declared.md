---
"@pithy-sh/cli": patch
---

`pithy valueOf` crashed. `pithy constructor` succeeded, silently, having done nothing.

```
$ pithy valueOf
TypeError: undefined is not an object (evaluating 'value()')
Bun v1.3.14 (Linux x64)

$ pithy constructor ; echo $?
0
```

Every `subCommands` is an object literal, and citty resolves a name with `name in subCommands` and calls the value when it is a function. So `Object.prototype` was a member of every lookup at every level of the tree: `valueOf` and `hasOwnProperty` were called with no receiver and died on a raw `TypeError` under a crash banner, and `constructor` was called, returned `{}`, and was taken for a command definition with nothing to run.

Neither name is a command, and there is already a path for a name that is not a command — `pithy nonsense` names it, shows the help, and exits non-zero. Each `subCommands` record is now copied onto a null prototype on its way to citty, so an inherited name resolves to nothing and takes that path. Done once for the whole tree rather than at the twenty-six `defineCommand` calls, for the same reason the usage rule is: a group added next year inherits it with nothing to remember. Laziness survives — a subcommand thunk is wrapped, never called.
