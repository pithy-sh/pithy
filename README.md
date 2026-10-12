<p align="center">
  <img src="https://pithy.sh/static/assets/pithy-wordmark-paths.svg" alt="pithy." width="180">
</p>

<p align="center">A backend kit. For Cloudflare. That's it.</p>

---

Pithy is an open-source backend kit for mobile and web apps, built on [Cloudflare Workers](https://developers.cloudflare.com/workers/). Auth, payments, email, storage, search, multiplayer and more ship as capability packages under `@pithy-sh/*`, and the `pithy` CLI wires them into your Worker. You own the Worker, the Cloudflare account and the data. There is no data plane we operate.

The logic lives in the packages and upgrades with them. The surface you own is thin: a `pithy.config.ts`, a `wrangler.jsonc` and a mount file per Worker.

**The complete documentation is on the website, at [pithy.sh/docs](https://pithy.sh/docs/start-here/introduction/).** Every capability, every command, and every concept, with guides from first install to production. This README is the overview.

## Quickstart

You need [Node.js](https://nodejs.org) 22.18 or newer. If you run Pithy under [Bun](https://bun.sh), use 1.4 or later; on an older Bun, upgrade Bun to 1.4.2. No Cloudflare account until you deploy.

```sh
bun add --global @pithy-sh/cli      # or: npm install --global @pithy-sh/cli

mkdir my-backend && cd my-backend
pithy init                          # scaffold a project and its first Worker, apps/api
bun install
pithy dev                           # every Worker in apps/, under one supervisor

curl http://localhost:8787/health   # {"status":"ok","version":…}
```

Then add what your app needs:

```sh
pithy add auth
```

`pithy add` installs the package, wires it into that Worker's config and bindings, and runs its migrations. The handler code stays in the package, so a minor release upgrades it. The [Quickstart](https://pithy.sh/docs/start-here/quickstart/) walks through every file `init` writes, and [Deploy it](https://pithy.sh/docs/start-here/deploy-it/) takes it to Cloudflare.

## Capabilities

Each one is a package you add to a Worker with `pithy add <name>`, and each runs in your own Worker against your own D1, KV and R2.

| Capability | What it does |
|---|---|
| [`auth`](https://pithy.sh/docs/capabilities/auth/) | Passwordless identity, sessions, short-lived access tokens, and devices. |
| [`organization`](packages/organization/README.md) | Tenancy: organizations, memberships, the roles you declare, and invitations. |
| [`turnstile`](https://pithy.sh/docs/capabilities/turnstile/) | A humanity check you stack on any route. |
| [`audit`](https://pithy.sh/docs/capabilities/audit/) | Who did what, when, and whether it succeeded. |
| [`secrets`](https://pithy.sh/docs/capabilities/secrets/) | Encrypted storage per environment, with a Worker-only master key and rotation. |
| [`email`](https://pithy.sh/docs/capabilities/email/) | Durable, tracked, themeable mail. Every send is a job, never an inline call. |
| [`payments`](https://pithy.sh/docs/capabilities/payments/) | Five payment rails, one entitlement. |
| [`ledger`](https://pithy.sh/docs/capabilities/ledger/) | A per-user balance that cannot go negative, with holds that make wagering safe. |
| [`storage`](https://pithy.sh/docs/capabilities/storage/) | Files in your own R2, with an owner, a quota and revocable share links. |
| [`media`](https://pithy.sh/docs/capabilities/media/) | Images, video, audio and documents, with direct upload and optional enrichment. |
| [`vector`](https://pithy.sh/docs/capabilities/vector/) | Semantic search on Workers AI and Vectorize. |
| [`i18n`](https://pithy.sh/docs/capabilities/i18n/) | A translator seam every screen, error and email renders through. |
| [`support`](https://pithy.sh/docs/capabilities/support/) | An inbound inbox, classified on your own AI binding. |
| [`testers`](https://pithy.sh/docs/capabilities/testers/) | The Google Play closed-test roster and its fourteen-day clock. |
| [`leaderboard`](https://pithy.sh/docs/capabilities/leaderboard/) | Boards and time windows, with closed windows kept in your D1. |
| [`rating`](https://pithy.sh/docs/capabilities/rating/) | Skill ratings per player, per pool. |
| [`matchmaking`](https://pithy.sh/docs/capabilities/matchmaking/) | Four ways players find each other, each ending at a session id. |
| [`multiplayer`](https://pithy.sh/docs/capabilities/multiplayer/) | Authoritative turn-based sessions. The server holds what no client can be trusted with. |

Two more pieces ride along with every project. The [control plane](https://pithy.sh/docs/capabilities/control-plane/) is the inbound administration seam, present and denying by default. `pithy ui add react` scaffolds a [front end](https://pithy.sh/docs/front-ends/) into a Worker you already have, on the same origin as its API.

## Built for agents too

Every command but the deliberately manual `pithy remove` takes full flags, answers with `--json`, and never prompts when told not to. `pithy schema --json` describes each one, and a failure exits with a code that says what to do next. So you and your coding agent drive the same CLI. `pithy docs connect` points Claude Code, Cursor, VS Code and seven other clients at the Pithy documentation server. See [Pithy for agents](https://pithy.sh/docs/agents/).

## One project, or two?

Do these apps share users or data? Then it is one project with more Workers, not two projects. Two projects never share, because each carries its own migration registry. Every resource Pithy provisions is named `<project>-<env>-<thing>`, so separate projects can still live in one Cloudflare account. The project name comes from `name` in the root `pithy.config.ts`. It stops at 26 characters, and it is permanent once anything is provisioned, so the [full answer](https://pithy.sh/docs/core-concepts/one-project-or-two/) is worth reading before `pithy init`. Every limit is in [`docs/NAMING.md`](docs/NAMING.md).

## In this repository

To build *with* Pithy, use [pithy.sh/docs](https://pithy.sh/docs/start-here/introduction/), the complete documentation. What lives here are the specifications for building Pithy itself.

- [`docs/CLI.md`](docs/CLI.md) and [`docs/commands/`](docs/commands/): command behavior, flags, `--json` and errors.
- [`docs/NAMING.md`](docs/NAMING.md): how every provisioned resource is named, and every limit.
- [`docs/UI.md`](docs/UI.md): front ends and the one-origin model.
- [`docs/I18N.md`](docs/I18N.md): the translator seam, catalog keys, and what stays English.
- [`docs/STACK.md`](docs/STACK.md): the toolchain.
- [`docs/BRAND.md`](docs/BRAND.md): identity and voice.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to work here, and what a pull request needs to merge.

## License

MIT, except `@pithy-sh/audit`, which is [FSL-1.1-MIT](packages/audit/LICENSE). See [`LICENSE`](LICENSE).
