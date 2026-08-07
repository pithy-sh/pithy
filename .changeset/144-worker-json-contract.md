---
"@pithy-sh/cli": patch
---

The `--json` `worker` field is the `apps/` directory in every command, and the deployed script name has its own field, `deployedAs`.

It used to mean the directory in `init`, `ui add` and `ui sync`, and the deployed name in `add`, `remove`, `upgrade` and `worker sync` — one field, two meanings, with nothing in the payload saying which. The two coincide whenever a project and its worker are named alike, which is what kept it hidden.

`ReconcilePlan` gains `deployedAs`; its `worker` is now the directory its own schema always said it was.
