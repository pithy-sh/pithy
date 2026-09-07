// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import {
  type CapabilityManifest,
  CONFIG_SEAMS,
  renderCapabilityImport,
  renderCapabilityRegistration,
  renderConfigOptionComment,
  renderConfigOptionLine,
  renderConfigSeamLine,
} from "@pithy-sh/core/src/capability/manifest";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import {
  appendBinding,
  appendDurableObjectMigrations,
  type BindingScope,
  envStanzas,
  type ProposedName,
  type WranglerStanza,
} from "../project/bindingEntries";
import { readOptionalFile } from "../project/readOptionalFile";
import { readWranglerConfig, workerEntryPath, writeWranglerConfig } from "../project/wrangler";
import { optionValue } from "./configConstants";
import { capabilityImportSpecifier, findNamedImport, importOrigin } from "./configImports";
import { type ResolvedSeam, seamNote, seamsFor, writeSeamModule } from "./configSeams";
import { ejectImportPath } from "./eject";
import { durableObjectExports, withDurableObjectExports } from "./entryExports";
import { requiredOptionRefusal } from "./requiredOptions";

/** A config option's value: the JSON scalars a manifest default can be. */
export type ConfigValue = string | number | boolean;

export interface AddCapabilityOptions {
  /**
   * The **Worker's** directory (`apps/<name>`) — where that Worker's `pithy.config.ts` and
   * `wrangler.jsonc` live. Capabilities are per-Worker: the composed route tree, the bindings, and the
   * Durable Object class migrations all attach to one script, so wiring never touches the project root.
   */
  workerDir: string;
  /** The capability's validated manifest (pithy.manifest.json shape). */
  manifest: CapabilityManifest;
  /** Per-option overrides; an unset option renders its manifest default. */
  configValues?: Record<string, ConfigValue>;
  /**
   * The project name, resolved by the caller from the root `pithy.config.ts` (`requireProjectName`) and
   * passed as a plain string. It is the first segment of every name proposed here.
   *
   * **A string, never a loader.** Resolving it in here would mean importing the root config live, and a
   * live import only works under the project root — the wiring tests scaffold into the OS tmpdir, where
   * it fails with an error about the config rather than about the test. The caller already has the
   * config; it hands over the answer.
   *
   * Omitted when no project name could be resolved: nothing is proposed and the entries carry only their
   * binding, which is exactly what `pithy add` wrote before. A guessed prefix would be worse than none —
   * every command that later recomputes the name would compute a different one.
   */
  project?: string;
}

/** What {@link addCapability} wired that the config file itself cannot carry. */
export interface AddCapabilityResult {
  /**
   * The KV namespace titles to give the namespaces this capability needs.
   *
   * **KV is reported rather than written, because wrangler has nowhere to write it.** A `kv_namespaces`
   * entry takes `binding`, `id`, `preview_id`, and `remote` — there is no title field, so the name lives
   * only in the account. D1 is different (`database_name` is a real key) and is written into the file.
   * R2 is deliberately absent from both: `pithy storage provision` and `pithy media provision` write
   * `bucket_name` themselves, and a second writer would collide with them.
   *
   * Empty when no project name was resolved, and empty on a re-run — a binding already present is left
   * exactly as the adopter has it.
   */
  kvNamespaces: ProposedName[];
  /**
   * What this run scaffolded and left unfinished — one line per seam module written.
   *
   * A seam is the one thing `pithy add` writes that is deliberately **not** working code: it is branded
   * unimplemented, and the capability that owns it refuses the Worker's entrypoint until the adopter has
   * replaced it. That is a fact the run has to say out loud, because the config it wrote loads perfectly
   * well and the Worker will not start.
   *
   * Empty when the capability declares no seam, when this run's choices needed none, and on a re-run —
   * which writes nothing at all.
   */
  notes: string[];
}

/** The managed-region marker each Worker's `pithy.config.ts` plants inside `capabilities: [...]`. */
const MARKER = "// pithy:capabilities";

/**
 * Wire a capability into **one Worker** — the pure logic behind `pithy add`. Inserts the import and
 * registration into that Worker's `pithy.config.ts` managed region and appends the manifest's required
 * bindings to every environment of that Worker's `wrangler.jsonc`, comment-preserving. Idempotent: a
 * second run changes nothing. A sibling Worker is never touched.
 */
