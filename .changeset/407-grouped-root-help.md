---
"@pithy-sh/cli": minor
---

`pithy --help` groups its commands: Project, Develop, Operate, Capabilities, Toolchain.

The root screen listed every command in declaration order under one heading, behind a `USAGE` line that alternated all of them before a single description appeared — a line already wider than a terminal, and one that grew with every capability that landed. Nothing on it said `email`, `media` and `turnstile` are the same kind of thing and `deploy` is not. The `USAGE` line is now `pithy <command> [OPTIONS]`, because the alternation was never information.

**The grouping is display only.** `pithy email provision` is still `pithy email provision`. Putting the group in the command path would rename nine commands, add a segment to every doc page and every agent's call, and buy a screen what a blank line already buys it.

**The group is declared on the command, so it cannot be forgotten.** The obvious spelling — a table of names per group — is a second list of the command set, and the drift has a bad direction: a command added to the tree and missing from the table would not fail, it would *vanish* from the one screen whose job is to say what the CLI can do. So `main.ts` holds one record with `group` as a required field typed to the five names, and `subCommands` is projected from it. An omitted group is `TS2741` and a misspelled one is `TS2820`. There is no catch-all group and no gate, because there is no state to catch.

**Only the root screen moved.** `pithy add --help`, every group screen, and the screen after an unrecognised name one level down are still citty's `renderUsage`, byte for byte. The root screen keeps citty's shapes on purpose — the same right-aligned name column, the same four-space gutter, the same closing pointer — because the two sit one keystroke apart and a root screen that repainted itself would read as a different program.

`pithy nonsense` prints the grouped screen too. citty reaches its own `showUsage` for an unresolved name with no parent, so the override is handed to `runMain` as well as to the usage walk; wired one way only, the CLI would ship two root screens that drift, and the second reachable only by making a mistake.

Group headings are bold basic-16 magenta through `terminal/style.ts`, which is what makes piped help plain and `FORCE_COLOR` help colored — the seam every other colored character already flows through. Not saffron: a heading carries structure, and saffron carries meaning. `docs/CLI.md` §4.3 now states which screen is whose, and names the one divergence it leaves standing — with `CI` set on a terminal Pithy calls color-capable, the root screen carries color and citty's screens do not, because closing that would mean deleting `CI` from the environment of every process the CLI spawns.
