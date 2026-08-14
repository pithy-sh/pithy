// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  decodeWorkflowStepMessage,
  MAX_WORKFLOW_STEP_TEXT,
  splitWorkflowStepCode,
} from "@pithy-sh/core/src/workflow/stepMessage";
import { z } from "zod";

/**
 * **The step's sentence, recovered from an instance the engine has already written its own over.**
 *
 * A Workflow instance carries two failure texts. The instance-level `error` is the *platform's*: when a
 * step raises `NonRetryableError`, the engine replaces whatever was thrown with
 * `"The execution of the Workflow instance was terminated, as a step threw an NonRetryableError…"`.
 * The step's own entry in `steps[]` still holds the text the kit raised. Reporting the first is how
 * `pithy secrets create` on a name that already exists started answering with a sentence about durable
 * execution instead of one about the secret (pithy-sh/pithy#349), the day #338 made that refusal terminal.
 *
 * So this reads the step, and it is read *here* rather than at a call site: every dispatch that polls a
 * Workflow — secrets write and probe, payments reconcile, vector reprocess — goes through one
 * `dispatchAndPoll`, and a rule that lives in the primitive cannot be missed by the next caller.
 *
 * ## What may cross into an operator's `message`, and what may not
 *
 * A `PithyError`'s `message` is public and its `detail` is stripped at the HTTP boundary — that is the
 * security boundary, and this function is on the wrong side of it: the text arrives from a Worker whose
 * code we did not write, over an API, and it could say anything. So a step's text is promoted into the
 * operator's `message` **only when it is demonstrably a sentence the kit itself authored as public**:
 *
 * - `PithyError: <text>` — the throw's own name is the proof. `PithyError.message` *is*
 *   `payload.message`, the field already written to be safe for a client.
 * - The encoding core's `classifiedSteps` writes, inside the platform's terminal envelope. **This file
 *   does not restate that encoding**; it calls `decodeWorkflowStepMessage`, which is the same module
 *   the writer calls, for the reason in its own doc comment: two packages agreeing about a string by
 *   each writing it down is a coincidence, not a contract (pithy-sh/pithy#353).
 *
 * Anything else — a foreign throw, a bare string, the engine's own prose — stays in `detail`, where it
 * always was. Nothing that was not already public becomes public here.
 *
 * `action` rides that encoding and is promoted with the sentence, because it is already the operator's
 * field: the CLI prints it under the problem line and `operatorError` includes it. `detail` does not
 * cross, has no encoding, and is not read here.
 *
 * ## The literals are captured, not guessed
 *
 * Every platform string below was read off a real Workflows engine — the shipped Workflow class driven
 * under `wrangler dev` (wrangler 4.123.0, 2026-08-14), instance detail fetched from the local dev
 * session's own instance endpoint. They are frozen so the gate in `stepFailure.test.ts` polices a fixed
 * set rather than whatever this file happens to believe today.
 */

/** A failure as the Workflows API records one: a class name and its text. Instance-level and per-step alike. */
export const WorkflowFailureDetail = z
  .object({
    name: z.string().optional().describe("The thrown value's class name, as the engine recorded it."),
    message: z
      .string()
      .optional()
      .describe("The failure text — the engine's own for a terminal step, else the throw's."),
  })
  .describe("One failure the Workflows API reports, on an instance or on a step attempt.");
export type WorkflowFailureDetail = z.output<typeof WorkflowFailureDetail>;

/** One attempt at a step. The engine appends one per retry, so the last failed one is the answer. */
export const WorkflowStepAttempt = z
  .object({
    success: z.boolean().nullish().describe("Whether this attempt returned; `false` once it threw."),
    error: WorkflowFailureDetail.nullish().describe("What this attempt threw, absent when it returned."),
  })
  .describe("One attempt at a Workflow step, as the instance-detail endpoint reports it.");
export type WorkflowStepAttempt = z.output<typeof WorkflowStepAttempt>;

/**
 * One entry in an instance's `steps[]`.
 *
 * The API's four step shapes (`step`, `sleep`, `waitForEvent`, `termination`) differ in where the
 * failure lives — a `step` keeps one per attempt, the others keep one on the entry — so both are
 * optional here and the reader takes whichever is present. Unknown fields (`config`, `output`,
 * timestamps) are stripped rather than refused: this is a diagnostic read, and a step shape nobody
 * anticipated must not turn a failed Workflow into a parse error about the failure report.
 */
export const WorkflowStepRecord = z
  .object({
    name: z.string().optional().describe("The step's name, as `step.do` was called with it."),
    type: z.string().optional().describe("Which of the API's step shapes this is — `step`, `sleep`, `waitForEvent`."),
    success: z.boolean().nullish().describe("Whether the step completed; `false` once every attempt failed."),
    error: WorkflowFailureDetail.nullish().describe("The failure, for the shapes that record one on the entry."),
    attempts: z.array(WorkflowStepAttempt).optional().describe("Each attempt at the step, oldest first."),
  })
  .describe("One step of a Workflow instance, narrowed to the fields a failure report reads.");
