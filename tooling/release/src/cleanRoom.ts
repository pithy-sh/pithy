// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a clean room needs to know before it installs anything.
 *
 * ## Why a clean room at all
 *
 * Three defects reached the registry in one day, and **not one of them was visible from inside this
 * repository**:
 *
 * - `workspace:*` published unrewritten, so 20 of 22 packages could not be installed at all. In the
 *   workspace that range resolves perfectly; it is only wrong once it leaves.
 * - `pithy ui add` crashed on the manifest `pithy init` had just written, for any adopter whose
 *   resolver landed below zod 4.4.0. The lockfile here resolves above it.
 * - The `pithy` binary is raw TypeScript behind a `bun` shebang, so it starts only where Bun is.
 *
 * Every gate this repository had ran against the checkout, where a symlink resolves to source, the
 * lockfile pins one version, and Bun is always present. A clean room removes all three assumptions at
 * once: pack what would be published, install it into an empty directory, and drive it the way an
 * adopter would.
 *
 * ## The two dimensions it varies
 *
 * **What is installed** — the tarballs about to be published, not the last ones that were. `npm i
 * ./cli.tgz` resolves `@pithy-sh/core@^0.1.2` from the registry, so without {@link kitOverrides} the
 * gate would test a new CLI against old siblings and pass while the new ones were broken.
 *
 * **Which versions of everything else** — the declared floor, not the resolved one. A range is a
 * promise about every version in it, and `zod: ^4.0.0` promised versions the code could not run on for
 * as long as nobody installed one. {@link thirdPartyFloors} builds the pins that test the promise.
 */

/** A manifest, in the fields a clean room reads. */
export interface CleanRoomManifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** A range that names no installable floor — an alias, a protocol, or a wildcard. */
const NO_FLOOR = /^(\*|latest|npm:|workspace:|file:|link:|git|github:|https?:)/;

/** The leading version of one arm of a range. */
const ARM_FLOOR = /^[\^~>=v\s]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/** Compare two dotted versions numerically, so `0.29.5` sorts above `0.29.0` rather than beside it. */
function lower(a: string, b: string): string {
  const left = a.split(/[.-]/).map(Number);
  const right = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) return a;
    if (l !== r) return l < r ? a : b;
  }
  return a;
}

/**
 * The lowest version a range admits, or `null` when it names none.
 *
 * **An alternation's floor is its lowest arm.** `^6.1.0 || ^7.0.0 || ^8.0.0` promises to work on Vite 6,
 * and 6.1.0 is the version nothing currently installs — which is the whole point of asking.
 */
export function floorOf(range: string): string | null {
  const trimmed = range.trim();
  if (NO_FLOOR.test(trimmed)) return null;

  const floors = trimmed
    .split("||")
    .map((arm) => ARM_FLOOR.exec(arm.trim())?.[1])
    .filter((floor): floor is string => floor !== undefined);

  return floors.length === 0 ? null : floors.reduce(lower);
}

/** Every kit package pointed at its own freshly packed tarball. */
export function kitOverrides(packed: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...packed].map(([name, tarball]) => [name, `file:${tarball}`]));
}

/**
 * Every third-party dependency pinned to the floor its range declares.
 *
 * Kit packages are excluded — {@link kitOverrides} is already rewriting those to tarballs, and two
 * overrides for one name is a fight rather than a policy. `devDependencies` are excluded because a
 * consumer never installs one.
 */
export function thirdPartyFloors(manifests: readonly CleanRoomManifest[]): Record<string, string> {
  const floors = new Map<string, string>();
  for (const manifest of manifests) {
    for (const field of ["dependencies", "peerDependencies"] as const) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith("@pithy-sh/")) continue;
        const floor = floorOf(range);
        if (floor === null) continue;
        const known = floors.get(name);
        floors.set(name, known === undefined ? floor : lower(known, floor));
      }
    }
  }
  return Object.fromEntries([...floors].sort(([a], [b]) => a.localeCompare(b)));
}
