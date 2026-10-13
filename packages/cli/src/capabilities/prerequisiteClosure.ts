// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The prerequisites a capability brings with it, deepest first** — the walk `pithy add --with-prerequisites`
 * composes in, and the one a line naming that command reads to know what the flag will compose (#711). Its own
 * module so `addCommand.ts`, which spells the command, and `prerequisites.ts`, which refuses without it, both
 * read it without reading each other.
 */

/** The half of a manifest the walk reads: a name, and the peers it declares. */
export interface ManifestPeers {
  /** The capability's name. */
  readonly name: string;
  /** The capabilities it declares as prerequisites. */
  readonly peerCapabilities: readonly string[];
}

/** What {@link prerequisiteClosure} needs: the capability being added, what is already composed, and the manifests. */
export interface PrerequisiteClosureOptions {
  /** The manifest of the capability being added — the root of the walk. */
  manifest: ManifestPeers;
  /** The capability names this Worker already composes. A peer in here is satisfied and never proposed. */
  composed: ReadonlySet<string>;
  /**
   * A peer's manifest, or `undefined` when its package is not installed yet.
   *
   * Undefined is a real answer and not a failure: a peer nobody has installed is still missing, and
   * naming it beats silence. It is walked no deeper, because there is nothing there to read — the add
   * that composes it resolves its own peers once its package is on disk.
   */
  manifestFor: (name: string) => ManifestPeers | undefined;
}

/**
 * The prerequisites one capability needs and this Worker lacks, **deepest first**.
 *
 * Order is the point, which is why this is a graph walk and not a filter over `peerCapabilities`.
 * `auth` declares `secrets` and `email`; `email` declares `secrets`; and `pithy add email` into a
 * Worker with no secrets composed is the same defect one capability along. Post-order DFS puts a
 * capability after everything it reads, whatever order its manifest happens to list them in.
 *
 * Cycles terminate. Nothing in the kit declares one, and a manifest is somebody else's file.
 */
export function prerequisiteClosure(options: PrerequisiteClosureOptions): string[] {
  const { composed, manifestFor } = options;
  const order: string[] = [];
  const resolved = new Set<string>();
  // Everything currently on the walk, root included — a peer already being resolved above is what a
  // cycle looks like from in here, and re-entering it is what would not terminate.
  const walking = new Set<string>([options.manifest.name]);

  const visit = (manifest: ManifestPeers): void => {
    for (const peer of manifest.peerCapabilities) {
      if (composed.has(peer) || resolved.has(peer) || walking.has(peer)) continue;
      walking.add(peer);
      const peerManifest = manifestFor(peer);
      if (peerManifest) visit(peerManifest);
      walking.delete(peer);
      resolved.add(peer);
      order.push(peer);
    }
  };
  visit(options.manifest);
  return order;
}
