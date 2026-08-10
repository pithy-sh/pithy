---
"@pithy-sh/cli": minor
---

A failed `pithy ui add` leaves the project as it found it.

`runUiAdd` wrote its whole template and *then* composed the app to derive the asset allowlist, so a composition that threw left the files written and the wiring absent. The retry was refused by the command's own guard — `pithy ui add` declines a Worker that already carries a front end, which is correct and deliberate, and could not tell a finished front end from one this command had abandoned a minute earlier. The adopter was told the thing was done, by the run that failed to do it, and the way out was deleting files by hand and working out which ones were the template's.

Two changes, and both are needed. The allowlist is derived **before** anything is written: `wireAssets` takes the patterns rather than composing them, so the step most likely to throw throws first. And every write runs under `withRollback`, because ordering alone only removes the failure someone has already met — the next step added goes back on the end of the list. Stated over the outcome, the property survives the next step.

`withRollback` (`project/rollback.ts`) is the primitive: snapshot the files a run may touch, restore them if it throws, and remove the directories it had to create. `pithy worker add` has done this by hand since #158 for the one directory it creates; this is that, for a command that edits files an adopter already owns. An unreadable path refuses the run up front rather than being recorded as absent — recorded as absent, the rollback would delete it.

The genuine refusals are untouched: a Worker that really has a front end is still refused, and a second framework in one Worker still refused outright.
