// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The one statement of what a terminal Workflow step writes into its error text, and the one reader of it.**
 *
 * A step's error text is the whole channel. The engine records the throw's message and nothing else —
 * no fields, no cause, no payload — so every operator-facing thing a `PithyError` carries across a
 * durable boundary has to ride inside that one string. `classifiedSteps` used to write
 * `${code}: ${message}`, which meant `action` — the remedy line every other `PithyError` reaching the
 * CLI prints under the problem line — died at the step (pithy-sh/pithy#353).
 *
 * Both ends of that channel live here. {@link encodeWorkflowStepMessage} is called by
 * `classifiedSteps`; {@link decodeWorkflowStepMessage} is called by `@pithy-sh/cloudflare`'s
 * `kitSentence`. **Neither end restates the format.** Two packages that agree about a string by each
 * writing it down is not agreement, it is a coincidence with a maintenance schedule — so the format is
 * the thing being called, not a rule at two call sites, and `stepFailure.test.ts` pins the wire it
 * produces to a hand-written literal so a change to either end has to be a change to both.
 *
 * ## The encoding, and why it is a separator rather than JSON
 *
 * `${code}: ${message}` — unchanged, byte for byte, from what #349 captured — then, when there is one,
 * a separator and the action.
 *
 * A JSON payload was the other candidate, and it is the more obvious answer: unambiguous, extensible,
 * no grammar to get wrong. It loses on the surface nobody controls. **A step's raw text is read by a
 * human, in the Cloudflare dashboard, at three in the morning**, and that reader is the whole reason
 * the message was ever put in the throw. `{"code":"secrets/already_exists","message":"Secret
 * 'api-token' already exists.","action":"Use \`update\` to change an existing secret."}` is strictly
 * worse to read than the two lines it would replace, and it would make every instance already recorded
 * unreadable to the new reader and every instance recorded by the new writer unreadable to the old one.
 * A separator costs a grammar and keeps the sentence.
 *
 * ## Why the separator is a newline
 *
 * A printable delimiter — ` | `, ` :: ` — is ambiguous, and nothing at the reader can resolve it: a
 * message that happens to contain the delimiter splits in the wrong place and the operator reads half
 * a sentence with the other half presented as the remedy. A newline is not ambiguous, because a
 * promoted message may not contain one. That rule is older than this encoding — #349 declined a
 * newline-carrying sentence precisely because it *would forge the CLI's action line* — and it is what
 * makes the split total rather than best-effort. The second line stops being a forgery and becomes the
 * field it always looked like.
 *
 * It also renders. The CLI prints a problem line then an action line, and the dashboard now shows the
 * same two lines the operator's terminal does.
 *
 * **The forgery concern does not disappear; it is bounded, and it was always this size.** A step's text
 * arrives from a Worker whose code we did not write, and the reader promotes it only when it carries a
 * kit throw name and this code grammar. Anyone who can forge that can already forge the problem line.
 * The action line is exactly as trustworthy as the sentence above it — no more, and no less.
 *
 * ## Captured, not assumed
 *
 * The engine embeds the throw's text in its step record raw — it does not JSON-quote it, and it does
 * not escape a newline. Read off a real local Workflows engine (wrangler 4.115.0, 2026-08-14) by
 * driving a Workflow that threw exactly this shape and fetching the instance from the dev session's
 * own Local Explorer instance endpoint:
 *
 * ```text
 * Step threw a NonRetryableError with message "NonRetryableError: secrets/already_exists: Secret
 * 'api-token' already exists.
 * Use `update` to change an existing secret."
 * ```
 *
 * The same run with no action produced #349's captured text byte for byte, which is the compatibility
 * claim stated as a measurement rather than a hope.
 *
 * **`detail` is not here and never will be.** It is the security boundary: client-safe text in
 * `message`, throw-site context in `detail`, and a durable boundary is not a reason to move the line.
 * `action` crosses because `action` is already operator-facing — the CLI prints it and `operatorError`
 * includes it. This stops losing a field that was always meant for this reader.
 */

/**
 * The separator between the step's sentence and its action. One newline, stated once.
 *
 * Exported so a test can assert the wire rather than ask the code what it produces — and so the plant
 * that proves the gate can fail is a one-character edit here.
 */
export const WORKFLOW_STEP_SEPARATOR = "\n";

/**
 * The most either half may run to before it stops being treated as one.
 *
 * The text comes from a Worker over an API, and what it says decides how many bytes land in a terminal,
 * a log line, and an audit row. Over the bound a half is not truncated — it is declined, because half a
 * sentence read as the reason is worse than a general one with the reason underneath it.
 */
export const MAX_WORKFLOW_STEP_TEXT = 512;

/**
 * Any line break. The separator is one specific break, so every other one — a bare `\r`, a second
 * newline — is a shape this encoding never produces, and an unrecognised shape is declined.
 */
const LINE_BREAK = /[\n\r]/;

/**
 * The `domain/reason` grammar of every kit and adopter error code, mirroring `codeSegment` in
 * ../error/payload. Anchored at the start, so it is the prefix or it is nothing.
 */
const CODE_PREFIX = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)*\/[a-z][a-z0-9]*(?:_[a-z0-9]+)*): /;

