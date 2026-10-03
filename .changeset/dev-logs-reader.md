---
"@pithy-sh/cli": minor
---

`pithy dev logs` reads a dev session back by worker and by time, from a JSONL log that now lives outside the checkout.

A session log that cannot be opened is one line and nothing more — the session runs on, unlogged. `--follow` resumes from the bytes the backlog read, so no record falls between the two halves of the stream.
