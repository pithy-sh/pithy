---
"@pithy-sh/cli": patch
---

The CLI reference is one page per command, and the gate that holds a page to the payload it documents now reads every one of them (#223).

`docs/CLI.md` was 1577 lines organised by topic, and a handful of commands had a section at all. Nineteen commands were specified nowhere, which is a strange state for a reference about to be published. So the document splits: `docs/CLI.md` keeps what every command shares — the command shape, the flag conventions, the alias, the output styling, the help text, the update notifier — and indexes twenty-six pages under `docs/commands/`, one per command, each carrying the same six sections.

Nothing was rewritten to get there. The five sections that already existed — `doctor`, `adopt`, `dev`, `ui`, `seed` — moved with every transcript byte for byte, because those transcripts are pinned and the pins are what makes them trustworthy. A pointer sits where each section was, so the thirty-odd citations of `docs/CLI.md §5.6` and `§6.2` in this repo's own source still land somewhere true.

**The gate is the point of the exercise.** #186 held a section to naming every `--json` key of the commands it specified, and enrolment was the mechanism: a section that documented a payload had to document all of it, and a command nobody had written about was free. That property survives the split with a filename in place of a sentence. A command page that specifies `--json` names every key written at that command's call sites; a command with no page was not failed by it, right up until the last page landed — and now that they all have, `every command has a page` is a check rather than an intention.

What the scan cannot read is named rather than implied. Thirty of sixty-five `formatJsonLine` sites build their payload by spreading a typed object, where no key exists at the call site; four commands pass something the object pattern cannot parse at all; three write nothing it can read. Those three lists are asserted against the scan itself, so the honesty cannot decay into a stale paragraph — a command that changes shape fails until the list agrees with it again.

It found one thing on the way in. `pithy seed --json` writes `formatJsonLine({ ...report, devSecrets })`, and `devSecrets` had never been documented — nor pinned, because the pin rendered `{ ...report }` and compared that, so the one key written outside the report was the one key neither the doc nor its test could see. The sample carries it now, and so does the pin.
