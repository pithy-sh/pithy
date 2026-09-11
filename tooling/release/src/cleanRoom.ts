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
 *
 * ## The third thing it has to remove, and did not
 *
 * **The package manager's own cache is "everything else on disk", and the clean room was sharing the
 * machine's.** `--floors` hung `pithy add secrets` indefinitely — 1h42m and 24m of CI, and locally too —
 * inside `bun add`, which sat with no CPU, no child, no socket, no armed timer, and both its main and
 * HTTP-client threads parked in `epoll_wait` on sets holding nothing but their own wakeup eventfd. That
 * is a deadlock in Bun's installer, not a slow network and not anything the kit does: the same
 * `bun add @pithy-sh/secrets`, run by hand in the same directory with no `pithy` process anywhere, hung
 * 2 runs in 3.
 *
 * What decides whether it hangs is the **state of the shared cache**. Empty: 3 of 3 passed. Already
 * holding these exact manifests: 3 of 3 passed. Half-warm — which is what a machine has after any other
 * install, and exactly what CI has after the plain clean room has just run ahead of the floors one —
 * 2 of 3 hung. Narrowed to the pins that cause it: drop the `@aws-sdk/*` floors and 3 of 3 passed, drop
 * every third-party floor and 3 of 3 passed, keep them and it hangs. `@pithy-sh/cloudflare` pins
 * `@aws-sdk/client-s3` at `3.1111.0`, a version nothing else on the machine has ever resolved, so the
 * floors run is the one that meets a half-warm cache with a graph it has to go and fetch.
 *
 * So {@link cleanRoomEnv} gives the run its own installer cache inside the workspace, thrown away with
 * it. It is the same argument as packing the tarballs: a gate that says *nothing else is on disk* may
 * not quietly keep the one directory that carries every other install this machine has done. Bun's
 * deadlock is Bun's, and it is still there — we stopped standing in front of it.
 *
 * And because a deadlock is exactly the failure a gate cannot report, every command it drives is
 * bounded by {@link STEP_TIMEOUT_MS}: a step that stops making progress fails by name in minutes
 * instead of holding the job until the runner's own limit and saying nothing at all.
 */

import { join } from "node:path";

/**
 * How long any one command the clean room drives may run before the gate calls it stalled.
 *
 * **Generous on purpose, because the number is not a performance budget.** The slowest honest step is
 * `pithy add secrets` at 83 seconds; ten minutes is far above anything the gate legitimately does and
 * far below the runner limit that used to be the only bound there was. It exists to turn *hung* into
 * *failed*, not to police how long an install takes on a cold cache.
 */
export const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The environment every process the clean room drives runs under: its own installer cache, inside the
 * workspace, removed with it.
 *
 * The header explains why. In one sentence: a shared cache is the last piece of "everything else on
 * disk" the clean room was still standing on, and a half-warm one is what deadlocks `bun add` at the
 * declared floors.
 *
 * It is set for the whole run rather than for the floors half, because the plain run has the same right
 * to be hermetic and because the two halves share a machine — the plain run is precisely what leaves the
 * cache half-warm for the floors one.
 */
export function cleanRoomEnv(workspace: string): Record<string, string> {
  return { BUN_INSTALL_CACHE_DIR: join(workspace, "installer-cache") };
}

/**
 * Whether a spawn failed by running out of time rather than by failing.
 *
 * `execFileSync`'s timeout surfaces as `ETIMEDOUT` with a null exit status — no output, no exit code,
 * nothing for {@link stalledStep} to quote. The two outcomes have to be told apart because they say
 * opposite things: a non-zero exit is the kit answering, and this is the kit never answering.
 */
export function isStalledStep(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ETIMEDOUT";
}

/** What a stalled step reports. Names the step, the bound it broke, and where to look — never a guess. */
export function stalledStep(what: string, timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  return [
    `${what} stopped making progress and was killed after ${minutes} minutes.`,
    "It did not fail — it never answered. A package manager deadlocked mid-install is the known shape:",
    "no CPU, no child, no socket, both threads parked in epoll_wait on nothing.",
    "Re-run it by hand with the workspace kept, and check the installer cache this run was given.",
  ].join("\n");
}

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
