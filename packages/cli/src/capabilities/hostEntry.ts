// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { packageInstalledFrom } from "../project/kitResolve";
import { kitSource } from "../project/kitSource";
import { capabilityLoadError } from "./loadFailure";

/**
 * **A host Worker's composition, written as the entry it is deployed from** (#645).
 *
 * An app Worker composes capabilities, and a capability reaches an optional peer through its `compose` hook:
 * `payments()` finds the ledger, `testers()` finds auth. A host Worker composes nothing — it is a prebuilt
 * module inside the package, deployed straight from `node_modules` — so it has no hook and nothing to find a
 * peer in. It used to import the peer instead, behind a `try`, and wrangler's esbuild resolves a literal
 * specifier whether or not the branch holding it ever runs: every project that composed payments without the
 * ledger could not deploy its payments host at all.
 *
 * The CLI is the one party that sees both halves — the project's composition, and the host it is deploying — so
 * it writes the composition down. When a project composes a peer a host can use, the host is deployed from a
 * generated entry that imports the peer's surface from the project's own install, hands it to the host's
 * `providePeers`, and re-exports the host unchanged. A project that composes no such peer gets no entry and
 * the host deploys from its own `worker.ts`, exactly as before, with no specifier to resolve.
 *
 * **Only when the installed packages can take it (#645 review).** The CLI and the packages it deploys are
 * released apart, so a newer `pithy` meets an older host as a matter of course — the dashboard ran testers
 * 0.2.9 beside auth, and an entry naming `hostPeers` failed its deploy outright. A host older than the seam
 * reaches its peers itself, as it always did, so it gets no entry and deploys from its own `worker.ts`
 * exactly as before. A host that takes peers beside a peer too old to hand one over is the other half, and it
 * is refused by name: deployed from its own entry it would run without the peer, and say nothing.
 *
 * **Absolute paths, resolved from the project.** The entry is written beside a config wrangler reads, which is
 * inside the installed package for a deploy and under `.wrangler/` for `pithy dev`; an absolute path resolves
 * the same from either, and resolving it from the project — never from the CLI — is #533's rule.
 */

/** One optional peer a host can be handed: the capability that supplies it and the module its surface is in. */
export interface HostPeer {
  /** The supplying capability's name — the key `providePeers` receives it under. */
  readonly capability: string;
  /** The module that exports the surface, as a project resolves it: `@pithy-sh/ledger/src/peer`. */
  readonly module: string;
  /** The surface's export name in that module: `ledgerPeer`. */
  readonly export: string;
}

/** How a host receives peers: the module exporting its `providePeers`, and which peers this composition has. */
export interface HostPeerSeam {
  /** The host's own module that exports `providePeers`: `@pithy-sh/payments/src/workflows/hostPeers`. */
  readonly provide: string;
  /** The peers this composition hands the host. Empty means the host deploys from its own entry. */
  needed(capability: Capability, siblings: readonly Capability[]): readonly HostPeer[];
}

/** The generated entry's file name for one environment, beside the config that names it. */
export function hostEntryFile(env: string): string {
  return `.pithy-host.${env}.ts`;
}

/** The package a kit specifier names: `@pithy-sh/ledger` from `@pithy-sh/ledger/src/peer`. */
function packageOf(specifier: string): string {
  return specifier.split("/").slice(0, 2).join("/");
}

/**
 * Whether the project's install carries a kit module. False for a package that is absent, and for one released
 * before the module existed — which is the question this file asks of a host and of each peer.
 */
export function kitCarries(projectDir: string, specifier: string): boolean {
  try {
    kitSource(projectDir, specifier);
    return true;
  } catch {
    return false;
  }
}

/** The host's own module on disk, or the actionable refusal a missing package earns. */
function source(projectDir: string, specifier: string): string {
  try {
    return kitSource(projectDir, specifier);
  } catch (error) {
    const pkg = packageOf(specifier);
    throw capabilityLoadError(pkg.replace("@pithy-sh/", ""), pkg, error, projectDir);
  }
}

/**
 * A peer's surface on disk — or, when the project cannot supply it, the refusal that says which of two things
 * is wrong: the peer is not installed at all, or it is installed and older than the surface.
 */
function peerSource(projectDir: string, host: HostEntryTarget, peer: HostPeer): string {
  if (kitCarries(projectDir, peer.module)) return kitSource(projectDir, peer.module);
  const pkg = packageOf(peer.module);
  if (!packageInstalledFrom(projectDir, pkg)) return source(projectDir, peer.module);
  throw new ValidationError({
    message: `The ${host.capability} host reads ${peer.capability}, and the installed ${pkg} is too old to hand it over.`,
    action: `Upgrade ${pkg} to the version ${host.package} peers, then deploy again.`,
    detail: `${pkg} is installed and carries no ${peer.module}, which ${host.package} reads its ${peer.export} from. Deployed from its own worker.ts instead, the host would run without ${peer.capability} and say nothing.`,
  });
}

/** The host a generated entry is for: its registry row, as far as this file reads it. */
export interface HostEntryTarget {
  /** The capability that owns the host, named in a refusal. */
  readonly capability: string;
  /** The package the host ships in, named in a refusal. */
  readonly package: string;
  /** The host's worker module, re-exported by the entry. */
  readonly entry: string;
  /** How it receives peers. Absent for a host that reaches none. */
  readonly peers?: HostPeerSeam;
}

/**
 * The entry a host is deployed from when this composition hands it peers, or `undefined` when it hands none —
 * in which case the host deploys from its own `worker.ts` and nothing here is written. Also `undefined` for a
 * host installed from a release that takes no peers: it reaches them itself, and deploys as it always did.
 */
export function hostEntrySource(
  projectDir: string,
  host: HostEntryTarget,
  capability: Capability,
  siblings: readonly Capability[],
): string | undefined {
  const seam = host.peers;
  if (seam === undefined) return undefined;
  const peers = seam.needed(capability, siblings);
  if (peers.length === 0) return undefined;
  // The host's own half first. A host from before #645 has no `providePeers` to hand anything to, and it
  // imports its peers itself — so it is deployed exactly as before, and no peer is asked about.
  if (!kitCarries(projectDir, seam.provide)) return undefined;
  const worker = JSON.stringify(source(projectDir, host.entry));
  const imports = peers.map(
    (peer, index) =>
      `import { ${peer.export} as peer${index} } from ${JSON.stringify(peerSource(projectDir, host, peer))};`,
  );
  const handed = peers.map((peer, index) => `${JSON.stringify(peer.capability)}: peer${index}`).join(", ");
  return [
    "// Generated by pithy on every deploy, and removed after it. Not for editing.",
    "//",
    "// This host composes nothing, so the optional peers the project composes are handed to it here, from the",
    "// project's own install, before the host is re-exported unchanged.",
    ...imports,
    `import { providePeers } from ${JSON.stringify(source(projectDir, seam.provide))};`,
    "",
    `providePeers({ ${handed} });`,
    "",
    `export * from ${worker};`,
    `export { default } from ${worker};`,
    "",
  ].join("\n");
}
