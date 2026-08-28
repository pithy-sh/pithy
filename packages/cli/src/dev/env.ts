// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CI_ENV, isContinuousIntegration } from "@pithy-sh/core/src/env/ci";
import { envStem } from "@pithy-sh/core/src/env/stem";
import { WORKER_ORIGIN_VAR } from "@pithy-sh/core/src/worker/identity";
import type { DevConfig } from "../feature/devConfig";
import { DEV_PORT_TOKEN } from "../project/workerManifest";
import type { WorkerTarget } from "../project/workers";

/**
 * Build the environment every child inherits: the parent env plus, for **every** worker in the feature's
 * dev config, `<STEM>_PORT` and `<STEM>_ORIGIN`. That is how workers reach each other — each sibling's
 * localhost address is known ahead of time and injected, so a worker calls its peers directly instead of
 * relying on wrangler's flaky cross-`wrangler dev` service registry.
 */
export function buildWorkerEnv(config: DevConfig, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [name, worker] of Object.entries(config.workers)) {
    const stem = envStem(name);
    env[`${stem}_PORT`] = String(worker.port);
    env[`${stem}_ORIGIN`] = worker.origin;
  }
  return env;
}

/**
 * The origin to hand one worker as its own, or `null` when somebody else owns it.
 *
 * `null` is a capability host: its `BASE_URL` is the *app's* origin, because it holds no public route
 * and a verification link it mails has to arrive back at the app. `materializeHostConfigs` writes that
 * into the host's generated config, so a value from here could only be a second producer of one
 * setting — and the one it would produce is the wrong one.
 *
 * One function rather than a condition repeated at each carrier, so a host cannot be exempt from the
 * argv path and not from the environment path.
 */
export function ownOriginFor(workerName: string, origin: string, hostNames: ReadonlySet<string>): string | null {
  return hostNames.has(workerName) ? null : origin;
}

/**
 * One child's environment: everything {@link buildWorkerEnv} publishes, plus that child's own origin.
 *
 * Per child, and that is the point. `buildWorkerEnv` is built once and shared, because `<STEM>_ORIGIN`
 * is the same table of *other people's* addresses for everybody. "Where do I answer" is the one fact
 * that differs per child, so it cannot live in the shared object.
 */
export function childEnvFor(shared: Record<string, string>, ownOrigin: string | null): Record<string, string> {
  if (ownOrigin === null) return shared;
  return { ...shared, [WORKER_ORIGIN_VAR]: ownOrigin };
}

/** Turn `["dev", "--port", "8787"]` into a spawnable `{ command, args }` via the project's package manager. */
export type WranglerLauncher = (args: string[]) => { command: string; args: string[] };

/** A resolved start command for one worker. */
export interface StartCommand {
  command: string;
  args: string[];
}

/**
 * The command that starts one worker at its pinned `port`.
 *
 * A worker with an explicit `dev.command` (e.g. a Vite frontend with no `wrangler.jsonc`) runs that verbatim
 * — the port is **not** appended; it reaches the process through `<STEM>_PORT` in the env, or through the
 * `{port}` token wherever the manifest placed it on the argv. That token is the one substitution, and it
 * exists because the orchestrator spawns with no shell: `$WEB_PORT` in an argv array is a literal, never an
 * expansion, and a dev server that takes its port as a flag (`vite dev --port {port}`) has nowhere else to
 * read it. A command with no token runs byte-identically. A plain Worker runs `wrangler dev --port <port>
 * --inspector-port 0` (inspector `0` auto-assigns, so multiple workers never collide on the inspector port),
 * resolved through the project's package manager rather than a hardcoded global wrangler.
 *
 * **`--persist-to` is what makes local sharing real.** Every Worker lives in its own `apps/<name>/` and
 * wrangler defaults its local state to the *cwd* it runs in, so each Worker would get its own `.wrangler/`
 * store — and two Workers that deliberately declare the same binding (the way Workers share a database)
 * would silently read and write two different local D1s, with the divergence showing up only as
 * inexplicably missing rows. Pointing every Worker at one project-level store makes local behave the way
 * the deployed environment does.
 */
export function startCommand(
  worker: WorkerTarget,
  port: number,
  origin: string | null,
  launchWrangler: WranglerLauncher,
  persistTo: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  hostPorts: Readonly<Record<string, number>> = {},
): StartCommand {
  const custom = worker.dev?.command;
  if (custom && custom.length > 0) {
    // A custom command is run verbatim: it is not necessarily wrangler, so no flag is appended. The only
    // edit is `{port}` → the pinned port, in every element that carries it. It also gets no `--var`: the
    // process already inherits the real environment through `buildWorkerEnv`, which is exactly what the
    // forwarding below exists to work around for workerd.
    const resolved = custom.map((part) => part.replaceAll(DEV_PORT_TOKEN, String(port)));
    return { command: resolved[0] as string, args: resolved.slice(1) };
  }
  return launchWrangler([
    "dev",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--persist-to",
    persistTo,
    ...ownOriginVarArgs(origin),
    ...ciVarArgs(baseEnv),
    ...hostVarArgs(worker.name, hostPorts),
  ]);
}

