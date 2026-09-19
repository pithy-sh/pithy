// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { isControlPlaneCapability } from "@pithy-sh/core/src/controlPlane/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resolveSingleWorkerFor } from "../project/composeFor";
import { loadWorkerDomains } from "../project/config";
import { describeAddressSource, readAddressStanza, resolveWorkerAddress } from "../project/workerAddress";
import type { ResolvedWorker, ResolveSingleOptions } from "../project/workerScope";

/**
 * What `pithy dashboard connect` is registering: which Worker, at what address, with the seam mounted
 * where.
 *
 * ## Why the Worker has to be named
 *
 * The administrative surface is composed on **one Worker per project**, and a connection targets it. In
 * a multi-Worker project, "connect this project" is ambiguous, and guessing means registering an address
 * that answers nothing. Every other per-Worker command already refuses that ambiguity through
 * `resolveSingleWorker` — this reuses it rather than inventing a second rule.
 *
 * Sibling Workers are not separately addressable, which is right: the data being administered is shared
 * through binding names, not owned per Worker.
 *
 * ## Why the address is resolved rather than demanded
 *
 * `connect` used to require `--worker-url` with no fallback at all, and softened it only with an
 * interactive free-text prompt — so the agent and CI path, which is the one that matters for
 * automation, simply threw. The project already knows where its Workers answer; asking again invites a
 * value that disagrees with the routes beside it.
 *
 * ## Why the base path comes from the composed config
 *
 * It is the one address a client cannot discover, because it *is* the manifest's own address. Reading it
 * off the composed capability means an adopter who moved the mount has their real one registered, rather
 * than the default being assumed on their behalf — which registers cleanly, passes the ping at that same
 * assumed path, and then 404s on every call.
 */

/** The Worker a connection targets, and how to reach its seam. */
export interface ConnectTarget {
  /** The resolved Worker. */
  worker: ResolvedWorker;
  /** Its base URL for this environment. */
  workerUrl: string;
  /** Where its control-plane seam is mounted, from the composed capability's resolved config. */
  basePath: string;
  /** A one-line account of where the address came from, for the confirmation line. */
  source: string;
}

/** The seam's mount point on this Worker, or null when it composes no seam. */
function composedBasePath(worker: ResolvedWorker): string | null {
  const seam = worker.capabilities.find(isControlPlaneCapability);
  return seam ? seam.controlPlaneConfig.basePath : null;
}

/** Which Worker a connect is about, and the seams a test resolves it through. */
export interface ConnectWorkerOptions {
  projectDir: string;
  environment: string;
  /** `--worker`, when given. Absent in a single-Worker project; required when there are several. */
  worker?: string | undefined;
  /** Discovery seam, forwarded to the resolver. */
  discoverWorkers?: ResolveSingleOptions["discoverWorkers"];
  /** Worker-config loader seam, forwarded to the resolver. */
  loadConfig?: ResolveSingleOptions["loadConfig"];
}

/**
 * The Worker this connect is about, composed for the environment, refusing one with no seam.
 *
 * Shared by both callers below, so "which Worker, and does it compose the seam" is answered once. The
 * two differ only in what they go on to need: an address, or the composed set.
 */
async function resolveSeamWorker(options: ConnectWorkerOptions): Promise<{ worker: ResolvedWorker; basePath: string }> {
  // Composed for the environment being connected: whether it composes the control-plane seam, and where,
  // is that environment's answer (#595).
  const worker = await resolveSingleWorkerFor(options.environment, {
    projectDir: options.projectDir,
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    ...(options.discoverWorkers === undefined ? {} : { discoverWorkers: options.discoverWorkers }),
    ...(options.loadConfig === undefined ? {} : { loadConfig: options.loadConfig }),
  });

  const basePath = composedBasePath(worker);
  if (basePath === null) {
    throw new ValidationError({
      message: `${worker.name} does not compose the control-plane seam, so there is nothing to connect.`,
      action: "Add `controlplane()` to that Worker's pithy.config.ts, deploy, then run connect again.",
      detail: `no controlplane capability in ${worker.dir}'s composed set`,
    });
  }
  return { worker, basePath };
}

