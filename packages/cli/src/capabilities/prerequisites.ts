// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";

/**
 * **A capability's prerequisites are declared in its manifest, and every command reads them from there.**
 *
 * `peerCapabilities` has been in `pithy.manifest.json` since the contract landed, and `createBackend`
 * has always refused to assemble without them — `Capability "auth" requires the "secrets" capability,
 * which is not composed.` What was missing was anything between the two: `pithy add auth` wrote the
 * registration, said `Done.`, and left a Worker that could not start (#273). `pithy doctor` said the
 * project was healthy, because it checked bindings, config keys and migrations, and nobody had asked it
 * this question.
 *
 * So this module is the one place that answers it, for both commands. `pithy add` resolves the closure
 * before it wires anything; `pithy doctor` reports a composed capability whose peer is absent and fails
 * its exit. Neither hand-lists a capability's prerequisites, because hand-listing them is how the next
 * capability's get missed — `payments`, `support`, `storage`, `media` and `turnstile` all declare
 * `secrets`, and `testers` declares `email`.
 *
 * The manifest, and not the composed instance's `dependsOn`: the two mirror each other by test in each
 * capability's package, and the manifest is the half that is readable before a capability is composed —
 * which is exactly when `pithy add` has to decide.
 */

/** A composed capability whose declared prerequisite is not composed beside it. */
export const MissingPrerequisite = z
  .object({
    capability: z.string().describe("The composed capability that declares the prerequisite, by manifest name."),
    requires: z
      .string()
      .describe(
        "The capability it declares as a peer and this Worker does not compose. Boot refuses on exactly this pair.",
      ),
  })
  .describe("A composed capability whose manifest declares a peer the Worker's config does not register.");
export type MissingPrerequisite = z.infer<typeof MissingPrerequisite>;

/**
 * Whether a Worker's `pithy.config.ts` **registers** a capability — the call, not the import.
 *
 * The call is what composes, so the call is what is asked about. A config that imports `email` and never
 * writes `email()` composes nothing, and `createBackend` agrees. Anchored to the start of a line and to
 * the whole name, so `myauth(` is not `auth(` — the same rule `pithy add`'s idempotency check uses, and
 * it reads the source rather than importing it: the config this is asked about is frequently one that
 * cannot boot.
 */
export function isRegistered(source: string, name: string): boolean {
  return new RegExp(`^[ \\t]*${escapeRegExp(name)}[ \\t]*\\(`, "m").test(source);
}

/** Escape a capability name for use inside a `RegExp` (names are bare identifiers, but be safe). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What {@link prerequisiteClosure} needs: the capability being added, what is already composed, and the manifests. */
export interface PrerequisiteClosureOptions {
  /** The manifest of the capability being added — the root of the walk. */
  manifest: CapabilityManifest;
  /** The capability names this Worker already composes. A peer in here is satisfied and never proposed. */
  composed: ReadonlySet<string>;
  /**
   * A peer's manifest, or `undefined` when its package is not installed yet.
   *
   * Undefined is a real answer and not a failure: a peer nobody has installed is still missing, and
   * naming it beats silence. It is walked no deeper, because there is nothing there to read — the add
   * that composes it resolves its own peers once its package is on disk.
   */
  manifestFor: (name: string) => CapabilityManifest | undefined;
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

  const visit = (manifest: CapabilityManifest): void => {
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

/**
 * Every prerequisite a Worker's composed set declares and does not satisfy — `pithy doctor`'s check.
 *
 * Scoped to the composed set on purpose. Manifests resolve once from the project root, so they describe
 * every capability installed *anywhere* in the project; only this Worker's `pithy.config.ts` says what
 * this Worker is made of. An `audit` another Worker composes must not make this one unhealthy.
 *
 * Reported in the order a manifest declares its peers, so the sentence matches the file.
 */
export function missingPrerequisites(
  manifests: readonly CapabilityManifest[],
  composed: ReadonlySet<string>,
): MissingPrerequisite[] {
  const missing: MissingPrerequisite[] = [];
  for (const manifest of manifests) {
    if (!composed.has(manifest.name)) continue;
    for (const peer of manifest.peerCapabilities) {
      if (!composed.has(peer)) missing.push({ capability: manifest.name, requires: peer });
    }
  }
  return missing;
}

/** `a`, `a and b`, `a, b and c` — for a sentence, never for a command line. */
function andList(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What {@link prerequisiteRefusal} names: the capability asked for, the Worker, and what it lacks. */
export interface PrerequisiteRefusalOptions {
  /** The capability the adopter asked for. */
  capability: string;
  /** The Worker it was to be wired into — the one whose config lacks the peers. */
  worker: string;
  /** The missing prerequisites, deepest first, as {@link prerequisiteClosure} ordered them. */
  missing: readonly string[];
}

/**
 * The refusal a run that cannot ask takes.
 *
 * **It names the commands, in dependency order.** A refusal that says only "auth requires secrets" makes
 * the adopter guess the order, and guessing wrong reproduces the defect one capability along. The flag
 * comes first because it is the one-command answer; the manual sequence is there for whoever wants to
 * decide each one, which is the honest half of composing something nobody asked for.
 */
export function prerequisiteRefusal(options: PrerequisiteRefusalOptions): ValidationError {
  const { capability, worker, missing } = options;
  const commands = missing.map((name) => `pithy add ${name}`);
  const sequence =
    commands.length > 1
      ? `${commands.slice(0, -1).join(", ")}, then ${commands[commands.length - 1]}`
      : commands.join("");
  return new ValidationError({
    message: `${capability} requires ${andList(missing)}, which ${worker} does not compose.`,
    action: `Run pithy add ${capability} --with-prerequisites, or compose ${missing.length === 1 ? "it" : "them"} first: ${sequence}.`,
    detail: `${capability}'s manifest declares peerCapabilities ${JSON.stringify(missing)}; createBackend refuses to assemble without them.`,
  });
}
