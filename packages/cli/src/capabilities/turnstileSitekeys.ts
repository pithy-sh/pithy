// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { isTurnstileCapability, type TurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import type { TurnstileMode, TurnstileSitekeys } from "@pithy-sh/turnstile/src/config/config";
import {
  environmentsWithoutSitekeys,
  type PlannedSitekeys,
} from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { allCapabilities, loadWorkerConfig, type WorkerConfig } from "../project/config";
import { locateRegistration, type ObjectProperty, objectProperties } from "./reconcile";

/**
 * **The one writer of a Turnstile sitekey, and it writes the input the build reads (#590).**
 *
 * A sitekey reaches a browser one way: the `pithy()` Vite plugin imports the Worker's `pithy.config.ts`,
 * asks the turnstile capability for its client projection, and inlines the answer into the bundle. The
 * projection reads `widgets.<mode>.sitekeys.<environment>`. So that is where `pithy turnstile provision`
 * writes — not a Worker var, which a bundle that is already built can never see, and which is where the
 * sitekeys went from #53 until this.
 *
 * ## How it writes
 *
 * **String literals, in place, and nothing else.** The registration is located by the same scanner
 * `pithy upgrade` reads a registration's keys with ({@link locateRegistration}, {@link objectProperties}),
 * walked down `widgets` → mode → `sitekeys` → environment, and a value is replaced only when it is a string
 * literal. An adopter's expression — the dashboard writes `dev: testSitekey("visible")` — is never
 * flattened: when it already resolves to the value it is left alone, and when it does not the run is refused
 * naming the key, before a byte is written.
 *
 * ## How it knows it worked
 *
 * **By loading the config back through the real loader and reading what the capability resolved.** A text
 * edit that lands in the wrong place — a second `turnstile(` the locator matched inside a template literal,
 * a sibling key of the same name — reads as a success to anything that looks at the text. Only the
 * capability's own parse says whether the producer and the consumer meet. A read-back that disagrees
 * restores the file byte for byte and refuses.
 *
 * ## How a run refuses before it has done anything
 *
 * {@link assertTurnstileSitekeysWritable} asks every question the writer refuses on, and writes nothing. It is
 * the same planning step the writer runs, so the two cannot disagree, and `pithy turnstile provision` asks it
 * before a widget or a secret exists (#590 review). A production sitekey Cloudflare has not issued yet is
 * planned as `null`: only a string literal can take it.
 *
 * ## What it does not see
 *
 * The read-back composes the config once, under whatever `ENVIRONMENT` this process has. A config that
 * computes a sitekey from `compositionEnvironment()` is checked in that one environment only.
 */

/**
 * **Every environment this project builds a front end for that no sitekey can reach** — so a surface can
 * say so rather than leave a bundle to answer `enabled: false` in silence.
 *
 * The builds are the ones the CLI makes: `dev` locally, each environment the root config declares under
 * `pithy deploy --env`, and a feature build under `pithy feature`, which `uiBuildEnvironment` stamps
 * `ENVIRONMENT=feature`. `TurnstileSitekeys` has a slot for four of those names, so a **declared** name
 * beyond them — `live`, say — renders no widget and the gate on sign-in fails closed there. Nothing
 * provisions it: a test key is accepted only where one belongs, and the one real widget is prod's.
 *
 * A feature build is no longer one of them (#656). It has a slot, it is left empty on purpose, and the
 * capability resolves Cloudflare's always-pass test key for it — which is what lets anybody sign in to a
 * branch deployment at all. `feature` stays in the list handed over, because the question is asked of the
 * schema and the answer has to come from there rather than from this line.
 *
 * The one list `pithy turnstile provision` reports and `pithy doctor` reads, and the one
 * `turnstileBundle.test.ts` holds against real builds.
 */
export function environmentsBuiltWithoutSitekeys(declared: readonly string[]): string[] {
  return environmentsWithoutSitekeys([LOCAL_ENVIRONMENT, ...declared, FEATURE_ENVIRONMENT]);
}

/** Every environment's sitekey per widget mode — only the ones a caller means to write. */
export type SitekeyWrites = Partial<Record<TurnstileMode, Partial<TurnstileSitekeys>>>;

/** Options for {@link assertTurnstileSitekeysWritable}. */
export interface AssertTurnstileSitekeysWritableOptions {
  /** The Worker whose `pithy.config.ts` composes turnstile — the `--worker` target, and no other. */
  workerDir: string;
  /** The values a run is about to write. `null` is a production sitekey not issued yet. */
  sitekeys: PlannedSitekeys;
  /** How the config is read. Defaults to a fresh `loadWorkerConfig`. */
  loadConfig?: (workerDir: string) => Promise<WorkerConfig>;
}

