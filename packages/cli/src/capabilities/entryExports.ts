// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { exportsName, findNamedBinding, namedReexports, withoutBinding } from "./configImports";

/**
 * **A Durable Object binding is two halves, and this is the one that lives in the adopter's code.**
 *
 * `pithy add` writes the config half — a `durable_objects.bindings` entry naming a `class_name`, and a
 * `new_sqlite_classes` migration tag registering that class against the script. Neither says where the
 * class *is*. wrangler resolves `class_name` against the module `main` names, and refuses the deploy
 * when nothing there exports it:
 *
 *     Your Worker depends on the following Durable Objects, which are not exported in your entrypoint
 *     file: MultiplayerSession.
 *
 * The scaffolded entry is `export default createEntrypoint(config);` and nothing else — `createEntrypoint`
 * returns a value, and a value cannot add a named export to the module holding it. So the export was left
 * to a human whose only prompt was a line of manifest prose, and `pithy add multiplayer` produced a
 * project that did not deploy (#428).
 *
 * The class and the module it comes from are both the capability's to state (`BindingSpec.className` and
 * `BindingSpec.classModule`), so the line is derived rather than known here: nothing in this file names a
 * capability, a class, or a package.
 *
 * **Idempotent, and keyed on the name.** An export the adopter wrote themselves satisfies wrangler
 * exactly as ours does, and a second statement exporting the same name is a duplicate export the build
 * refuses — so a class already on the module is left alone, whoever put it there, in any spelling that
 * survives to runtime. Taking one *out* asks the second question the specifier answers: only an export
 * pointing at the capability's own code is ours to remove — its package, or the `capabilities/<cap>` fork
 * `--eject` repoints it into — which is the rule `pithy remove` reads a config's imports by, and is the
 * caller's to answer rather than this file's.
 */

/** One Durable Object class an entry has to export, and the module it comes from. */
export interface DurableObjectExport {
  /** The exported class — what `class_name` in `wrangler.jsonc` resolves against the entry. */
  readonly className: string;
  /** The module specifier the class is exported from, verbatim from the binding's `classModule`. */
  readonly module: string;
}

/**
 * The note the written block sits under, so the next person to open the entry knows what the lines are
 * and why deleting one breaks a deploy rather than a feature.
 */
const NOTE = "// Durable Object classes this Worker binds. wrangler resolves each class_name against this module.";

/**
 * Every Durable Object export a set of bindings calls for, in declaration order, one line per class.
 *
 * Keyed on the binding **kind**, never on the presence of a `className`: a `workflow` binding carries one
 * too, and its class runs in the capability's own host Worker rather than in the adopter's entry. A
 * capability declaring two bindings backed by one class (a second namespace over the same actor) gets one
 * export — two would be a duplicate the build refuses.
 */
export function durableObjectExports(bindings: readonly BindingSpec[]): DurableObjectExport[] {
  const found = new Map<string, DurableObjectExport>();
  for (const binding of bindings) {
    if (binding.type !== "durable_object") continue;
    if (binding.className === undefined || binding.classModule === undefined) continue;
    if (!found.has(binding.className)) {
      found.set(binding.className, { className: binding.className, module: binding.classModule });
    }
  }
  return [...found.values()];
}

/** The statement itself — the one place this line is spelled. */
function render(entry: DurableObjectExport): string {
  return `export { ${entry.className} } from "${entry.module}";`;
}

/**
 * Whether the module already puts this class on itself, in any spelling that survives to runtime.
 *
 * Every spelling, not only the one this file writes. It used to ask `findNamedBinding` — which reads
 * `export { X } from "…"` and nothing else — so an adopter who declared their own `export class
 * MultiplayerSession {}` in the entry got ours appended beside it, and a duplicate export the build
 * refuses before wrangler is ever asked.
 */
function alreadyExported(source: string, entry: DurableObjectExport): boolean {
  return exportsName(source, entry.className);
}

