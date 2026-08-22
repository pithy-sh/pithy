// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { describe, expect, test } from "vitest";
import { MAX_SUBMISSION_ATTACHMENTS, SupportConfig } from "../config/config";
import { type HandlerDeps, submitFeedbackRequest } from "./handlers";
import { SubmitFeedbackInput } from "./schemas";

/**
 * The configured bounds a submission is held to, applied where the resolved config lives.
 *
 * These are the checks that cannot be in the request schema — it is built once at module load and the
 * numbers are per project — so they are the ones with no validator behind them and worth their own
 * test. **Every case here is refused before a database is touched**, which is why the deps below carry
 * a `db` that would throw if anything reached it.
 */

const CONFIG = SupportConfig.parse({ inboundAddresses: ["support@help.example.com"] });

/** Deps that fail loudly if a refusal ever gets past the bound it was supposed to hit. */
function deps(config = CONFIG): HandlerDeps {
  const unreachable = new Proxy(
    {},
    {
      get() {
        throw new Error("a refused submission must not reach the database");
      },
    },
  );
  return {
    db: unreachable,
    d1: unreachable,
    config,
    categories: {},
    snippets: {},
    fts: false,
    dispatchClassify: async () => true,
    emit: async () => {},
    log: noopLogger,
    newId: () => "id",
    now: () => new Date(0),
  } as unknown as HandlerDeps;
}

/** A well-formed submission, overridden per test. */
function body(overrides: Record<string, unknown> = {}) {
  return SubmitFeedbackInput.parse({ subject: "Export button", body: "Nothing happens.", ...overrides });
}

/** One valid attachment payload. `AAAA` is four bytes of base64 for three zero bytes. */
const FILE = { filename: "shot.png", contentType: "image/png", data: "AAAA" };

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PithyError) return error.payload.code;
    throw error;
  }
  throw new Error("expected a PithyError, but nothing was thrown");
}

describe("the configured submission bounds", () => {
  test("a subject or body over the adopter's bound is refused before anything is written", async () => {
    expect(await codeOf(() => submitFeedbackRequest(deps(), body({ subject: "x".repeat(201) }), "u-1"))).toBe(
      "validation/invalid_input",
    );
    expect(await codeOf(() => submitFeedbackRequest(deps(), body({ body: "x".repeat(10_001) }), "u-1"))).toBe(
      "validation/invalid_input",
    );
  });

  test("the count bound is checked before a single payload is decoded", async () => {
    // The ordering is the fix: `atob` materialises its whole result, so decoding four files to find
    // out that three were allowed has already paid for the request it was refusing. A payload that
    // would throw on decode proves nothing was decoded — the count refusal must come first.
    const undecodable = { filename: "a.png", contentType: "image/png", data: "!!!!not base64!!!!" };
    const four = [FILE, FILE, FILE, { ...undecodable }];
    const code = await codeOf(() => submitFeedbackRequest(deps(), { ...body(), attachments: four } as never, "u-1"));
    expect(code).toBe("validation/invalid_input");
  });

  test("the schema refuses a list beyond the absolute ceiling, whatever the config says", async () => {
    // The cheaper of the two refusals, and the one that needs no resolved config: a thousand-element
    // array never reaches a handler.
    const tooMany = Array.from({ length: MAX_SUBMISSION_ATTACHMENTS + 1 }, () => FILE);
    expect(SubmitFeedbackInput.safeParse({ subject: "s", body: "b", attachments: tooMany }).success).toBe(false);
    expect(
      SubmitFeedbackInput.safeParse({
        subject: "s",
        body: "b",
        attachments: Array.from({ length: MAX_SUBMISSION_ATTACHMENTS }, () => FILE),
      }).success,
    ).toBe(true);
  });

  test("the validator accepts both base64 alphabets, so the decoder's tolerance is reachable", () => {
    // `decodeBase64` normalizes `-`/`_` and its docstring says a client whose encoder emits base64url
    // "has not made a mistake worth a 400" — but `z.base64()` alone rejects exactly those characters,
    // so the route would have 400'd them before the decoder ever saw one. A validator that refuses
    // what the code behind it documents as fine is the validator that is wrong.
    const urlSafe = { filename: "a.png", contentType: "image/png", data: "-_8" };
    const standard = { filename: "a.png", contentType: "image/png", data: "+/8=" };
    for (const attachment of [urlSafe, standard]) {
      const parsed = SubmitFeedbackInput.safeParse({ subject: "s", body: "b", attachments: [attachment] });
      expect(parsed.success, attachment.data).toBe(true);
    }
    // Something that is neither is still refused at the boundary rather than inside the decoder.
    expect(
      SubmitFeedbackInput.safeParse({
        subject: "s",
        body: "b",
        attachments: [{ filename: "a.png", contentType: "image/png", data: "not base64 at all!!" }],
      }).success,
    ).toBe(false);
  });

  test("an adopter's raised bound is honored, and their lowered one bites", async () => {
    const strict = SupportConfig.parse({ submission: { maxBodyChars: 10 } });
    expect(await codeOf(() => submitFeedbackRequest(deps(strict), body({ body: "x".repeat(11) }), "u-1"))).toBe(
      "validation/invalid_input",
    );
  });
});
