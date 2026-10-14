---
name: new-app
description: Start a new app on Pithy. Asks web, mobile or both, scaffolds the project with pithy init, adds the capabilities, and brings in only the agents the answer needs. Use when someone wants to build a new app or backend on Pithy.
argument-hint: "[web|mobile|both]"
---

Start a new app on Pithy, end to end. You are the main session: you decide, the agents build.

## 1. Ask what `pithy init` asks

Ask one question at a time, and skip any the user already answered.

1. **Which clients call this backend?** `mobile` (an app store app, so the Worker is an API), `web` (a React app the same Worker serves) or `both`. This is `pithy init --target`, and it decides which agents you bring in.
2. **The project name.** It leads every Cloudflare resource the project provisions and cannot be changed once anything is provisioned. One project per set of apps that share users or data.
3. **The first Worker's name.** `api` unless they say otherwise.

## 2. Settle the design before any code

If `/app-design` has not run in this conversation, run it now: the capabilities, the data model, the auth flows. Do not scaffold a project whose capabilities are still undecided.

## 3. Scaffold

From the directory the project should live in:

```bash
pithy init --name <project> --worker <worker> --target <mobile|web|both> --json
```

Read the JSON it prints. `frontEnd` says whether a React app was scaffolded. Then install with the project's package manager.

Offer `pithy docs connect`, which points this session at the Pithy documentation server. It writes no credential.

## 4. Bring in the team

Dispatch each agent with the Agent tool, passing `subagent_type`, `model` and `effort` exactly as this table gives them. They are the user's choices from the plugin's settings, and they outrank each agent's own defaults.

A cell that still reads `${user_config.…}` is a setting the user never chose. Leave that parameter out of the call rather than passing the text, and the agent runs on its own default, which is the same one the settings offer.

| Agent | `subagent_type` | `model` | `effort` | When |
|---|---|---|---|---|
| Server | `pithy:server` | `${user_config.server_model}` | `${user_config.server_effort}` | Always. |
| Web client | `pithy:client-web` | `${user_config.client_web_model}` | `${user_config.client_web_effort}` | Target `web` or `both`. |
| Mobile client | `pithy:client-mobile` | `${user_config.client_mobile_model}` | `${user_config.client_mobile_effort}` | Target `mobile` or `both`. |
| Runner | `pithy:runner` | `${user_config.runner_model}` | `${user_config.runner_effort}` | Whenever something must be run. |

Never bring in a client the target did not ask for. A mobile project has no web agent, and a web project has no mobile agent.

In order:

1. **Server.** Hand it the design from step 2. It adds each capability with `pithy add <capability> --worker <worker> --with-prerequisites`, writes the app's routes and migrations, and runs `pithy contract`.
2. **Runner.** It runs `pithy migrate --dry-run`, then `pithy migrate`, then the tests and typecheck, and reports.
3. **Clients**, once the contract exists, in parallel when the target is `both`. The web client builds in the Worker `pithy init` scaffolded it into. The mobile client builds a React Native app in `mobile/` at the project root, outside `apps/`, which holds Workers only.
4. **Runner** again: `pithy dev`, and the clients' own tests.

## 5. Report

What exists now, in a few lines: the project, its Workers, its capabilities, the clients, and the one command that runs it all locally (`pithy dev`). Name anything left undecided, and anything an agent filed with `/report-kit-gap`.