/**
 * What the Worker composes, for a connect that needs a grant and no address.
 *
 * **`--scope all` reads the composed surface, and composing needs no address.** Resolving the two
 * together meant a scope-only `--update` — widening an existing connection after composing a new
 * capability, which is the case `all` exists for — resolved no Worker at all, so `all` found nothing to
 * grant and refused on every project, with the `pithy.config.ts` that answers the question sitting
 * unread beside it. Its two suggested remedies each undid the point: `--worker-url` re-points the
 * connection's URL as a side effect of a scope change, and naming each scope is the hand-maintained
 * list `all` exists to replace.
 *
 * Separate functions rather than an address that is sometimes absent: a `ConnectTarget` whose
 * `workerUrl` may be missing is one every caller has to re-check, and the caller that forgets registers
 * a connection pointing nowhere.
 */
export async function resolveConnectScopes(options: ConnectWorkerOptions): Promise<Capability[]> {
  return (await resolveSeamWorker(options)).worker.capabilities;
}

/**
 * Resolve the Worker, address, and base path a connect targets.
 *
 * `workerUrl` still overrides everything — an adopter fronting their Worker with a proxy has an address
 * no config knows. It remains the escape hatch, not the requirement.
 */
export async function resolveConnectTarget(
  options: ConnectWorkerOptions & {
    /** `--worker-url`, when given. Overrides the resolver. */
    workerUrl?: string | undefined;
  },
): Promise<ConnectTarget> {
  const { worker, basePath } = await resolveSeamWorker(options);

  if (options.workerUrl) {
    return { worker, workerUrl: options.workerUrl, basePath, source: "from --worker-url" };
  }

  // From the file that describes this environment — a feature's generated config, not the tracked one (#643).
  const stanza = await readAddressStanza(worker.dir, options.environment);

  const address = resolveWorkerAddress({
    environment: options.environment,
    domains: loadWorkerDomains(worker.config),
    stanza,
  });
  if (!address) {
    throw new ValidationError({
      message: `${worker.name} has no ${options.environment} address to register.`,
      action:
        'Declare it in the Worker\'s pithy.config.ts — `domains: { prod: { pattern: "api.example.com", zone: "example.com" } }` — or pass --worker-url.',
      detail: `no domains declaration, route, or vars.BASE_URL resolved for env.${options.environment} in ${worker.dir}`,
    });
  }

  return { worker, workerUrl: address.url, basePath, source: describeAddressSource(address.source) };
}

/**
 * The composed surface a grant is derived from: the resolved target's, or — under `--scope all` alone —
 * the project's own, read with no address.
 *
 * **One function because it is one rule, and it was a ternary in `connect`'s `run` where no test could
 * reach it.** Deleting the middle branch reinstates the defect whole: `--update --scope all` composes
 * nothing, so `all` finds nothing to grant and refuses on every project, and the suite stays green. The
 * rule runs here now, and `resolveTarget.test.ts` goes red for it.
 *
 * Nothing else reads the composition, and that is deliberate. A key-only `--update` — including the
 * offline `--public-key` rotation on a proxy-fronted project — derives no grant, and going to read a
 * `pithy.config.ts` for it would demand a Worker that resolves *and* composes the seam for a rotation
 * that needs neither.
 */
export async function composedForGrant(
  options: ConnectWorkerOptions & {
    /** The resolved target, when an address was needed. Null on an update that resolved none. */
    target: ConnectTarget | null;
    /** True under `--scope all` — the one grant derived from the composition rather than from the flags. */
    all: boolean;
  },
): Promise<Capability[]> {
  if (options.target) return options.target.worker.capabilities;
  return options.all ? resolveConnectScopes(options) : [];
}

/** The line shown before registering, so an operator sees the address and where it came from. */
export function describeConnectTarget(target: ConnectTarget): string {
  return `${target.worker.name} → ${target.workerUrl}${target.basePath} (${target.source})`;
}