/** Options for {@link writeTurnstileSitekeys}. */
export interface WriteTurnstileSitekeysOptions {
  /** The Worker whose `pithy.config.ts` composes turnstile — the `--worker` target, and no other. */
  workerDir: string;
  /** The values to write. */
  sitekeys: SitekeyWrites;
  /**
   * How the config is read back. Defaults to a **fresh** `loadWorkerConfig` — the module cache would hand
   * back the file as it was before this process wrote it, and the check would compare the old file to itself.
   */
  loadConfig?: (workerDir: string) => Promise<WorkerConfig>;
}

/** What {@link writeTurnstileSitekeys} did. */
export interface WrittenSitekeys {
  /** The `pithy.config.ts` it wrote, or would have. */
  path: string;
  /** Whether a byte changed. False on a re-run over its own output. */
  changed: boolean;
}

/** One sitekey to write, addressed the way an operator reads it: `widgets.visible.sitekeys.staging`. */
interface SitekeyEdit {
  mode: TurnstileMode;
  environment: keyof TurnstileSitekeys;
  /** The value, or `null` for a production sitekey Cloudflare has not issued yet. */
  value: string | null;
}

/** The dotted path of an edit, for a sentence. */
function keyPath(edit: SitekeyEdit): string {
  return `widgets.${edit.mode}.sitekeys.${edit.environment}`;
}

/** Flatten the nested request into one edit per mode and environment. */
function editsOf(sitekeys: PlannedSitekeys): SitekeyEdit[] {
  const edits: SitekeyEdit[] = [];
  const byMode = Object.entries(sitekeys) as [TurnstileMode, Partial<Record<keyof TurnstileSitekeys, string | null>>][];
  for (const [mode, byEnvironment] of byMode) {
    for (const [environment, value] of Object.entries(byEnvironment) as [keyof TurnstileSitekeys, string | null][]) {
      edits.push({ mode, environment, value });
    }
  }
  return edits;
}

/** The turnstile capability a loaded config composes, or `undefined`. */
function turnstileOf(config: WorkerConfig): TurnstileCapability | undefined {
  return allCapabilities(config).find(isTurnstileCapability);
}

/** What the capability resolved for one edit's key. */
function resolvedValue(capability: TurnstileCapability | undefined, edit: SitekeyEdit): string | undefined {
  return capability?.turnstileConfig.widgets[edit.mode]?.sitekeys[edit.environment];
}

/** The object literal a property's value opens, as brace offsets — or `null` when the value is not one. */
function objectValue(source: string, property: ObjectProperty | undefined): { open: number; close: number } | null {
  if (property === undefined || source[property.valueStart] !== "{") return null;
  const close = property.valueEnd - 1;
  return source[close] === "}" ? { open: property.valueStart, close } : null;
}

/**
 * The span of one edit's value in the source, walked down from the registration — or `null` when some step
 * of the path is not an object literal this can read.
 */
function locateValue(source: string, edit: SitekeyEdit): ObjectProperty | null {
  const registration = locateRegistration(source, "turnstile");
  if (registration === null || registration.form !== "block") return null;
  let object: { open: number; close: number } | null = {
    open: registration.openIndex,
    close: registration.closeIndex,
  };
  for (const key of ["widgets", edit.mode, "sitekeys"]) {
    if (object === null) return null;
    const property = objectProperties(source, object.open, object.close).find((found) => found.key === key);
    object = objectValue(source, property);
  }
  if (object === null) return null;
  return objectProperties(source, object.open, object.close).find((found) => found.key === edit.environment) ?? null;
}

/**
 * Whether a value's source is a plain string literal — `"…"`, `'…'`, or a template with no substitution —
 * and so a thing this may replace. Anything else is the adopter's expression.
 */
function isStringLiteral(text: string): boolean {
  return /^"(?:[^"\\\n]|\\.)*"$/.test(text) || /^'(?:[^'\\\n]|\\.)*'$/.test(text) || /^`[^`$\\]*`$/.test(text);
}

/** The refusal for keys this cannot write — named, with the value each one needs. */
function unwritable(path: string, edits: readonly SitekeyEdit[], why: string): ValidationError {
  const lines = edits.map(
    (edit) => `${keyPath(edit)}: ${edit.value === null ? "a string literal" : JSON.stringify(edit.value)}`,
  );
  return new ValidationError({
    message: `Could not write ${edits.map(keyPath).join(", ")} in ${path}. ${why}`,
    action: `Set ${lines.join(", ")} in the turnstile({ ... }) registration by hand, then run the command again. Only string literals are written.`,
  });
}

/** What the planning step settled: the file as read, and the literal spans to replace. */
interface SitekeyPlan {
  path: string;
  original: string;
  spans: { edit: SitekeyEdit; span: ObjectProperty }[];
}

