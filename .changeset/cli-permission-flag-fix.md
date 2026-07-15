---
"@pithy-sh/cli": patch
---

`pithy token mint`/`rotate` now honor every repeated `--permission` flag (citty kept only the last, silently dropping the rest). `pithy remove` prints honest guidance for leftover tables — naming the `pithy_<cap>_*` tables to drop and pointing at `--drop` for next time.
