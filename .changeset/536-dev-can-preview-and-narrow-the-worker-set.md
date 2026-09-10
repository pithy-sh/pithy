---
"@pithy-sh/cli": minor
---

`pithy dev --list` shows the Workers a run would start, hosts included. `--app` starts only the ones you name. Every Worker autostarts now — set `dev.autostart: false` for one that should not.
