import { InternalError } from "../error/pithyError";
import type { Capability } from "./capability";

/** A logical group bound to one CF binding, holding named items — D1 tables, or KV stores. */
export interface BindingGroup<Item> {
  /** The CF binding this group lives in (a D1 or KV binding name in the Worker env). */
  binding: string;
  /** The named items in this group: table name → schema, or store name → spec. */
  items: Record<string, Item>;
}

/**
 * Adapt a capability's domain map (`databases`, `kvNamespaces`, …) — each entry a `{ binding, … }`
 * spec — into the neutral {@link BindingGroup} shape `composeBindingGroups` consumes, projecting the
 * domain item field (`tables`, `stores`) to `items`. One place to add the next binding type.
 */
export function bindingGroupsFrom<Spec extends { binding: string }, Item>(
  map: Record<string, Spec> | undefined,
  items: (spec: Spec) => Record<string, Item>,
): Record<string, BindingGroup<Item>> | undefined {
  if (!map) return undefined;
  return Object.fromEntries(
    Object.entries(map).map(([name, spec]) => [name, { binding: spec.binding, items: items(spec) }]),
  );
}

/**
 * Merge a binding-backed group that capabilities contribute to — D1 `databases` (items are tables)
 * or KV `kvNamespaces` (items are stores). Capabilities targeting the same group name merge their
 * items (the project-wide contents, per group); a binding mismatch for one name, or an item name
 * claimed twice in one group, is an author conflict caught here at assembly (internal — names are
 * not secret). `groupLabel`/`itemLabel` make the error read in the caller's vocabulary.
 */
export function composeBindingGroups<Item>(
  capabilities: Capability[],
  select: (cap: Capability) => Record<string, BindingGroup<Item>> | undefined,
  groupLabel: string,
  itemLabel: string,
): Record<string, BindingGroup<Item>> {
  const merged: Record<string, BindingGroup<Item>> = {};
  const groupOwner: Record<string, string> = {};
  const itemOwners = new Map<string, Record<string, string>>();

  for (const cap of capabilities) {
    for (const [name, group] of Object.entries(select(cap) ?? {})) {
      let target = merged[name];
      let owners = itemOwners.get(name);
      if (!target || !owners) {
        target = { binding: group.binding, items: {} };
        owners = {};
        merged[name] = target;
        itemOwners.set(name, owners);
        groupOwner[name] = cap.name;
      } else if (target.binding !== group.binding) {
        throw new InternalError({
          message: `${groupLabel} "${name}" is bound to "${target.binding}" by capability "${groupOwner[name]}" but to "${group.binding}" by "${cap.name}".`,
          action: `Use one binding per ${groupLabel} name across capabilities.`,
        });
      }
      for (const [item, value] of Object.entries(group.items)) {
        if (item in target.items) {
          throw new InternalError({
            message: `Duplicate ${itemLabel} "${item}" in ${groupLabel} "${name}": declared by capabilities "${owners[item]}" and "${cap.name}".`,
            action: `Rename one ${itemLabel} — every ${itemLabel} name within a ${groupLabel} must be unique.`,
          });
        }
        target.items[item] = value;
        owners[item] = cap.name;
      }
    }
  }
  return merged;
}
