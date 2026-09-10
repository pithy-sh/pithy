// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { childSchemas, kindOf, unwrapField } from "@pithy-sh/core/src/schema/describedness";
import type { z } from "zod";
import type { SecretRegistryEntry } from "../registry";

/**
 * **What a `json` secret can be asked for one field at a time.**
 *
 * `pithy secrets create payments-provider-credentials` used to prompt once, masked, for a whole JSON
 * document — brackets included, unseen, with no feedback until the last character (#516). The registry
 * already carries the shape and CLAUDE.md §Zod already requires a `.describe()` on every field, so the
 * words to ask with are there; this turns that schema into a list of questions.
 *
 * **It plans, it does not prompt.** The plan is pure data over a Zod schema, so the rules below are
 * unit-testable without a terminal, and the CLI's prompter is left with nothing to decide. Assembly
 * ({@link assembleSecretValue}) is here for the same reason: which answers become keys is a rule about
 * the schema, not about `@clack/prompts`.
 *
 * **The parse gate does not move.** What this assembles is handed to {@link validateSecretValue} like
 * any other value — the same single client-side gate, unchanged. Nothing here validates a field, and
 * that is deliberate: a second checker beside the schema is a second opinion about the schema.
 *
 * **It refuses far more than it handles.** A union, a record, an array of objects, an enum, a branch
 * whose declaration disagrees with the schema — every one of them returns `null`, and the CLI asks for
 * the whole document exactly as it does today. Refusing to prompt costs an operator what they already
 * had; guessing a shape costs them a credential written wrong.
 *
 * **Whether a value spans lines is the sharpest case of that, and it is declared by every field or by
 * none.** A masked prompt reads one line, and what it does with the rest of a pasted `.p8` was measured
 * against the real `@clack/prompts` `password()` under a real pty (`capabilities/secretPrompt.pty.test.ts`):
 * a CR-delimited paste returns the **first** line and drops the rest, an LF-delimited one returns the
 * **last**. Either way one fragment is written, it satisfies `z.string().min(1)`, and nothing surfaces
 * until a signature check fails in production — a wrong value that passes the gate, which is the one
 * outcome worse than a prompt that refuses.
 *
 * **So a string leaf is asked for only once somebody has said it fits on a line.** `.meta({ multiline:
 * false })` beside its `.describe()` says it does; `.meta({ multiline: true })` says it does not, and a
 * plan that would have to ask for such a field is refused whole. A leaf nobody marked is refused the
 * same way, because *undeclared* and *safe* are not the same fact. The fallback is safe because the
 * fallback asks for **JSON**, and `JSON.stringify` escapes a newline into `\n` — the document an
 * operator pastes, or pipes, is one line by construction.
 *
 * **The polarity was the other way around for two rounds, and it did not hold.** Opt-out put the CLI
 * prompt's mechanics on nobody and left every unmarked leaf exposed, backed by a prompt-side check on an
 * answer "arriving with a newline in it" — an answer never does, so the backstop could not fire. Opt-in
 * costs one `.meta({})` per string leaf and is enforced as a set, the way CLAUDE.md enforces `.describe()`,
 * `migrationOrder` and the stamped version: `packages/cli/src/ci/secretFieldLines.test.ts` sweeps every
 * `json` secret in the repository and fails naming any leaf that has not said. A new capability cannot
 * quietly add an unmarked PEM, and the decision is made where the author is rather than inferred at a
 * prompt months later.
 */

/** One leaf an operator is asked for. */
export interface SecretPromptField {
  /** Where the answer lands, as object keys: `["stripe", "secretKey"]`, or `["clientId"]` at the root. */
  path: readonly string[];
  /** The field's own key — the last segment of {@link SecretPromptField.path}, carried so assembly needs no cast. */
  key: string;
  /** The field's own `.describe()` — the words the prompt asks with. */
  description: string;
  /** Whether the schema lets the key be left out. An empty answer is omitted either way; see {@link assembleSecretValue}. */
  optional: boolean;
}

/**
 * One optional object block — a payment rail, a Turnstile widget — offered whole or not at all.
 *
 * Which blocks are offered is the composed capability's answer, never this module's: see
 * `SecretBranchSeam`. A branch the project has not configured is never in a plan, so it can be neither
 * prompted nor written.
 */
