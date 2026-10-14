---
name: deploy
description: Deploy a Pithy app to staging or production, then connect the Pithy dashboard. Checks the Cloudflare credentials, shows what will be created, asks, then provisions, migrates and deploys. Use when someone wants to deploy, ship to staging, go live, put the app in production, or connect the dashboard, at any point in a build.
argument-hint: "[staging|prod]"
---

Deploy this project to a named environment, then offer the dashboard. You are the main session: you decide and ask, the runner runs. A deploy changes a Cloudflare account the person pays for, so nothing here runs until they say yes, and every yes is for one environment.

Dispatch the runner with the Agent tool, passing `subagent_type`, `model` and `effort` exactly as this table gives them. A cell that still reads `${user_config.…}` is a setting the user never chose. Leave that parameter out of the call.

| Agent | `subagent_type` | `model` | `effort` | When |
|---|---|---|---|---|
| Runner | `pithy:runner` | `${user_config.runner_model}` | `${user_config.runner_effort}` | Every command below. |

Tell the runner, each time, that the person approved this environment in this conversation. It runs `provision`, `migrate` and `deploy` against a named environment only on that word. The dashboard connect in step 5 is yours to run, not the runner's.

## 1. Which environment

`staging` unless they say otherwise. `dev` is `pithy dev`, local, and a feature environment belongs to `pithy feature create`; neither is deployed from here.

**Production is any environment the kit treats as one:** `prod`, and anything the root `pithy.config.ts` lists in `seed.productionEnvironments`. Deploy staging first when it has never been deployed, and say why: production is where a mistake costs real users.

## 2. Check before asking

Have the runner run `pithy doctor --json` and read it for this environment:

- **Credentials.** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for the account `pithy.config.ts` pins. If they are missing, stop and tell the person where they go: the file doctor's `Cloudflare:` line names (`<config>/cloudflare.json`, or `cloudflare.<accountName>.json` when the root `pithy.config.ts` names an account), or the shell. Never the repository's `.dev.vars`, which nothing reads for them any more. A token is minted in the Cloudflare dashboard, by them.
- **Every finding with a `fix`.** Run the fix when it is a `pithy` command that changes only this checkout. Ask first when it touches the account.

Then the plan, which writes nothing: `pithy provision --env <env> --dry-run --json`. It names each resource it would create or adopt, the config edits, the secrets and the migrations.

## 3. Ask

Tell the person, in a few lines: the environment, the account, what will be created on it, and that the Workers will answer at the addresses the plan names. Then ask whether to go ahead. A yes for staging is not a yes for production.

## 4. Provision, migrate, deploy

On a yes, in this order, each with `--json`, reading each result before the next:

1. **Provision**, when the plan created anything or the environment has never been deployed: `pithy provision --env <env> --yes --json`. It is safe to re-run.
2. **Migrate:** `pithy migrate --env <env> --json`. Deploy never migrates.
3. **Deploy:** `pithy deploy --env <env> --json`.

Follow every `fix` an error carries and every entry in `next`; both are runnable as written. Report the Workers, their addresses, and each one's verification: `verified`, or what the deploy found instead.

**Production asks in words.** Provisioning a production environment takes `--confirm` with the exact phrase `yes, i really want to provision <env>`. Ask the person to type it. Pass what they typed to `--confirm` verbatim, and never write the phrase yourself, correct it, or carry one over from another environment. If they would rather run it, give them the command to run with `! `.

**Exit 5 means stop.** A run that ends `core/person_required` is a step only the person may take. Put the question to them; never try a variation.

Never run `pithy remove` or a rollback from here. Those are the person's, in their own words.

## 5. Connect the dashboard

The hosted dashboard at `app.pithy.sh` is a management view of this environment, read from the person's own Worker through a connection they grant and can revoke. It keeps none of their data.

A staging or production deploy that left no connection carries it in `offers`. `offers` is not `next`: it is the person's choice, so put it to them rather than running it. Without one, check: `pithy dashboard status --env <env> --json`. `connected: false` means there is none.

Say what it is in two sentences, and that connecting is a browser sign-in they approve. On a yes, run the command `offers` names yourself, not through the runner: `pithy dashboard connect --env <env> --worker <name> --json`, in the background. It writes the sign-in address and a short code to stderr, then waits for the approval, and the runner would report only once it ends. So read its output as soon as they appear, give the person the address and the code, and wait for the command to finish. Then `pithy dashboard status --env <env> --json` confirms it: `connected: true`. A sign-in left too long expires; run it again.

A project that composes no control-plane seam has nothing to connect, and `offers` says nothing. Leave it there.

## 6. Report

The environment, what was created, the Workers and their addresses, the migrations applied, and whether the dashboard is connected. Name anything left for the person: a secret to set, a domain to point, a step they declined.