/**
 * Tell the Worker where it itself answers, as `BASE_URL`.
 *
 * **The one address a Worker cannot work out and cannot be made to write down.** It cannot derive it
 * from a request: `Host` is caller-controlled, so a Worker that did would take its own identity from
 * whoever called it. And it cannot state it in `wrangler.jsonc`, because a dev port is *allocated* —
 * every checkout reserves its own block, so a literal there is right in the first checkout on a machine
 * and wrong in every other one. `pithy dev` is the only party that knows, and this is where it says so.
 *
 * `--var` beats a `vars` entry in the config, so a project that already wrote a dev `BASE_URL` down is
 * corrected rather than asked to edit anything. Deployed environments never reach here: `applyDomains`
 * generates theirs from the `domains` declaration, and this runs only under `pithy dev`.
 *
 * **Note what this is not.** {@link hostVarArgs} deliberately withholds a host's own `<STEM>_ORIGIN`,
 * because that var names a *dispatch target* and a Worker posting to itself is a request that answers
 * itself forever. `BASE_URL` is the opposite kind of fact — it is an identity, the `iss` a
 * control-plane token carries and the origin a callback link is built against — and withholding it is
 * what made `pithy-sh/dashboard#95`: a second checkout signed tokens as the first one and its own seam
 * denied every call. The two vars look alike and mean opposite things.
 *
 * The origin travels **verbatim** from `.dev.config.json` rather than being rebuilt as
 * `http://localhost:${port}`. The config pins both, and recomposing one from the other is a second
 * producer of a value that is already written down — the same rule `SeedPrepareContext.origin` states.
 *
 * **`null` means somebody else owns this Worker's `BASE_URL`, and today that is a capability host.**
 * A host's is the *app's* origin, not its own: it holds no public route, and a callback link it mails
 * has to arrive back at the app. `materializeHostConfigs` writes that value into the host's generated
 * `wrangler.jsonc`, from the same allocation, so a `--var` here could only be a second producer of one
 * value — and the one it would produce is the wrong one. Overriding it would point every verification
 * link at the email host.
 */
function ownOriginVarArgs(origin: string | null): string[] {
  if (origin === null) return [];
  // wrangler splits a `--var` at its first colon, so the `http://` in the value survives intact.
  return ["--var", `BASE_URL:${origin}`];
}

/**
 * Forward each capability host's address into the Worker as vars.
 *
 * Same reason as {@link ciVarArgs}, and the same mechanism: `buildWorkerEnv` publishes
 * `<STEM>_ORIGIN` and `<STEM>_PORT` into every child *process*, and the host environment does not
 * cross into workerd. So an app Worker asking for `EMAIL_ORIGIN` — the address core's loopback
 * dispatcher posts a Workflow dispatch to, in place of the cross-script binding a deployed
 * environment has — would read nothing at all. One `--var` per host is what makes the read truthful.
 *
 * Only the hosts, not every sibling. An `apps/*` Worker reaches another over `<STEM>_ORIGIN` in the
 * *process* env today, and widening this to all of them is a change to what every Worker sees rather
 * than the one wire this issue is about (pithy-sh/pithy#410).
 *
 * A host is never handed its own address: it *is* the thing at that origin, and a self-dispatch
 * loop is a request that answers itself forever.
 *
 * **That is a rule about dispatch targets, not about self-knowledge.** A Worker does learn where it
 * itself answers — see {@link ownOriginVarArgs}, which hands it exactly that as `BASE_URL`. The two
 * vars are adjacent, look alike, and mean opposite things: `<STEM>_ORIGIN` is somewhere to send a
 * request, `BASE_URL` is who you are. Reading the paragraph above as "a Worker never learns its own
 * origin" is what left every checkout but the first signing tokens as another one (#462).
 */
function hostVarArgs(workerName: string, hostPorts: Readonly<Record<string, number>>): string[] {
  const args: string[] = [];
  for (const [name, port] of Object.entries(hostPorts)) {
    if (name === workerName) continue;
    const stem = envStem(name);
    // wrangler splits a `--var` at its first colon, so the `http://` in the value survives intact.
    args.push("--var", `${stem}_ORIGIN:http://localhost:${port}`, "--var", `${stem}_PORT:${port}`);
  }
  return args;
}

/**
 * Forward `CI` into the Worker as a var, when this process is running under one.
 *
 * **The host's environment does not cross into workerd.** With `nodejs_compat`, `process.env` inside a
 * Worker is populated from that script's own `vars` and secrets and nothing else — verified against a
 * real `wrangler dev`, where `Object.keys(process.env)` at module scope is exactly the declared vars. So
 * a capability that refuses to register itself under CI (`@pithy-sh/auth`'s dev-login route is the first)
 * cannot see the `CI=true` that GitHub Actions set in the shell that ran this command. One `--var` is
 * what makes that read truthful for every Worker Pithy starts.
 *
 * Nothing is forwarded off CI, so an ordinary `pithy dev` writes no var and the Worker's `process.env` is
 * byte-identical to what it was. And the forwarding is a convenience, never the security boundary: the
 * capability's environment gate refuses in `staging` and `prod` with no cooperation from anything here.
 */
function ciVarArgs(env: NodeJS.ProcessEnv): string[] {
  if (!isContinuousIntegration(env)) return [];
  // The value travels verbatim rather than normalized to `true`: "any non-blank value" is the rule at
  // both ends (#218), and rewriting it here would be this file inventing a second one.
  return ["--var", `${CI_ENV}:${env[CI_ENV] ?? ""}`];
}