export interface SecretPromptBranch {
  /** The key the block sits under in the assembled object. */
  key: string;
  /** The block's own `.describe()` — what the checkbox shows beside its name. */
  description: string;
  /** The block's leaves, in schema order. */
  fields: readonly SecretPromptField[];
}

/** One `json` secret, as a list of questions. */
export interface SecretPromptPlan {
  /** Leaves at the root of the object. Always asked. */
  fields: readonly SecretPromptField[];
  /** Optional object blocks, in schema order, already narrowed to the ones the project configured. */
  branches: readonly SecretPromptBranch[];
}

/**
 * The leaf kinds a masked prompt can honestly collect: a string, and nothing else.
 *
 * A number would need the prompt to parse it, an enum would need it to render choices, and a nested
 * array would need it to ask "how many" — three shapes the fallback already handles correctly by
 * declining. Every `json` secret the kit ships is strings all the way down.
 */
const PROMPTABLE_LEAF: ReadonlySet<string> = new Set(["string"]);

/** An object's fields, in declaration order. */
function shapeOf(schema: z.ZodType): [string, z.ZodType][] {
  return Object.entries((schema as unknown as z.ZodObject).shape) as [string, z.ZodType][];
}

/**
 * What a field has said about its own shape on a terminal: it fits on one line, or it does not.
 *
 * `undefined` is the third answer and the load-bearing one — **nobody has said**, which is not
 * *single*. A prompt that treated it as *single* would be guessing, and the guess is only ever wrong in
 * the direction that writes a truncated credential (see the module docblock).
 */
export type SecretFieldLines = "single" | "multi";

/**
 * Whether a field's value fits on one line, from anywhere in its wrapper chain.
 *
 * Read at every level, so `z.string().meta({ multiline: true }).optional()` counts: `.optional()` builds
 * a new schema rather than a registry-inheriting clone, and a reader who wrapped a marked field plainly
 * meant to keep the mark. The same walk `@pithy-sh/vector`'s `isFilterable` does, for the same reason.
 *
 * Anything but a boolean `multiline` is *undeclared* rather than an error here: `secretFieldLines.test.ts`
 * is where a typo is reported, with the field named, and a second opinion at read time would only make
 * the two disagree.
 */
export function secretFieldLines(schema: z.ZodType): SecretFieldLines | undefined {
  let current: z.ZodType | undefined = schema;
  while (current) {
    const meta = current.meta() as { multiline?: unknown } | undefined;
    if (typeof meta?.multiline === "boolean") return meta.multiline ? "multi" : "single";
    current = (current as unknown as { def?: { innerType?: z.ZodType } }).def?.innerType;
  }
  return undefined;
}

/** One leaf, planned — or `null` when it is not a shape a masked prompt can ask for. */
function planField(key: string, field: z.ZodType, prefix: readonly string[]): SecretPromptField | null {
  const unwrapped = unwrapField(field, key);
  if (!PROMPTABLE_LEAF.has(kindOf(unwrapped.schema))) return null;
  // Asked for only once somebody has said it fits on a line. A `multi` field would be truncated by the
  // prompt and an undeclared one might be; both are refused whole, and the CLI asks for one document.
  if (secretFieldLines(field) !== "single") return null;
  return { path: [...prefix, key], key, description: unwrapped.description ?? key, optional: unwrapped.optional };
}

/** One optional object block, planned — or `null` when any of its leaves is not promptable. */
function planBranch(key: string, block: z.ZodType, description: string): SecretPromptBranch | null {
  const fields: SecretPromptField[] = [];
  for (const [name, field] of shapeOf(block)) {
    const planned = planField(name, field, [key]);
    if (!planned) return null;
    fields.push(planned);
  }
  if (fields.length === 0) return null;
  return { key, description, fields };
}

/**
 * The questions to ask for one secret, or `null` to ask for the whole document as before.
 *
 * `branches` is what the composed capability declared for this secret (`SecretBranchSeam`), and
 * `undefined` means it declared nothing. The difference decides a schema with optional object blocks:
 * with no declaration there is nothing that knows which blocks are real, so the plan is refused rather
 * than offering five rails to a project that runs one. With a declaration, only the declared blocks are
 * planned — in schema order, so the prompts read down the schema however the capability listed them.
 *
 * A declared key the schema does not have is a refusal too, and a loud-ish one: the two halves of one
 * capability disagree, and prompting for the half that still parses would write a bundle assembled from
 * a stale name.
 *
 * **A block is planned only once it is known to be configured**, so a block this project does not run
 * cannot refuse a plan on its behalf. `payments-provider-credentials` is why: Apple's `.p8` and Google's
 * service-account key are `multiline` and can never be asked for one line at a time, and planning every
 * block up front would have meant every project falling back — including the Stripe-only one that has no
 * PEM anywhere near it. A configured block that cannot be asked for still refuses the whole plan, and
 * must: asking for the others and omitting this one writes a bundle missing a rail the project runs.
 */