export async function addCapability(options: AddCapabilityOptions): Promise<AddCapabilityResult> {
  const seams = await updateConfig(options);
  // After the config, and only for the seams that config actually took: a module written beside a
  // registration nothing references is a file the adopter has to delete by hand.
  const notes: string[] = [];
  for (const { seam } of seams) {
    // The note is the *scaffold's* note, so it goes with the write and not with the wiring. A module
    // already on disk is the adopter's, and telling them it is unimplemented would be a guess about code
    // this command deliberately did not read.
    const { written } = await writeSeamModule(options.workerDir, seam);
    if (written) notes.push(seamNote(seam, options.workerDir));
  }
  const kvNamespaces = await updateWrangler(options);
  await updateEntry(options);
  return { kvNamespaces, notes };
}

/**
 * The bindings `pithy add` actually wires into this Worker: the manifest's, minus the optional ones.
 *
 * An `optional` binding is one the capability needs only under a particular config. The manifest is one
 * static file and cannot vary with config, so it declares the union and marks such a binding optional;
 * `pithy add` runs *before* any config exists and has nothing to resolve the flag against, so it writes
 * none of them. `createBackend` reads the same flag to decide whether a missing binding is fatal at
 * assembly, and `pithy upgrade` — which does have the composed set — writes the ones that Worker derives.
 *
 * **One list, read three times**: the `wrangler.jsonc` stanzas, the Durable Object class migration tags,
 * and the entry's exports. They were three separate filters over the same manifest and they did not
 * agree — the tags took every declared binding — so an optional Durable Object would have been registered
 * against the script by a `new_sqlite_classes` tag while nothing bound it and nothing exported it. A tag
 * is applied once and never revisited, so that is not a mistake a later run repairs.
 */
function wiredBindings(manifest: CapabilityManifest): BindingSpec[] {
  return manifest.requiredBindings.filter((binding) => !binding.optional);
}

/**
 * Write the capability's Durable Object exports into the Worker's entry — the other half of a
 * `durable_objects.bindings` entry, and the half `wrangler deploy` refuses the Worker without (#428).
 *
 * Silent, like the class migration tag beside it: there is nothing for the adopter to do about it, and a
 * line of output for every file a command touches is not this CLI's voice. The entry is whatever `main`
 * names, so a Worker that keeps its module somewhere else still gets the export where wrangler looks.
 *
 * Over {@link wiredBindings}, so a class is exported exactly when it is bound.
 */
async function updateEntry({ workerDir, manifest }: AddCapabilityOptions): Promise<void> {
  const exports = durableObjectExports(wiredBindings(manifest));
  if (exports.length === 0) return;

  const path = await workerEntryPath(workerDir);
  const source = path === null ? null : await readOptionalFile(path);
  if (path === null || source === null) {
    const classes = exports.map((entry) => entry.className).join(", ");
    const wrangler = join(workerDir, "wrangler.jsonc");
    // Two faults, two remedies. A config with no `main` has named no file, so there is nothing to
    // restore and the fix is in `wrangler.jsonc`; a `main` whose file is gone is the opposite. The
    // message already said which of the two it was, and one shared action line contradicted half of it.
    throw new InternalError({
      message:
        path === null
          ? `${wrangler} names no main, so this Worker has no entry to export ${classes} from.`
          : `${path} is missing — this Worker's wrangler.jsonc names it as main.`,
      action:
        path === null
          ? `Give ${wrangler} a main naming this Worker's entry, then run pithy add ${manifest.name} again.`
          : `Restore that file, then run pithy add ${manifest.name} again.`,
      detail: `${manifest.name} binds ${classes}, which wrangler resolves against the Worker's entry.`,
    });
  }
  const written = withDurableObjectExports(source, exports);
  if (written !== source) await writeFile(path, written);
}

/** Escape a capability name for use inside a `RegExp` (names are simple, but be safe). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render a capability's registration. With no config options it's a one-liner
 * (`auth(),`); with options it's a block — one commented `key: default` per
 * option — so `pithy.config.ts` documents itself (docs/CLI.md §Config). The mount
 * path and every other knob live here, in the user's surface; the handler stays
 * in the package.
 *
 * Every line of it comes from core's renderers now, the call included. This function used to interpolate
 * `manifest.name` into the call itself, which is how a manifest declaring `audit }) ; evil(` closed the
 * capabilities array and opened a call of its own (#183) — the same defect as the option key #174 closed,
 * one line up.
 */
