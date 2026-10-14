# pithy

An agent team for building any app on [Pithy](https://pithy.sh), for Claude Code. A server, a web client, a mobile client and a runner, each on the model you choose. When it finds something the kit cannot do, it files the issue.

## Install

```text
/plugin marketplace add pithy-sh/pithy#release
/plugin install pithy@pithy
```

`#release` is deliberate. The `release` branch moves only when the kit is published to npm, so the plugin you install names exactly the commands your installed `pithy` CLI has. The repository's default branch runs ahead of npm between releases.

**Install from one source.** Either `pithy@pithy`, from this marketplace, or `pithy@synced`, from Anthropic's plugin directory. Not both: each loads its own copy, so every agent and skill would appear twice.

### Updates

A plugin's version is the `pithy` CLI's version, so an update arrives once per release. Claude Code does not auto-update a third-party marketplace by default. To turn it on, run `/plugin`, open **Marketplaces**, choose `pithy`, then **Enable auto-update**. To update by hand:

```text
/plugin marketplace update pithy
```

## The team

| Agent | Default | Job |
|---|---|---|
| Main session | Opus, high. Set it with `/model` and `/effort`. | Capabilities, data model, auth flows, which clients. The decisions that are expensive to get wrong. |
| `server` | Sonnet, medium | The Worker: `pithy.config.ts`, capabilities, app routes, migrations. |
| `client-web` | Sonnet, medium | A React app in the same Worker: `pithy ui add react`, `@pithy-sh/vite`, `@pithy-sh/ui-react`, the kit's TypeScript clients. Cookie sessions with CSRF, or bearer. |
| `client-mobile` | Sonnet, medium | A React Native app from the app stores: bearer tokens in secure device storage, device headers at sign-in, OAuth with PKCE and deep links. |
| `runner` | Haiku, low. Bash and Read only. | Runs `pithy dev`, the tests, typecheck and builds, and deploys an environment you approved. Returns a summary, never raw logs. |

Web and mobile are two agents because they authenticate two ways. One agent holding both would mix them.

### Choose each agent's model

Every agent's model and effort are settings: `server_model`, `server_effort`, `client_web_model`, `client_web_effort`, `client_mobile_model`, `client_mobile_effort`, `runner_model` and `runner_effort`, with the defaults above. Change them with `/plugin`, or from a shell. An option you leave out keeps its value:

```bash
echo '{"server_model": "opus", "server_effort": "high"}' | claude plugin configure pithy@pithy --values-stdin
```

`/new-app` and `/deploy` pass your choice on every agent they dispatch, and it outranks the agent's own default. An agent the main session reaches for on its own, outside those skills, runs on its own default: a plugin cannot put a setting into an agent's definition, and it cannot set the main session's model either, so that one is yours to set.

## The skills

- `/new-app`: asks what `pithy init` asks — web, mobile or both — then scaffolds the project, adds the capabilities, and brings in only the agents the answer needs.
- `/app-design`: settles the capabilities, the data model and the auth flows before any code.
- `/deploy`: takes the app to staging or production, and connects the dashboard. See below.
- `/report-kit-gap`: files what the kit cannot do against `pithy-sh/pithy`. It searches first, comments on a match, never includes your code or a secret, files only on your yes, and marks the workaround so it is removed when the fix ships.

## Deploy, and connect the dashboard

Ask for a deploy in any session, days into a build or on the first: `/deploy`, or just say so. The team checks your Cloudflare credentials, shows what it will create on your account, and asks. On your yes the runner provisions, migrates and deploys that one environment, and reports each Worker's address.

- **A yes is for one environment.** A yes to staging is not a yes to production.
- **Production takes a phrase you type.** `yes, i really want to provision prod`. The team passes it on exactly as typed and never writes it itself.
- **Then the dashboard.** After a staging or production deploy with no connection, it offers to connect the [Pithy dashboard](https://app.pithy.sh). On your yes it gives you a sign-in address and a short code, and you approve the connection in your browser.

It never runs `pithy remove` or a rollback. Those stay yours.

## Building against the contract

The agents build every client against the Worker's OpenAPI document, which `pithy contract` writes to `apps/<worker>/openapi.json`. A client in a language Pithy ships no client for generates its calls from the same file.

## What it builds on

The `AGENTS.md` block `pithy init` writes, the documentation server `pithy docs connect` adds, and `pithy schema --json`. Install the `pithy` CLI first.

## Outside Claude Code

The agents and skills drive the `pithy` CLI through a shell. Where a shell is not available, as on claude.ai, the skills that run commands cannot run them.
