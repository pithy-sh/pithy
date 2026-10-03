---
"@pithy-sh/cli": patch
---

`pithy deploy --json` now reports the Worker's address rather than, on occasion, a link to wrangler's telemetry documentation.

The scrape took the last URL anywhere in wrangler's stdout, under a comment asserting that the last one is the deployed one. It is not: `wrangler deploy` prints a telemetry notice after the deploy summary, once per wrangler version per machine and only where telemetry is enabled, and that notice's documentation link was reported as the Worker's public address — in the machine-readable output a script or an agent reads. The address now comes from wrangler's own `Deployed <name> triggers` block, and only from a target that is an address, so a custom domain is reported as the host it answers on and a cron, a queue or a workflow trigger is reported as nothing at all. Finding no address stays an ordinary outcome, as it always was. A confidently wrong one was the bug.