/**
 * The source with every missing Durable Object export appended.
 *
 * Appended rather than inserted: an entry is the adopter's file, and the end of it is the one position
 * that cannot land inside something they wrote. The block reads as one because the note is written once
 * — a second capability's class joins under the same one.
 */
export function withDurableObjectExports(source: string, exports: readonly DurableObjectExport[]): string {
  // Deduplicated by class name on the way in, not only by {@link durableObjectExports} on the way out.
  // That one dedupes within a capability; `pithy upgrade` hands this every composed capability's classes
  // at once, and two statements exporting one name is the duplicate export this whole function avoids.
  const byName = new Map<string, DurableObjectExport>();
  for (const entry of exports) if (!byName.has(entry.className)) byName.set(entry.className, entry);
  const missing = [...byName.values()].filter((entry) => !alreadyExported(source, entry));
  if (missing.length === 0) return source;

  const body = source.endsWith("\n") || source === "" ? source : `${source}\n`;
  // The blank line and the note open the block, once. A later capability's class appends straight onto
  // the last line of it, so the block stays contiguous — which is what lets `remove` tell a note with
  // something still under it from a note with nothing.
  const note = body.includes(NOTE) ? "" : `\n${NOTE}\n`;
  return `${body}${note}${missing.map(render).join("\n")}\n`;
}

/**
 * The source with the Durable Object exports **this capability's modules** put there taken out — the
 * inverse `pithy remove` needs, since a re-export of a package about to be uninstalled is a Worker that
 * no longer builds.
 *
 * An export of the same class from somewhere else is the adopter's: the name identifies the statement and
 * the specifier decides what to do about it, exactly as `remove` reads an import. The note goes when the
 * last of our lines does, so an entry that never had a Durable Object is byte-identical to how it started.
 *
 * **`ours` is the caller's question, not this file's.** The line `pithy add` writes points at the
 * capability's package and the one `pithy add --eject` leaves points into `capabilities/<cap>`, and both
 * are the capability's — a fact about how a capability is wired, which `capabilities/remove.ts` already
 * answers for the config's import through `isCapabilityImport`. Nothing here names a capability, so it
 * takes the predicate rather than growing a second answer.
 */
export function withoutDurableObjectExports(
  source: string,
  exports: readonly DurableObjectExport[],
  ours: (specifier: string) => boolean,
): string {
  let rest = source;
  for (const entry of exports) {
    for (;;) {
      const found = findNamedBinding(rest, entry.className, "export");
      if (!found || !ours(found.specifier)) break;
      const next = withoutBinding(rest, found);
      if (next === rest) break; // nothing was taken out; never spin on it
      rest = next;
    }
  }
  if (!rest.includes(NOTE)) return rest;

  // The note with none of the block left under it. **What counts as "under it" is a re-export and
  // nothing else.** A sibling capability's class keeps the note; anything else does not. This asked
  // whether the next line was *blank*, which reads the block as the last thing in the file — and the
  // block is appended at the end, so a line written after it is the expected case: multiplayer's own
  // scaffold step tells the adopter to call `registerGameModel(myGame)` in the entry. With one there,
  // `pithy remove` left the note standing over code it has nothing to do with.
  //
  // Decided by the same scanner every other reader in this pair uses, so a commented-out export under
  // the note is not an export — the fact `withDurableObjectExports` already turns on.
  const lines = rest.split("\n");
  const at = lines.findIndex((line) => line.trim() === NOTE);
  if (at === -1) return rest;
  const under = lines.slice(0, at + 1).reduce((offset, line) => offset + line.length + 1, 0);
  if (namedReexports(rest).some((found) => found.start === under)) return rest;
  // Its own line goes, and the blank line that separated the block from the entry above it — otherwise
  // `remove` leaves a trailing gap `add` never wrote.
  lines.splice(at, 1);
  if ((lines[at - 1] ?? "").trim() === "") lines.splice(at - 1, 1);
  return lines.join("\n");
}
