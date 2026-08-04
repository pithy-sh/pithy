// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { isControlPlaneCapability } from "@pithy-sh/core/src/controlPlane/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { loadWorkerDomains } from "../project/config";
import { type AddressStanza, describeAddressSource, resolveWorkerAddress } from "../project/workerAddress";
import { type ResolvedWorker, resolveSingleWorker } from "../project/workerScope";
import { readWranglerConfig } from "../project/wrangler";

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

/**
 * Resolve the Worker, address, and base path a connect targets.
 *
 * `workerUrl` still overrides everything — an adopter fronting their Worker with a proxy has an address
 * no config knows. It remains the escape hatch, not the requirement.
 */
export async function resolveConnectTarget(options: {
  projectDir: string;
  environment: string;
  /** `--worker`, when given. Absent in a single-Worker project; required when there are several. */
  worker?: string | undefined;
  /** `--worker-url`, when given. Overrides the resolver. */
  workerUrl?: string | undefined;
}): Promise<ConnectTarget> {
  const worker = await resolveSingleWorker({
    projectDir: options.projectDir,
    ...(options.worker === undefined ? {} : { worker: options.worker }),
  });

  const basePath = composedBasePath(worker);
  if (basePath === null) {
    throw new ValidationError({
      message: `${worker.name} does not compose the control-plane seam, so there is nothing to connect.`,
      action: "Add `controlplane()` to that Worker's pithy.config.ts, deploy, then run connect again.",
      detail: `no controlplane capability in ${worker.dir}'s composed set`,
    });
  }

  if (options.workerUrl) {
    return { worker, workerUrl: options.workerUrl, basePath, source: "from --worker-url" };
  }

  let stanza: AddressStanza | undefined;
  try {
    stanza = ((await readWranglerConfig(worker.dir)) as { env?: Record<string, AddressStanza | undefined> }).env?.[
      options.environment
    ];
  } catch {
    stanza = undefined;
  }

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

/** The line shown before registering, so an operator sees the address and where it came from. */
export function describeConnectTarget(target: ConnectTarget): string {
  return `${target.worker.name} → ${target.workerUrl}${target.basePath} (${target.source})`;
}
