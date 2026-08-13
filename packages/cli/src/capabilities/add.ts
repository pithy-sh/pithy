// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CapabilityManifest,
  renderCapabilityImport,
  renderCapabilityRegistration,
  renderConfigOptionComment,
  renderConfigOptionLine,
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
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { optionValue } from "./configConstants";
import { capabilityImportSpecifier, findNamedImport, importOrigin } from "./configImports";
import { ejectImportPath } from "./eject";

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
  await updateConfig(options);
  return { kvNamespaces: await updateWrangler(options) };
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
): string {
  const inner = `${indent}  `;
  const optionLines: string[] = [];
  for (const option of manifest.configOptions) {
    // The scaffold's `PUBLIC_ORIGIN` where the option names it and this config declares it, the
    // manifest's literal otherwise, and the adopter's own value over both. See `configConstants.ts`.
    const value = optionValue(option, source, configValues[option.key]);
    // The same two lines `pithy upgrade` writes, from the same two functions. Two renderers of one line
    // is how `add` and `upgrade` came to disagree about a nested default in the first place (#171), and
    // the comment was still built here and there separately until the manifest text going into it got a
    // rule of its own (#174).
    optionLines.push(renderConfigOptionComment(option.describe, inner));
    optionLines.push(renderConfigOptionLine(option.key, value, inner));
  }
  return renderCapabilityRegistration({ name: manifest.name, indent, optionLines });
}

async function updateConfig({ workerDir, manifest, configValues }: AddCapabilityOptions): Promise<void> {
  const path = join(workerDir, "pithy.config.ts");
  let source = await readFile(path, "utf8");

  const markerLine = source.split("\n").find((line) => line.trimStart().startsWith(MARKER));
  if (markerLine === undefined) {
    throw new InternalError({
      message: `${path} has no "${MARKER}" marker.`,
      action: "Restore the managed-region marker inside capabilities: []. Run pithy add again.",
    });
  }

  const lines = source.split("\n");
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

  // Idempotency anchors on the registration *call*, not an exact line: a block
  // form spans several lines, and `auth(` must not match an existing `myauth(`.
  const registered = new RegExp(`^${escapeRegExp(manifest.name)}\\(`);
  if (!lines.some((line) => registered.test(line.trim()))) {
    const indent = markerLine.slice(0, markerLine.length - markerLine.trimStart().length);
    const registration = renderRegistration(manifest, configValues ?? {}, indent, source);
    // A replacement function keeps `$` in the registration literal.
    source = source.replace(markerLine, () => `${registration}\n${markerLine}`);
  }

  await writeFile(path, source);
}

/**
 * Append every binding a capability's manifest requires to one environment's stanza, and report the KV
 * namespace titles the adopter has to create by hand.
 *
 * The entries themselves are `project/bindingEntries.ts`'s — one writer, shared with `pithy upgrade`'s
 * reconcile, so the two commands cannot produce different configs from the same manifest.
 */
function appendBindings(stanza: WranglerStanza, manifest: CapabilityManifest, scope: BindingScope): ProposedName[] {
  const proposed: ProposedName[] = [];
  for (const binding of manifest.requiredBindings) {
    // An `optional` binding is one the capability only needs under a particular config — the seam's
    // `CONTROL_PLANE` KV, which nothing reads under the default `d1` replay backend. The manifest is one
    // static file and cannot vary with config, so it declares the union and marks such a binding
    // optional; writing it anyway would make every project provision and bind a namespace no code path
    // in the tree ever reads, and re-add it the moment an adopter deleted it. `createBackend` reads the
    // same flag to decide whether a missing binding is fatal at assembly.
    if (binding.optional) continue;
    const write = appendBinding(stanza, binding, scope);
    if (write.outcome === "written" && write.proposed) proposed.push(write.proposed);
  }
  return proposed;
}

async function updateWrangler({ workerDir, manifest, project }: AddCapabilityOptions): Promise<ProposedName[]> {
  const config = (await readWranglerConfig(workerDir)) as WranglerStanza;

  const kvNamespaces: ProposedName[] = [];
  for (const { env, stanza } of envStanzas(config)) {
    kvNamespaces.push(
      ...appendBindings(stanza, manifest, {
        ...(project === undefined ? {} : { project }),
        env,
        capability: manifest.name,
      }),
    );
  }
  // DO class migrations are top-level only — they register the class against the script, not per-env.
  appendDurableObjectMigrations(config, manifest.requiredBindings);

  await writeWranglerConfig(workerDir, config);
  return kvNamespaces;
}