export type WorkflowStepRecord = z.output<typeof WorkflowStepRecord>;

/** What a failed instance's steps say about why, once the platform's own prose is set aside. */
export interface WorkflowStepFailure {
  /** The failed step's name, when the engine reported one. */
  step?: string;
  /** The step's recorded text, verbatim, platform envelope and all. For `detail` — never for `message`. */
  raw: string;
  /** The `PithyError` code the step raised, when its text carries one. */
  code?: string;
  /** The step's own public sentence — present only when the text is one the kit authored. */
  sentence?: string;
  /** The remedy the raising error stated, when it stated one. The CLI's action line. */
  action?: string;
}

/**
 * The envelope the engine wraps a terminal step throw in, captured verbatim. The inner text is *not*
 * JSON-quoted — a message containing a `"` is embedded raw — so this is a prefix/suffix strip and never
 * a `JSON.parse`.
 */
const TERMINAL_STEP_ENVELOPE = Object.freeze({
  prefix: 'Step threw a NonRetryableError with message "',
  suffix: '"',
});

/**
 * The throw names a kit step error can arrive under. `PithyError` is core's one throw vehicle;
 * `NonRetryableError` is what `classifiedSteps` re-throws a terminal fault as. A name outside this set
 * is somebody else's error, and its text stays in `detail`.
 */
const KIT_THROW_NAMES: readonly string[] = Object.freeze(["PithyError", "NonRetryableError"]);

/**
 * The kit-authored public sentence inside a step's recorded text, and the remedy riding with it —
 * `null` when there is none.
 *
 * Exported for the gate, which drives captured engine output through it: a platform sentence reaching an
 * operator is a test failure, and the test has to be able to ask this question directly.
 */
export function kitSentence(raw: string): { code?: string; message: string; action?: string } | null {
  let text = raw.trim();
  if (text.startsWith(TERMINAL_STEP_ENVELOPE.prefix) && text.endsWith(TERMINAL_STEP_ENVELOPE.suffix)) {
    text = text.slice(TERMINAL_STEP_ENVELOPE.prefix.length, -TERMINAL_STEP_ENVELOPE.suffix.length);
  }
  const thrown = KIT_THROW_NAMES.map((name) => `${name}: `).find((prefix) => text.startsWith(prefix));
  if (thrown === undefined) return null;
  text = text.slice(thrown.length);

  // A `NonRetryableError` is `classifiedSteps`' vehicle, so its text is core's encoding or it is
  // somebody else's — anyone may throw one with anything inside, and the code prefix is the only proof.
  if (thrown === "NonRetryableError: ") return decodeWorkflowStepMessage(text);

  // A `PithyError` name is proof on its own. Its recorded text is `payload.message` and carries no
  // encoding at all — no action ever rode here — so the sentence is taken as it stands, and a newline
  // in it is still declined rather than reshaped: it would forge the CLI's action line.
  const { code, rest } = splitWorkflowStepCode(text);
  const message = rest.trim();
  if (message === "" || message.length > MAX_WORKFLOW_STEP_TEXT) return null;
  if (/[\n\r]/.test(message)) return null;
  return code === undefined ? { message } : { code, message };
}

/** The recorded failure text of one step entry, from its last failed attempt or its own error. */
function failureTextOf(step: WorkflowStepRecord): string | undefined {
  for (let index = (step.attempts?.length ?? 0) - 1; index >= 0; index -= 1) {
    const attempt = step.attempts?.[index];
    if (attempt?.success === true) continue;
    const message = attempt?.error?.message;
    if (message !== undefined && message !== "") return message;
  }
  const own = step.error?.message;
  return own === undefined || own === "" ? undefined : own;
}

/**
 * The last step that failed, and what it said. `null` when no step reports a failure — an instance the
 * platform failed on its own (a timeout, a terminate) has steps that all succeeded, or none at all.
 *
 * Read from the end: the failing step is the last one the instance reached, and an earlier step that
 * failed and was retried into success has nothing to say about why the instance ended.
 *
 * Each entry is validated on its way in and an entry that will not parse is skipped rather than thrown
 * on. The caller is already reporting a failure; refusing to describe it because one step of the report
 * had an unfamiliar shape trades a useful sentence for a useless one.
 */
export function stepFailure(steps: readonly unknown[] | undefined): WorkflowStepFailure | null {
  if (steps === undefined) return null;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const parsed = WorkflowStepRecord.safeParse(steps[index]);
    if (!parsed.success) continue;
    if (parsed.data.success === true) continue;
    const raw = failureTextOf(parsed.data);
    if (raw === undefined) continue;
    const kit = kitSentence(raw);
    return {
      ...(parsed.data.name === undefined ? {} : { step: parsed.data.name }),
      raw,
      ...(kit?.code === undefined ? {} : { code: kit.code }),
      ...(kit === null ? {} : { sentence: kit.message }),
      // Absent, not `undefined`: a step that stated no remedy must leave nothing for the CLI to print
      // under the problem line — no empty line, no trailing separator, no `undefined`.
      ...(kit?.action === undefined ? {} : { action: kit.action }),
    };
  }
  return null;
}
