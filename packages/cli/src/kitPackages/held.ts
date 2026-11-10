// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PackageHeld } from "./plan";
import { breakingBoundary, parseRange } from "./ranges";

/**
 * What `pithy upgrade --packages` says about each release it held back: the package, the newest version, the
 * one installed, why, and the command that takes it.
 */

/** Why one entry was held, as a sentence. */
function heldWhy(entry: PackageHeld): string {
  if (entry.reason === "outside-range") return `Outside the declared range ${entry.range}.`;
  const floor = parseRange(entry.range)?.floor ?? entry.installed ?? entry.latest;
  const boundary = breakingBoundary(floor, entry.latest);
  return boundary === "minor"
    ? "A new 0.x minor crosses a breaking boundary."
    : boundary === "major"
      ? "A new major crosses a breaking boundary."
      : "Crosses a breaking boundary.";
}

/** One line per package held the same way: same newest version, same reason, same version installed. */
export function heldLines(held: readonly PackageHeld[]): string[] {
  const groups = new Map<string, PackageHeld>();
  for (const entry of held) {
    const key = `${entry.name}\0${entry.latest}\0${entry.reason}\0${entry.installed ?? ""}`;
    if (!groups.has(key)) groups.set(key, entry);
  }
  return [...groups.values()].map((entry) => {
    const installed = entry.installed === null ? "nothing installed" : `${entry.installed} installed`;
    return `${entry.name}  ${entry.latest} held, ${installed}. ${heldWhy(entry)} Run ${entry.command}.`;
  });
}

/** The closing line naming every package held and the command that takes them, or `null` when none was. */
export function heldSummary(held: readonly PackageHeld[]): string | null {
  const [first] = held;
  if (!first) return null;
  const named = [...new Set(held.map((entry) => `${entry.name} ${entry.latest}`))];
  return `Held back: ${named.join(", ")}. Run ${first.command} to take ${named.length === 1 ? "it" : "them"}.`;
}