function renderRegistration(
  manifest: CapabilityManifest,
  configValues: Record<string, ConfigValue>,
  indent: string,
  source: string,
  seams: readonly ResolvedSeam[],
): string {
  const inner = `${indent}  `;
  const optionLines: string[] = [];
  for (const option of manifest.configOptions) {
    // The scaffold's `PUBLIC_ORIGIN` where the option names it and this config declares it, the
    // manifest's literal otherwise, and the adopter's own value over both. See `configConstants.ts`.
    const value = optionValue(option, source, configValues[option.key]);
    // A required option with no value reaching here is a bug one step upstream — `runAdd` refuses before
    // it calls this — so it fails loudly rather than rendering the word `undefined` into somebody's
    // config. `addCapability` is called directly too, and a writer that can be reached from more than
    // one place states its own preconditions.
    if (value === undefined) throw requiredOptionRefusal({ capability: manifest.name, missing: [option] });
    // The same two lines `pithy upgrade` writes, from the same two functions. Two renderers of one line
    // is how `add` and `upgrade` came to disagree about a nested default in the first place (#171), and
    // the comment was still built here and there separately until the manifest text going into it got a
    // rule of its own (#174).
    optionLines.push(renderConfigOptionComment(option.describe, inner));
    optionLines.push(renderConfigOptionLine(option.key, value, inner));
  }
  // The seams the chosen values asked for, last — the callable half of the same call, after every value.
  // Both lines come from core's closed table: nothing a manifest states is written here unquoted, which is
  // the rule an identifier in generated source has followed since #183.
  for (const { seam } of seams) {
    optionLines.push(renderConfigOptionComment(CONFIG_SEAMS[seam].describe, inner));
    optionLines.push(renderConfigSeamLine(seam, inner));
  }
  return renderCapabilityRegistration({ name: manifest.name, indent, optionLines });
}

/**
 * The import statement one seam needs, or nothing when the config already binds that name.
 *
 * Keyed on the binding and checked against the specifier — the same two-step `findNamedImport` exists for
 * one line up, and for the same reason. A `resolveSubject` already imported from the seam module is this
 * command's own previous run, or the adopter's file moved and re-pointed, and either way it is wiring that
 * is already done. A `resolveSubject` bound to **something else** is refused rather than shadowed: writing
 * a second binding of one name gives a config that never loads, and quietly composing theirs would hand a
 * capability a resolver nobody meant it to have.
 */
function seamImport(source: string, seam: ResolvedSeam, capability: string, path: string): string | undefined {
  const { binding, specifier, module } = CONFIG_SEAMS[seam.seam];
  const existing = findNamedImport(source, binding);
  if (existing === undefined) return renderCapabilityImport(binding, specifier);
  if (existing.specifier === specifier) return undefined;
  throw new ConflictError({
    message: `${path} already imports ${binding} from "${existing.specifier}".`,
    action: `Rename that import, then run pithy add ${capability} again.`,
    detail: `${capability} takes ${binding} as its ${seam.option} seam and pithy add writes it to ${module}; wiring it would have composed ${existing.specifier} instead.`,
  });
}

/**
 * Wire one capability into the Worker's `pithy.config.ts`, and report the seams that wiring took.
 *
 * The seams ride with the **registration**, not with the run: they are written when the registration is,
 * and on a re-run — where the registration is already there and is left exactly as the adopter has it —
 * nothing is written and nothing is reported. That is what makes a second `pithy add payments --set
 * billingSubject=organization` cost nothing. The alternative, wiring the seam whenever the run names one,
 * would add an import to a config that already composes payments some other way, and would report a
 * scaffold beside a resolver somebody had finished.
 */
