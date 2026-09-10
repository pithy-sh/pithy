---
"@pithy-sh/cli": patch
"@pithy-sh/email": patch
"@pithy-sh/support": patch
"@pithy-sh/media": patch
"@pithy-sh/storage": patch
"@pithy-sh/testers": patch
---

Capability provisioning skips an environment that has no app database, and says which and why.

`pithy email provision` loaded every declared environment and threw on the first whose app `DB` binding had no `database_id`. So a deliberately staging-only bring-up failed part way through, naming production — after the suppression database and staging's worker already existed. The operator then had to work out from the Cloudflare account what had happened, and the remedy the refusal named was to provision production, which is not what they were doing.

Six commands carried that closure, copied word for word: `email`, `media`, `payments`, `storage`, `support`, `testers`. They are one call to `environmentReadiness` now, made once from one read, before anything is created — and that read is of **the app worker's** `wrangler.jsonc` in all six. Four of them read `<root>/wrangler.jsonc`, a file a Pithy project has never had: every deployable Worker lives in `apps/<name>/` with its own config, and there is no root Worker. So `pithy media`, `payments`, `storage` and `testers` each died on a missing file before reaching the partition, the skip, the report or the exit code. They resolve the Worker the way `email` and `support` already did, and each takes the same `--worker` flag for a project that has several. The Workflow bindings `payments`, `storage` and `testers` write on the way out — `PAYMENTS_RECONCILE`, the storage sweep, `TESTERS_DAILY` — land in that same file rather than in a root config nothing loads. An id that is present but empty counts as unprovisioned, because `""` is what a half-written `wrangler.jsonc` holds. An unready environment is **skipped** — never fatal — and every skip names why and the command that resolves it, in text and in `--json` alike. A skip is the third outcome and never renders as a success, because a report that cannot tell *deployed* from *skipped* cannot answer *did production get its email worker*.

`pithy vector` had the same root-file defect and none of the fan-out, so it needed the routing correction and not the skip. It read `<root>/wrangler.jsonc` three times — the app database id, the `VECTOR_PROVISIONED` drift record, and the `vectorize` and `workflows` bindings — so every subcommand was unusable in every scaffolded project, and it died on a raw `ENOENT` rather than on a `PithyError` naming the remedy. All three now resolve the app Worker and take `--worker`. The refusal stays a refusal: every `pithy vector` subcommand takes a required `--env`, so there is one environment for it to be about and nothing to skip past. The rule that keeps it true is quantified over the whole commands directory now — **no command reads a `wrangler.jsonc` at the project root** — rather than over the six, which is how `vector`'s exclusion from the skip was read as an exclusion from the routing.

Project-global resources are still created on the first run however many environments skip: the email suppression database and the support bucket are one per project and must not wait for production. The two Email Routing rules now wait for the first host instead — a rule made over a run that deployed nothing starts delivering real mail to a handler that is not there.

Exit codes say what happened. Zero when at least one environment was provisioned, whatever else was skipped; **non-zero when every environment was skipped**, naming each, because reporting success for a run that did nothing is the failure mode this change would otherwise introduce. Under `--json` the per-environment line is written to stdout first, so the structure survives the refusal that follows it on stderr.

`pithy secrets provision` is untouched and stays that way. It creates each environment's database rather than reading one, and it is step 1 of any bring-up — a regression test pins that it still spans every declared environment, with no readiness input and no skip field.
