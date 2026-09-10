// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { guaranteedErrorParams } from "@pithy-sh/core/src/error/messageParams";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { renderTerminal } from "@pithy-sh/core/src/error/terminal";
import { classifiedSteps, type WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";
import { APIError } from "cloudflare";
import { describe, expect, it } from "vitest";
import { cloudflareRequest } from "../client/errors";
import { stepFailure, terminalWorkflowError } from "./stepFailure";

/**
 * **A Cloudflare refusal raised inside a Workflow step reaches the operator as a Cloudflare refusal.**
 *
 * Two packages each had a test proving their own half and the seam between them had none, so #534's
 * first round broke it without a single suite going red. Putting the API's `errors[]` into a multi-line
 * `message` was correct in a terminal and unencodable at a durable step: `stepMessage`'s separator is a
 * newline, the reader declines any second one, and every Cloudflare failure raised inside
 * `classifiedSteps` — `@pithy-sh/secrets`' rotation write-back, `@pithy-sh/media`'s Stream reads,
 * `@pithy-sh/payments`' reconcile — arrived as `core/workflow_failed` 500, "The Workflow instance
 * failed." No code, no answer, no remedy, on exactly the failure the issue existed to explain.
 *
 * So the seam is driven end to end here, with nothing hand-built along the way: a real SDK `APIError`
 * carrying the body Cloudflare actually returned, through the real `cloudflareRequest`, raised inside
 * the real `classifiedSteps`, recorded in the envelope the engine was captured writing, and read back
 * by the real `stepFailure` + `terminalWorkflowError`.
 */

/** The 401 body `GET /accounts/<id>/challenges/widgets` returned during the dashboard bring-up (#534). */
const TURNSTILE_DENIAL = `{"success":false,"errors":[{"code":10000,"message":"Authentication error","documentation_url":"https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/list"}]}`;

/** The platform's terminal class, standing in exactly as the engine's does — the name is what it keys on. */
class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/** A capability that retries nothing, so a Cloudflare refusal takes the terminal encoding path. */
const policy: WorkflowRetryPolicy = { capability: "secrets", retryable: {} };

/**
 * One step's recorded text, wrapped as the engine was captured wrapping it (see `stepFailure.test.ts`).
 * The engine stringifies the throw, so the class name leads the text and the envelope quotes are not
 * an escape — a message containing a `"` is embedded raw.
 */
const recorded = (text: string) => `Step threw a NonRetryableError with message "NonRetryableError: ${text}"`;

/**
 * Drive one Cloudflare failure through a classified step and hand back what the engine would record.
 *
 * The `cause` is severed on the way out, exactly as it is across a real boundary: the engine keeps the
 * throw's text and discards the throw.
 */
async function throughAStep(operation: string, thrown: unknown): Promise<string> {
  const steps = classifiedSteps({ do: async (_name, fn) => fn() }, policy, NonRetryableError);
  const error = await steps
    .do("rotate-key", () => cloudflareRequest(operation, () => Promise.reject(thrown)))
    .catch((caught: unknown) => caught);
  return (error as Error).message;
}

/** What the operator is handed for an instance whose only step failed with `text`. */
function operatorError(text: string): PithyError {
  return terminalWorkflowError({
    failure: stepFailure([
      {
        name: "rotate-key",
        type: "step",
        success: false,
        attempts: [{ success: false, error: { name: "NonRetryableError", message: recorded(text) } }],
      },
    ]),
    fallbackMessage: "The Workflow instance failed.",
    detail: "instance 0199e0d6-…",
  });
}

describe("a Cloudflare refusal inside a durable step", () => {
  const denial = () => APIError.generate(401, JSON.parse(TURNSTILE_DENIAL), undefined, new Headers());

  it("crosses the boundary whole: the code, Cloudflare's answer, and the remedy", async () => {
    const { payload } = operatorError(await throughAStep("Turnstile list widgets for 'app.pithy.sh'", denial()));

    expect(payload.code).toBe("cloudflare/request_failed");
    expect(payload.status).toBe(502);
    expect(renderTerminal(payload)).toBe(
      [
        "Cloudflare request failed: Turnstile list widgets for 'app.pithy.sh'. Cloudflare said: 10000 Authentication error — https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/list",
        "A missing grant, a dead token and the wrong account all look the same here. Check the token for Account → Turnstile, then CLOUDFLARE_API_TOKEN, then CLOUDFLARE_ACCOUNT_ID.",
      ].join("\n"),
    );
  });

  it("is not the platform's sentence about durable execution", async () => {
    const { payload } = operatorError(await throughAStep("Turnstile list widgets", denial()));

    expect(payload.code).not.toBe("core/workflow_failed");
    expect(payload.message).not.toBe("The Workflow instance failed.");
  });

  it("keeps every param `core` declares guaranteed, on a code recovered off the wire", async () => {
    // `params` cannot cross a step boundary — the channel is three fields — but the promise a locale
    // wrote `{apiAnswer}` against is per *throw*, and re-raising the code here is a throw. Empty is
    // what "no answer to quote" renders as; the answer itself is already in the English `message`.
    const { payload } = operatorError(await throughAStep("Turnstile list widgets", denial()));

    for (const name of guaranteedErrorParams("cloudflare/request_failed")) {
      expect(payload.params?.[name]).toBe("");
    }
  });

  it("still hands over a bounded refusal when Cloudflare answers at length", async () => {
    // The composer's bound is the step channel's, so this is the case that used to fall off the end of
    // it: three 200-character sentences and a long operation name.
    const wordy = JSON.stringify({
      success: false,
      errors: [1, 2, 3].map((code) => ({ code, message: "x".repeat(400) })),
    });
    const { payload } = operatorError(
      await throughAStep(
        `Turnstile list widgets for ${"a-very-long-hostname.example.com ".repeat(6)}`,
        APIError.generate(403, JSON.parse(wordy), undefined, new Headers()),
      ),
    );

    expect(payload.code).toBe("cloudflare/request_failed");
    expect(payload.message.endsWith("…")).toBe(true);
  });

  it("leaves `detail` on the far side, where it always was", async () => {
    const { payload } = operatorError(await throughAStep("Turnstile list widgets", denial()));

    // The raw body is the throw site's, and the throw site was in another Worker.
    expect(payload.detail).not.toContain('"success":false');
    expect(payload.detail).toContain("instance 0199e0d6-…");
  });
});
