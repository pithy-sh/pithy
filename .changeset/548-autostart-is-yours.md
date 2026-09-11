---
"@pithy-sh/cli": minor
---

Keeping a worker out of your local dev set is your decision, not the project's.

`pithy dev --app <name> --disable-autostart` stops a worker starting on this branch, on this machine. `--enable-autostart` undoes it. Both write `dev-ports.json` beside the port block and start nothing, so nothing about it is committed or shared. A feature inherits the branch it was cut from, once, and can disagree from then on.

Every worker autostarts now. `dev.autostart` in `pithy.worker.jsonc` is removed and a manifest still carrying it is refused, naming the command that replaces it — delete the key. `--app <name>` still starts a parked worker for one run.
