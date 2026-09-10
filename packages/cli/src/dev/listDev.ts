// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { buildDevConfig, type DevConfig, devConfigPath, readDevConfig } from "../feature/devConfig";
import { type DevMemberKind, type DevSetOptions, resolveDevSet, selectDevMembers } from "./devSet";

/**
 * **What `pithy dev` would start, without starting it.**
 *
 * `pithy dev` starts an estate you cannot see. `apps/` is only half of it — every composed capability that
 * owns Workflows contributes a host Worker resolved from the composition rather than from a directory — and
 * `pithy worker list` cannot name that half, by design: it is the registry view, and this is the run view.
 *
 * **This module writes nothing, and it is a separate file so it cannot start to.** Ten side effects sit
 * between the top of `startDev` and its first spawn — `.dev.vars` generation, `ensureDevConfig` (which takes
 * the machine-wide port-registry lock), host materialization, stopping the previous session, the orphan
 * sweep, binding every pinned port to verify it, opening `logs/dev.log` (which truncates it merely by being
 * opened), seeding the dev secrets, writing `.dev-state.json`, and the spawn itself. A guard planted above
 * them inside `startDev` would be one moved `await` away from resurrecting one; a module that never imports
 * them cannot regress that way. So this imports `resolveDevSet` and `buildDevConfig` and nothing else.
 *
 * **The ports are projected, never allocated.** `buildDevConfig` is pure, and the call below is the same one
 * `ensureDevConfig` makes on its existing-config branch — so a member added since the last run reports the
 * port the next run pins rather than a guess, and a settled project reports exactly what is on disk. A
 * project that has never run `pithy dev` reports none: assigning one is a run's job, and a listing that
 * invented a port would be claiming an address nothing had reserved.
 */

/** One member of the set as a listing reports it. */
export interface DevListingMember {
  /** The member's name — its deployed name, or a host's capability name. */
  name: string;
  /** `app` for an `apps/` Worker, `host` for a composed capability's host Worker. */
  kind: DevMemberKind;
  /** Whether a plain `pithy dev` starts it — `dev.autostart`, which defaults to true. */
  autostart: boolean;
  /** Whether *this* invocation would start it: the autostart set, or exactly what `--app` named. */
  starts: boolean;
  /** The port it would be pinned to, or `null` when the project has no `.dev.config.json` yet. */
  port: number | null;
  /** The origin its siblings would reach it at, or `null` when no port is pinned. */
  origin: string | null;
}

/** A resolved listing: the whole dev set, marked, plus anything discovery had to survive. */
export interface DevListing {
  /** The project name, or `null` when the project states none — which is why there are no hosts. */
  project: string | null;
  /** Every member, `apps/` Workers in discovery order followed by the hosts. */
  members: DevListingMember[];
  /** Non-fatal lines for the operator. Never part of the machine-readable payload. */
  notes: string[];
}

/** Everything {@link listDevSet} needs, on top of what resolving the set needs. */
export interface ListDevOptions extends DevSetOptions {
  /** The `--app` names, if any. Marks what would start; it never changes what is listed. */
  apps?: readonly string[];
  /** Seam: read `.dev.config.json` (default: {@link readDevConfig} at {@link devConfigPath}). */
  loadDevConfig?: (projectDir: string) => Promise<DevConfig | null>;
}

/** The line a project with no pinned ports gets, so a row of dashes is never left to be interpreted. */
const NO_CONFIG_NOTE = "No .dev.config.json yet, so no port is pinned. The first pithy dev assigns them.";

/**
 * The set a run right now would start, and the port each member would hold.
 *
 * Every member is listed, whether or not this invocation would start it — that is what makes the listing
 * answer *what would that actually give me* rather than echo the flags back. An unknown `--app` name
 * refuses here for the same reason it refuses a run: naming something that does not exist is a mistake
 * worth reporting, not a filter that quietly matches nothing.
 */
export async function listDevSet(options: ListDevOptions): Promise<DevListing> {
  const set = await resolveDevSet(options);
  const named = options.apps ?? [];
  const starting = new Set(
    (named.length > 0 ? selectDevMembers(set.members, named) : set.members.filter((m) => m.autostart)).map(
      (m) => m.worker.name,
    ),
  );

  const load = options.loadDevConfig ?? ((dir: string) => readDevConfig(devConfigPath(dir)));
  const existing = await load(options.projectDir);
  // The full member set, never the selection: this is the same projection `ensureDevConfig` makes, and it
  // is only the port the next run pins because it is computed over everything that run would pin.
  const pinned = existing
    ? buildDevConfig({
        branch: existing.branch,
        block: { block: existing.ports.index, base: existing.ports.base, size: existing.ports.size },
        workers: set.members.map((m) => m.worker),
        previous: existing,
      }).workers
    : {};

  return {
    project: set.project,
    members: set.members.map((member) => {
      const name = member.worker.name;
      return {
        name,
        kind: member.kind,
        autostart: member.autostart,
        starts: starting.has(name),
        port: pinned[name]?.port ?? null,
        origin: pinned[name]?.origin ?? null,
      };
    }),
    notes: [...set.notes, ...(existing ? [] : [NO_CONFIG_NOTE])],
  };
}

/**
 * The listing as name/description rows for {@link formatList} — undimmed, so the caller owns the color.
 *
 * Three facts per row, in the order a reader needs them: which half of the set it came from, whether this
 * run starts it, and where it answers.
 */
export function devListingRows(listing: DevListing): { name: string; description: string }[] {
  return listing.members.map((member) => ({
    name: member.name,
    description: `${member.kind.padEnd(4)}  ${(member.starts ? "starts" : "skipped").padEnd(7)}  port ${member.port ?? "—"}`,
  }));
}
