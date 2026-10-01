---
"@pithy-sh/cli": minor
---

`--json` now pretty-prints when a person is reading it and stays one compact line everywhere else.

The flag that makes the CLI agent-drivable was the same flag that made it unreadable to the person who typed it. `pithy doctor --json` at a terminal returned a single unbroken line, and reading it meant piping through `jq`.

It is decided the way color already is, first match wins: `PITHY_JSON=compact` or `PITHY_JSON=pretty`, then `--pretty` / `--no-pretty`, then `isTTY` on the stream being written. The variable comes first because a TTY is not a reliable "a person is reading this" signal — agent harnesses, tmux-backed runners and some CI images allocate a PTY, and one variable settles a whole session rather than every invocation in it. An unrecognized value is refused, naming the two it takes: a typo reverting to the default is indistinguishable from the variable working.

**A piped, redirected or captured run is byte-identical to before.** Every output round-trips through `JSON.parse` to the same value either way.

**`pithy dev` is not reshaped.** Its `--json` stdout is a stream — one object per line for the life of a session, which is the only rule a consumer reading it line by line can apply. Those records stay compact and uncolored at a terminal exactly as they are in a pipe. Every other command writes one document, where the trailing newline is a terminator rather than a separator and indenting cannot break a framing that is not there.

**Each stream answers for its own reader.** The payload reads `process.stdout.isTTY` and the `{ "error": … }` line reads `process.stderr.isTTY`, so `pithy doctor --json > out.json` at a terminal writes a parseable payload to the file and prints a readable error to the screen.

Pretty means two-space indent and restrained syntax color — dim punctuation, cyan literals, plain keys and strings. It routes through the existing color seam, so `NO_COLOR` or a pipe leaves valid indented JSON with no escape byte in it. A stream that is not a terminal is never colored even when it is indented, so `pithy doctor --json --pretty 2> err.txt` writes a parseable error into the file while the screen keeps its color; `FORCE_COLOR` overrides that. Saffron is not spent on structure.

`--pretty` and `--no-pretty` are global flags, declared once beside `--help` and `--version` and published in the docs catalog. Both the bare and the `=true` / `=false` spellings are read; a value that is neither is refused, as is either flag without `--json`, since it formats that line and nothing else.