/**
 * **Every refusal the writer can make, decided from the source and the loaded config, with nothing written.**
 * The one planning step both {@link assertTurnstileSitekeysWritable} and {@link writeTurnstileSitekeys} run, so
 * a check that passes is a write that will not refuse on these grounds.
 *
 * An edit is pending unless the config already resolves to its value; a `null` value is always pending,
 * because nothing can already resolve to a sitekey nobody has.
 */
async function planSitekeys(
  workerDir: string,
  sitekeys: PlannedSitekeys,
  load: (workerDir: string) => Promise<WorkerConfig>,
): Promise<SitekeyPlan> {
  const path = join(workerDir, "pithy.config.ts");
  const original = await readFile(path, "utf8");
  const edits = editsOf(sitekeys);

  // What the config says before anything is touched — so an expression that already says the right thing
  // is left alone, and a re-run over this writer's own output is a no-op.
  const before = turnstileOf(await load(workerDir));
  if (before === undefined) {
    throw new ValidationError({
      message: `${path} does not compose turnstile.`,
      action:
        "Add `turnstile({ ... })` to this Worker's pithy.config.ts (run `pithy add turnstile`), or pass --worker.",
    });
  }
  const pending = edits.filter((edit) => edit.value === null || resolvedValue(before, edit) !== edit.value);
  if (pending.length === 0) return { path, original, spans: [] };

  const registration = locateRegistration(original, "turnstile");
  if (registration === null || registration.form !== "block") {
    throw unwritable(
      path,
      pending,
      "No `turnstile({ ... })` registration opens a line of it. Put the call on its own line.",
    );
  }
  const spans: { edit: SitekeyEdit; span: ObjectProperty }[] = [];
  const missing: SitekeyEdit[] = [];
  const expressions: SitekeyEdit[] = [];
  for (const edit of pending) {
    const span = locateValue(original, edit);
    if (span === null) missing.push(edit);
    else if (!isStringLiteral(original.slice(span.valueStart, span.valueEnd))) expressions.push(edit);
    else spans.push({ edit, span });
  }
  if (missing.length > 0) {
    throw unwritable(path, missing, "The registration has no such key as an object literal.");
  }
  if (expressions.length > 0) {
    throw unwritable(path, expressions, "Each is an expression that resolves to something else.");
  }
  return { path, original, spans };
}

/**
 * Refuse exactly when {@link writeTurnstileSitekeys} would refuse on the source, and write nothing — so a
 * command can ask before it creates a widget or stores a secret the refusal would strand.
 */
export async function assertTurnstileSitekeysWritable(options: AssertTurnstileSitekeysWritableOptions): Promise<void> {
  await planSitekeys(options.workerDir, options.sitekeys, options.loadConfig ?? freshLoad);
}

/** The default config read: fresh, because the module cache would hand back the file as it was. */
function freshLoad(workerDir: string): Promise<WorkerConfig> {
  return loadWorkerConfig(workerDir, { fresh: true });
}

/**
 * Write each requested sitekey into the Worker's `turnstile(...)` registration, and prove the capability
 * now resolves exactly those values. All or nothing: a key it cannot write refuses the run before the file
 * is touched, and a read-back that disagrees puts the file back.
 */
export async function writeTurnstileSitekeys(options: WriteTurnstileSitekeysOptions): Promise<WrittenSitekeys> {
  const load = options.loadConfig ?? freshLoad;
  const { path, original, spans } = await planSitekeys(options.workerDir, options.sitekeys, load);
  if (spans.length === 0) return { path, changed: false };
  const edits = editsOf(options.sitekeys);

  // Last span first, so an earlier replacement never shifts the offsets of one still to come.
  let source = original;
  for (const { edit, span } of [...spans].sort((a, b) => b.span.valueStart - a.span.valueStart)) {
    source = `${source.slice(0, span.valueStart)}${JSON.stringify(edit.value)}${source.slice(span.valueEnd)}`;
  }
  await writeFile(path, source);

  let after: TurnstileCapability | undefined;
  try {
    after = turnstileOf(await load(options.workerDir));
  } catch (cause) {
    await writeFile(path, original);
    throw cause;
  }
  const disagree = edits.filter((edit) => resolvedValue(after, edit) !== edit.value);
  if (disagree.length > 0) {
    await writeFile(path, original);
    throw new InternalError({
      message: `The sitekeys written to ${path} are not what the turnstile capability reads. The file was restored.`,
      action: `Set ${disagree.map((edit) => `${keyPath(edit)}: ${JSON.stringify(edit.value)}`).join(", ")} in the turnstile({ ... }) registration by hand.`,
      detail: `read back ${disagree.map((edit) => `${keyPath(edit)}=${JSON.stringify(resolvedValue(after, edit) ?? null)}`).join(", ")}`,
    });
  }
  return { path, changed: true };
}