export function secretPromptPlan(
  entry: SecretRegistryEntry,
  branches?: readonly string[] | undefined,
): SecretPromptPlan | null {
  if (entry.valueType !== "json") return null;
  const root = unwrapField(entry.schema, "schema").schema;
  if (kindOf(root) !== "object") return null;

  const fields: SecretPromptField[] = [];
  const blocks = new Map<string, { schema: z.ZodType; description: string }>();
  for (const [key, field] of shapeOf(root)) {
    const unwrapped = unwrapField(field, key);
    if (kindOf(unwrapped.schema) === "object") {
      // A required block is not a branch: nothing chooses it, so a plan that omitted it would write an
      // object the schema refuses, and one that always included it would be guessing that the project
      // uses it. Neither is this module's call to make.
      if (!unwrapped.optional) return null;
      blocks.set(key, { schema: unwrapped.schema, description: unwrapped.description ?? key });
      continue;
    }
    const leaf = planField(key, field, []);
    if (!leaf) return null;
    fields.push(leaf);
  }

  if (blocks.size === 0) {
    // A flat secret needs no declaration, and a declaration for one is a disagreement.
    return branches !== undefined && branches.length > 0 ? null : { fields, branches: [] };
  }
  if (branches === undefined) return null;
  if (branches.some((key) => !blocks.has(key))) return null;
  const chosen = new Set(branches);
  const offered: SecretPromptBranch[] = [];
  for (const [key, block] of blocks) {
    if (!chosen.has(key)) continue;
    const planned = planBranch(key, block.schema, block.description);
    if (!planned) return null;
    offered.push(planned);
  }
  // Nothing to ask for: every block is off and the root has no leaves. The single prompt is the only
  // way left to write this secret at all, so it is what the operator gets.
  if (offered.length === 0 && fields.length === 0) return null;
  return { fields, branches: offered };
}

/** One field a masked prompt may not ask for, and the words that say why. */
export interface UnaskableSecretField {
  /** The dotted path, as {@link fieldKey} spells it. */
  key: string;
  /** The half-sentence a note completes: `apple.privateKey spans lines`. */
  reason: string;
}

/**
 * The fields a plan for this secret would have to ask for and may not — the reason a bundle that looks
 * promptable is asked for whole.
 *
 * Reported rather than merely refused, because a fallback nobody can account for reads as the CLI being
 * inconsistent: one secret asks six questions and the next asks for a JSON document, and the operator has
 * no way to see that a `.p8` is the difference. Narrowed by `branches` for the same reason
 * {@link secretPromptPlan} plans lazily — naming Apple's key to a project that runs Stripe would be
 * blaming the wrong field.
 *
 * **Two reasons, because there are two.** A field that says it spans lines is the kit's own case; a field
 * that says nothing is an adopter's, and it reads as a bug until the note names it. `secretFieldLines.test.ts`
 * keeps the second out of the kit, which is exactly why the CLI must still be able to say it out loud
 * about a registry that is not the kit's.
 */
export function unaskableSecretFields(
  entry: SecretRegistryEntry,
  branches?: readonly string[] | undefined,
): UnaskableSecretField[] {
  if (entry.valueType !== "json") return [];
  const root = unwrapField(entry.schema, "schema").schema;
  if (kindOf(root) !== "object") return [];
  const found: UnaskableSecretField[] = [];
  const report = (key: string, field: z.ZodType): void => {
    if (!PROMPTABLE_LEAF.has(kindOf(unwrapField(field, key).schema))) return;
    const lines = secretFieldLines(field);
    if (lines === "multi") found.push({ key, reason: "spans lines" });
    if (lines === undefined) found.push({ key, reason: "does not say whether it spans lines" });
  };
  for (const [key, field] of shapeOf(root)) {
    const unwrapped = unwrapField(field, key);
    if (kindOf(unwrapped.schema) !== "object") {
      report(key, field);
      continue;
    }
    if (branches !== undefined && !branches.includes(key)) continue;
    for (const [name, leaf] of shapeOf(unwrapped.schema)) report(`${key}.${name}`, leaf);
  }
  return found;
}