/** What a terminal step's text carries across the boundary: the code, the sentence, and the remedy. */
export interface WorkflowStepMessage {
  /** The `PithyError` code the step raised — `secrets/already_exists`. */
  code: string;
  /** The public sentence. `PithyError.payload.message`, written to be safe for a client. */
  message: string;
  /** The remedy, when the raising error stated one. The CLI's action line. */
  action?: string;
}

/**
 * Split a leading `<domain>/<reason>: ` off a text.
 *
 * Exported because the code grammar has exactly one statement and two readers: this encoding, and
 * `@pithy-sh/cloudflare`'s handling of a bare `PithyError` throw, whose text is `payload.message` and
 * carries no encoding at all. A second regex over there is how the two would drift.
 */
export function splitWorkflowStepCode(text: string): { code?: string; rest: string } {
  const matched = CODE_PREFIX.exec(text);
  if (matched === null) return { rest: text };
  return { code: matched[1], rest: text.slice(matched[0].length) };
}

/**
 * The text a terminal step throws. The inverse of {@link decodeWorkflowStepMessage}, and tested as one.
 *
 * An action is appended only when there is one to append and it is a single line. An action carrying a
 * break would encode a shape the reader declines, taking the sentence down with it — so the sentence
 * is kept and the action dropped. Losing the remedy is a worse day; losing both is a worse one still.
 */
export function encodeWorkflowStepMessage(fields: WorkflowStepMessage): string {
  const stated = `${fields.code}: ${fields.message}`;
  const action = fields.action?.trim();
  if (action === undefined || action === "" || LINE_BREAK.test(action)) return stated;
  return `${stated}${WORKFLOW_STEP_SEPARATOR}${action}`;
}

/**
 * Read a terminal step's text back, or `null` when it is not this encoding.
 *
 * Strict on purpose. No code prefix, an empty sentence, a half over the bound, a stray `\r`, or a
 * second separator means the text is not something {@link encodeWorkflowStepMessage} wrote, and text
 * the kit did not write does not become an operator's sentence — it stays in `detail`, where the raw
 * platform text belongs.
 */
export function decodeWorkflowStepMessage(text: string): WorkflowStepMessage | null {
  const { code, rest } = splitWorkflowStepCode(text.trim());
  if (code === undefined) return null;

  const cut = rest.indexOf(WORKFLOW_STEP_SEPARATOR);
  const message = (cut === -1 ? rest : rest.slice(0, cut)).trim();
  const action = cut === -1 ? undefined : rest.slice(cut + WORKFLOW_STEP_SEPARATOR.length).trim();

  if (message === "" || message.length > MAX_WORKFLOW_STEP_TEXT || LINE_BREAK.test(message)) return null;
  if (action === undefined) return { code, message };
  if (action === "" || action.length > MAX_WORKFLOW_STEP_TEXT || LINE_BREAK.test(action)) return null;
  return { code, message, action };
}
