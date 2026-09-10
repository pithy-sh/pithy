// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";

/**
 * **What the composed capabilities say about which blocks of a `json` secret this project uses.**
 *
 * `pithy secrets create payments-provider-credentials` asks per field (#516), and for a bundle of
 * optional blocks it has to know which blocks are real: the schema knows five payment rails are
 * possible, and only `pithy.config.ts` knows that this project runs two. The capability holds both
 * halves at construction, so it declares the answer on `Capability.secretBranches` and this reads it.
 *
 * **Read, never inferred.** `PaymentsRailToggles.paddle` and `PaymentsProviderCredentials.paddle` are
 * spelled the same, and matching them by name would be right by luck — the same luck #513 ran out of,
 * where two secrets one line apart could not be told apart by convention. A capability that declares
 * nothing gets today's single prompt, which is the fallback and not a guess.
 *
 * **The union across Workers, because there is one value.** Capabilities are per Worker; a secret is
 * per project, and `projectSecretRegistry` already merges every Worker's registry for exactly that
 * reason. A rail configured in one Worker and not another is still a rail this project runs, and the
 * one stored bundle has to carry its credentials — narrowing to the intersection would refuse to write
 * a block that a live Worker reads.
 */
export type SecretBranches = Record<string, readonly string[]>;

/**
 * Every branch declaration the given capabilities carry, merged by secret name.
 *
 * Order follows first declaration, so the prompts read in the order the capability listed its blocks.
 * A name no capability mentions is absent rather than empty — the two mean different things to
 * `secretPromptPlan`, and flattening them would turn *nobody said* into *none apply*.
 */
export function secretBranchDeclarations(capabilities: readonly Capability[]): SecretBranches {
  const merged = new Map<string, string[]>();
  for (const capability of capabilities) {
    for (const [name, branches] of Object.entries(capability.secretBranches ?? {})) {
      const existing = merged.get(name) ?? [];
      merged.set(name, [...existing, ...branches.filter((branch) => !existing.includes(branch))]);
    }
  }
  return Object.fromEntries(merged);
}

/** Merge two resolutions — one Worker's declarations into the project's. See {@link secretBranchDeclarations}. */
export function mergeSecretBranches(into: SecretBranches, from: SecretBranches): SecretBranches {
  const merged: SecretBranches = { ...into };
  for (const [name, branches] of Object.entries(from)) {
    const existing = merged[name] ?? [];
    merged[name] = [...existing, ...branches.filter((branch) => !existing.includes(branch))];
  }
  return merged;
}