/**
 * **Every string leaf under this schema that has not said whether it fits on a line.** The sweep
 * `packages/cli/src/ci/secretFieldLines.test.ts` runs over every `json` secret in the repository.
 *
 * Deeper than {@link secretPromptPlan} on purpose, and that is the difference between a rule and a
 * habit. The planner walks the two levels it can render — root leaves and one layer of optional blocks —
 * so a PEM three levels down or inside an array is a shape it refuses anyway. This walk goes wherever
 * `childSchemas` goes, so the *declaration* is required of a field the planner would never reach: the
 * planner's reach is an implementation detail that may widen, and a leaf that was exempt by depth would
 * become promptable on the day it widened, unmarked and silent.
 *
 * The description-gate's walk is reused rather than copied (`@pithy-sh/core/src/schema/describedness`),
 * so a container it has never been taught throws here too instead of passing as a leaf.
 */
export function undeclaredLineFields(schema: z.ZodType, path: string): string[] {
  const found: string[] = [];
  visitForLines(schema, path, found);
  return found;
}

/** One node of {@link undeclaredLineFields}' walk: a string leaf reports, anything else hands over its inside. */
function visitForLines(field: z.ZodType, path: string, found: string[]): void {
  const unwrapped = unwrapField(field, path).schema;
  const kind = kindOf(unwrapped);
  if (kind === "string") {
    if (secretFieldLines(field) === undefined) found.push(path);
    return;
  }
  if (kind === "object") {
    for (const [key, child] of shapeOf(unwrapped)) visitForLines(child, `${path}.${key}`, found);
    return;
  }
  if (kind === "record" || kind === "map") {
    // A key is not a value anybody is asked for — it is how a value is addressed, and it is already
    // constrained by whatever the map is keyed on. Only the value side can hold a credential.
    const valueType = (unwrapped as unknown as { def: { valueType: z.ZodType } }).def.valueType;
    visitForLines(valueType, `${path}[value]`, found);
    return;
  }
  const children = childSchemas(unwrapped, path);
  for (const [index, child] of children.entries()) {
    visitForLines(child, children.length === 1 ? `${path}[${kind}]` : `${path}[${kind}:${index}]`, found);
  }
}

/** Every field a plan asks for, root leaves first, then each branch's — the order a prompter walks. */
export function promptedFields(plan: SecretPromptPlan, branches: readonly string[]): SecretPromptField[] {
  const chosen = new Set(branches);
  return [
    ...plan.fields,
    ...plan.branches.filter((branch) => chosen.has(branch.key)).flatMap((branch) => [...branch.fields]),
  ];
}

/** A field's answer key — the dotted path, which is also how a validation failure names it. */
export function fieldKey(field: SecretPromptField): string {
  return field.path.join(".");
}

/**
 * The JSON document the answers make, ready for the one parse gate.
 *
 * Two rules, and both are about absence.
 *
 * **An empty answer is not a value.** It is never written, whether the field is optional or required.
 * For an optional one that is the operator saying they have none; for a required one it hands the
 * schema a missing key, which the gate names — and naming the field beats storing `""` against a
 * `z.string()` that would accept it and fail at the first sign-in instead.
 *
 * **A branch nobody chose is absent entirely**, never `{}` and never a block of empty strings. That is
 * the schema's own words for `payments-provider-credentials`: a rail's block is present in full or
 * absent entirely.
 */
export function assembleSecretValue(
  plan: SecretPromptPlan,
  branches: readonly string[],
  answers: Readonly<Record<string, string>>,
): string {
  const value: Record<string, unknown> = {};
  for (const field of plan.fields) {
    const answer = answers[fieldKey(field)];
    if (answer) value[field.key] = answer;
  }
  const chosen = new Set(branches);
  for (const branch of plan.branches) {
    if (!chosen.has(branch.key)) continue;
    const block: Record<string, unknown> = {};
    for (const field of branch.fields) {
      const answer = answers[fieldKey(field)];
      if (answer) block[field.key] = answer;
    }
    value[branch.key] = block;
  }
  return JSON.stringify(value);
}
