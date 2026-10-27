// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { writeFile } from "node:fs/promises";
import { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import {
  PRESENCE_ROOM_CLASS,
  PRESENCE_ROOM_MODULE,
  PRESENCE_ROOMS_BINDING,
  PRESENCE_ROOMS_BINDING_SPEC,
} from "@pithy-sh/core/src/presence/declaration";
import { readOptionalFile } from "../project/readOptionalFile";
import { workerEntryPath } from "../project/wrangler";
import { withoutDurableObjectExports } from "./entryExports";
import { removeFromWrangler } from "./remove";

/**
 * **Presence rooms, taken back out of a Worker that no longer declares one** (#815).
 *
 * The way in needs nothing here: a capability that declares room kinds requires the `PRESENCE_ROOMS` Durable
 * Object binding, so `pithy add` and `pithy upgrade` write its stanza, its class migration tag and its entry
 * export through the Durable Object path every other binding takes (#428), and `pithy remove` takes them out
 * with the capability unless another one still declares rooms.
 *
 * The way out had one gap, and it is this module. When the *last* declaration goes some other way — an
 * adopter deletes the `presence` block from their own `app` capability, or configures a capability's rooms
 * off — nothing is removed, so the Worker keeps exporting and binding a class that nothing it composes uses.
 * `pithy upgrade` closes it: a Worker that binds the room's class while no environment's composition
 * requires it has all three halves taken out.
 *
 * **Decided across every environment, because removing is.** The binding comes out of every `env.<name>`
 * and the class is retired for the whole script, while a config may compose a different registry for each
 * environment (#595). So the upgrade's own composition is not enough: each other environment the Worker
 * declares is composed too, and any one that declares a room keeps all three halves.
 *
 * **The class is retired, never spliced out of history.** A Worker that deployed with the room holds its
 * creation tag and has instances, and Cloudflare refuses an upload that stops exporting their class unless
 * a `deleted_classes` migration retires it. So a `deleted_classes` step is appended under a tag of its own.
 * Safe where it would not be for an arbitrary Durable Object, because a room writes nothing to storage:
 * deleting the class deletes no data. That is why this is presence's rule and not a general one.
 */

/** The room's binding, normalized as a composed capability carries it. */
const ROOM_BINDING = BindingSpec.parse(PRESENCE_ROOMS_BINDING_SPEC);

/** Whether any composed capability requires the room's binding — the runtime instances, which know their config. */
export function presenceRoomsRequired(capabilities: readonly { requiredBindings: readonly BindingSpec[] }[]): boolean {
  return capabilities.some((capability) =>
    capability.requiredBindings.some(
      (binding) => binding.type === "durable_object" && binding.name === PRESENCE_ROOMS_BINDING,
    ),
  );
}

/**
 * The room's binding out of a list, for the one declaration with no manifest: the adopter's own `app`. Its
 * other Durable Object classes live in its own `main` and are its own to export; this one lives in core, so
 * `pithy upgrade` writes its export exactly as it does for a kit capability's class.
 */
export function presenceRoomBindings(bindings: readonly BindingSpec[]): BindingSpec[] {
  return bindings.filter((binding) => binding.type === "durable_object" && binding.name === PRESENCE_ROOMS_BINDING);
}

/**
 * Whether a Worker binds the room while **no environment** composes a capability that requires it.
 * `capabilities` is the composition for `env`, already in hand; every other environment the stanzas name is
 * composed with `compose`. One that cannot be composed counts as requiring the room: nothing is removed on a
 * guess.
 */
export async function presenceRoomsStray(
  stanzas: readonly { env: string; stanza: unknown }[],
  env: string,
  capabilities: readonly { requiredBindings: readonly BindingSpec[] }[],
  compose: (env: string) => Promise<readonly { requiredBindings: readonly BindingSpec[] }[]>,
): Promise<boolean> {
  if (!bindsPresenceRooms(stanzas) || presenceRoomsRequired(capabilities)) return false;
  for (const other of new Set(stanzas.map((stanza) => stanza.env))) {
    if (other === env) continue;
    try {
      if (presenceRoomsRequired(await compose(other))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** One environment's stanza, as far as this module reads it. */
interface DurableObjectStanza {
  durable_objects?: { bindings?: { name?: string; class_name?: string }[] };
}

/** Whether any environment of a Worker binds the room's class under the room's binding. */
export function bindsPresenceRooms(stanzas: readonly { stanza: unknown }[]): boolean {
  return stanzas.some(({ stanza }) =>
    ((stanza as DurableObjectStanza).durable_objects?.bindings ?? []).some(
      (entry) => entry.name === PRESENCE_ROOMS_BINDING && entry.class_name === PRESENCE_ROOM_CLASS,
    ),
  );
}

/**
 * Take the room's binding out of every environment, retire its class with a `deleted_classes` step, and take
 * its export out of the Worker's entry — only the export pointing at core's own module, never one the adopter
 * wrote. Returns whether anything changed.
 */
export async function retirePresenceRooms(workerDir: string): Promise<boolean> {
  const removed = await removeFromWrangler(workerDir, { requiredBindings: [ROOM_BINDING] }, []);
  const path = await workerEntryPath(workerDir);
  const source = path === null ? null : await readOptionalFile(path);
  if (path === null || source === null) return removed.length > 0;
  const written = withoutDurableObjectExports(
    source,
    [{ className: PRESENCE_ROOM_CLASS, module: PRESENCE_ROOM_MODULE }],
    (specifier) => specifier === PRESENCE_ROOM_MODULE,
  );
  if (written !== source) await writeFile(path, written);
  return removed.length > 0 || written !== source;
}