async function updateConfig({ workerDir, manifest, configValues }: AddCapabilityOptions): Promise<ResolvedSeam[]> {
  const path = join(workerDir, "pithy.config.ts");
  let source = await readFile(path, "utf8");

  const markerLine = source.split("\n").find((line) => line.trimStart().startsWith(MARKER));
  if (markerLine === undefined) {
    throw new InternalError({
      message: `${path} has no "${MARKER}" marker.`,
      action: "Restore the managed-region marker inside capabilities: []. Run pithy add again.",
    });
  }

  // Idempotency anchors on the registration *call*, not an exact line: a block form spans several lines,
  // and `auth(` must not match an existing `myauth(`. Read before anything is prepended, because
  // everything below it is conditional on the answer.
  const registered = new RegExp(`^${escapeRegExp(manifest.name)}\\(`);
  const alreadyRegistered = source.split("\n").some((line) => registered.test(line.trim()));

  // The seams this run's chosen values ask for — none on a re-run, which writes nothing at all. See this
  // function's header for why they ride with the registration rather than with the run.
  const seams = alreadyRegistered ? [] : seamsFor(manifest.configOptions, configValues ?? {});
  // Ahead of the capability's own import so the two land in the order a reader expects, and ahead of the
  // write so a seam whose binding is taken leaves the file untouched rather than half-wired.
  for (const seam of seams) {
    const statement = seamImport(source, seam, manifest.name, path);
    if (statement !== undefined) source = `${statement}\n${source}`;
  }

  // Idempotency on the import is keyed on the *binding*, then checked against where it comes from.
  // Keyed on the whole line, an adopter who corrected a specifier by hand — which `pithy add secrets`
  // required, for as long as `@pithy-sh/secrets` shipped no `src/index` — got the original line back
  // on the next run, and two bindings of one name is a redeclaration the config never loads past.
  // Keyed on the binding alone, an adopter's own `auth` suppressed our import while `auth()` still
  // went into the managed region, so the config composed their middleware and said nothing. One is
  // loud and wrong, the other is silent and wrong. So: the name identifies the import, the specifier
  // decides what to do about it, and a name bound to something else is refused before anything is
  // written.
  const existing = findNamedImport(source, manifest.name);
  const origin = existing && importOrigin(existing.specifier, manifest.package, ejectImportPath(manifest.name));
  if (existing === undefined) {
    source = `${renderCapabilityImport(manifest.name, capabilityImportSpecifier(manifest.package))}\n${source}`;
  } else if (origin === "foreign") {
    throw new ConflictError({
      message: `${path} already imports ${manifest.name} from "${existing.specifier}".`,
      action: `Rename that import, then run pithy add ${manifest.name} again.`,
      detail: `Wiring ${manifest.name}() would have composed ${existing.specifier} as the capability.`,
    });
  } else if (origin === "unresolvable") {
    // Ours, and dead: the package exports `./src/*` and no `.`, so this line throws the moment anything
    // loads the config. Accepted as wiring, `add` wrote the registration against an import that could
    // never bind and exited 0. Refused rather than rewritten — the specifier is the adopter's line to
    // correct, and a command that silently repoints imports is one nobody can predict.
    throw new ConflictError({
      message: `${path} imports ${manifest.name} from "${existing.specifier}", which resolves to nothing.`,
      action: `Point that import at "${capabilityImportSpecifier(manifest.package)}", then run pithy add ${manifest.name} again.`,
      detail: `${manifest.package} exports ./src/* only, so the bare specifier has no entry point.`,
    });
  }

  if (!alreadyRegistered) {
    const indent = markerLine.slice(0, markerLine.length - markerLine.trimStart().length);
    const registration = renderRegistration(manifest, configValues ?? {}, indent, source, seams);
    // A replacement function keeps `$` in the registration literal.
    source = source.replace(markerLine, () => `${registration}\n${markerLine}`);
  }

  await writeFile(path, source);
  return seams;
}

/**
 * Append each of a capability's {@link wiredBindings} to one environment's stanza, and report the KV
 * namespace titles the adopter has to create by hand.
 *
 * The entries themselves are `project/bindingEntries.ts`'s — one writer, shared with `pithy upgrade`'s
 * reconcile, so the two commands cannot produce different configs from the same manifest.
 */
function appendBindings(stanza: WranglerStanza, bindings: readonly BindingSpec[], scope: BindingScope): ProposedName[] {
  const proposed: ProposedName[] = [];
  for (const binding of bindings) {
    const write = appendBinding(stanza, binding, scope);
    if (write.outcome === "written" && write.proposed) proposed.push(write.proposed);
  }
  return proposed;
}

async function updateWrangler({ workerDir, manifest, project }: AddCapabilityOptions): Promise<ProposedName[]> {
  const config = (await readWranglerConfig(workerDir)) as WranglerStanza;

  const bindings = wiredBindings(manifest);
  const kvNamespaces: ProposedName[] = [];
  for (const { env, stanza } of envStanzas(config)) {
    kvNamespaces.push(
      ...appendBindings(stanza, bindings, {
        ...(project === undefined ? {} : { project }),
        env,
        capability: manifest.name,
      }),
    );
  }
  // DO class migrations are top-level only — they register the class against the script, not per-env. The
  // same list the stanzas got: a tag registers a class the Worker binds, or it registers nothing.
  appendDurableObjectMigrations(config, bindings);

  await writeWranglerConfig(workerDir, config);
  return kvNamespaces;
}
