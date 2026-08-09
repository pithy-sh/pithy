---
"@pithy-sh/cli": patch
---

No credential-resolving parameter in the CLI is optional any more. `OPTIONAL_ACCOUNT_OWED` is empty.

#226 made `buildEnvInventory`'s `account` required and left a written inventory of the rest: five more declarations that could be omitted, each with what making it required would cost. This is that inventory, emptied.

`MigrationFanOutOptions`, `DropCapabilityOptions`, `SeedDriverOptions` and `AddBootstrapOptions` take a required account now, and so does `probeAccountEvidence` — which was the worst of the five and the least visible. It took the account as a **default parameter**, `= null`, so the `null` was written at the declaration and every call site said nothing at all. The verdict that path can reach is `orphaned`: *"this live database is not yours."* A project naming `cloudflare.accountName` had its resources looked for in the default account, found none, and fed that absence to a deduction whose worst answer is a confident sentence about somebody else's production database. Wrong credentials that refuse are a bad afternoon; wrong credentials that answer are what this parameter now makes unwritable.

Two seams carried no account at all, so plumbing came before threading. `SeedProjectOptions` has one, so `seedProject` can hand it to the driver that opens a real D1 and a real R2. `dashboard/registry.ts`'s `OpenDriver` has one, so `openConnectionRegistry` can name an account — a `--env staging` lookup opens the app database over REST, and it was opening it against whichever file the machine defaulted to.

Everything downstream follows: `pithy add`, `pithy remove --drop`, `pithy seed`, `pithy dashboard`, `pithy upgrade --migrate`, `pithy doctor`'s health and project-name checks, and all three `pithy feature` paths resolve the account their own project names. `feature create`, `provision` and `sync` read it from the **worktree's** root config, beside the project name they already read there, because the branch is what decides both.

Verified with two accounts on one machine — `cloudflare.alpha.json`, `cloudflare.beta.json`, an unnamed `cloudflare.json`, and a hostile `CLOUDFLARE_ACCOUNT_ID` exported throughout. Each project's commands reach its own account and no other; a project naming none gets the unnamed file; and a pinned `cloudflare.accountId` the credentials contradict refuses with no network call made.

**`pithy doctor` refuses that mismatch without exiting.** `cloudflareEnv` throws on it, which is right for a command resolving its own credentials — but a diagnostic that dies on the fault it exists to report tells nobody anything. So the probe keeps the refusal and drops the throw: no account is asked, nothing is established, and the verdict stays on the local deduction and out of reach of `orphaned`. The mismatch is already a line of the same report, and one fact belongs in one line.

`cloudflare/accountArgument.test.ts` gains the other half of its gate. The walk can only fail an account that is *optional*; a declaration deleted or moved leaves it nothing to find, which is the quietest possible revert. Every module that reached required is now pinned by name, asserted in both directions.
