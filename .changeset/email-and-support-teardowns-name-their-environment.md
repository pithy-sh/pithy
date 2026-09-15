---
"@pithy-sh/secrets": patch
"@pithy-sh/email": patch
"@pithy-sh/support": patch
"@pithy-sh/cli": patch
---

`pithy email deprovision` and `pithy support deprovision` tear down one named environment, and leave what every environment shares to the last one.

Both walked every declared environment. A run meant for staging removed production's email worker, or its classification worker. `email deprovision --suppression` from staging deleted the suppression list production binds. `support deprovision --storage` deleted the one support bucket, every environment's history in it, and `--routing-zone` stopped production's inbound mail.

- **`--env` is required.** No default, no "all". With none, or one the project does not declare, it refuses before any credential is read and lists the environments it could act on. The same refusal the secrets, storage and media teardowns give.
- **A shared part goes with the last environment.** `--suppression`, `--storage` and `--routing-zone` refuse while another declared environment still runs the capability's worker, naming it, before anything is deleted. The rule is `assertSharedLeavesLast` in `@pithy-sh/secrets`' `scope`, beside `deprovisionTarget`.
- **The suppression list is still counted.** A list holding rows needs `--destroy-retained <n>` as before. The bucket's confirmation is `--storage` itself: R2 objects are not counted.
- **`--json` carries `env`** on both.

`--env production` on any of the five teardowns is now answered with `prod`, rather than with a list that omits it.
