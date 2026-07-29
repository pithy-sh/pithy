---
"@pithy-sh/core": minor
---

`chunkByBoundParameters` sizes an `IN (…)` list against D1's cap of 100 bound parameters, minus what the rest of the statement already binds. Chunking at the cap itself is the bug it exists to prevent: a `where` beside the list pushes the statement to 101, and nothing notices until there is enough data to fill a chunk.
