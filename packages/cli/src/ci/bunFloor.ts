// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { olderThan } from "../nodeFloor";

/**
 * **The Bun this repository is built with, checked before it is used (#784).**
 *
 * Bun does not enforce `engines.bun`, and the workspace's `typecheck` scripts run `bun check`, which
 * arrived in 1.4.3. On anything older, `bun check` is read as `bun run check`: twenty-seven workspaces
 * each answer `Script not found "check"`, and nothing names a version. So the root `typecheck` runs this
 * first, through `scripts/bunFloor.ts`, and an old Bun is told what it is and what to run.
 *
 * `bunPins.test.ts` holds CI to the pin. This holds a contributor's machine to the floor.
 *
 * @param running - `Bun.version`.
 * @param range - The root manifest's `engines.bun`, which states the floor as `>=x.y.z` and nothing else.
 * @returns The refusal to print, or `null` when the running Bun is at or above the floor.
 */
export function bunFloorRefusal(running: string, range: string): string | null {
  const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!floor) throw new Error(`Cannot read a Bun floor from engines.bun "${range}"; expected >=x.y.z.`);
  // A canary or prerelease carries a suffix after the patch; the release it is built toward is what counts.
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(running);
  if (!version) throw new Error(`Cannot read the running Bun version "${running}".`);
  if (!olderThan(version.slice(1).map(Number), floor.slice(1).map(Number))) return null;
  return `Bun ${running} is older than this repository needs (${range}). Run \`bun upgrade\`, then this again.`;
}
