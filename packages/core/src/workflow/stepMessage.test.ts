// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { RateLimitError } from "../error/pithyError";
import {
  decodeWorkflowStepMessage,
  encodeWorkflowStepMessage,
  MAX_WORKFLOW_STEP_TEXT,
  splitWorkflowStepCode,
  WORKFLOW_STEP_SEPARATOR,
} from "./stepMessage";

/**
 * The wire, written by hand rather than computed from the encoder. A test that asks the code what it
 * produces agrees with the code; this one states what the format is, so changing the format is a change
 * to this line as well as to that one.
 */
const WIRE = Object.freeze({
  withAction: "secrets/already_exists: Secret 'api-token' already exists.\nUse `update` to change an existing secret.",
  withoutAction: "secrets/already_exists: Secret 'api-token' already exists.",
});

const FIELDS = Object.freeze({
  code: "secrets/already_exists",
  message: "Secret 'api-token' already exists.",
  action: "Use `update` to change an existing secret.",
});

describe("the encoding is one statement, and the wire is written down", () => {
  test("an action rides the separator, and the wire is exactly this", () => {
    expect(encodeWorkflowStepMessage(FIELDS)).toBe(WIRE.withAction);
  });

  test("no action means the shape #349 captured, byte for byte", () => {
    expect(encodeWorkflowStepMessage({ code: FIELDS.code, message: FIELDS.message })).toBe(WIRE.withoutAction);
  });

  test("the separator is one newline", () => {
    expect(WORKFLOW_STEP_SEPARATOR).toBe("\n");
    expect(WIRE.withAction.split(WORKFLOW_STEP_SEPARATOR)).toHaveLength(2);
  });

  test("decode is the inverse of encode", () => {
    expect(decodeWorkflowStepMessage(WIRE.withAction)).toEqual(FIELDS);
    expect(decodeWorkflowStepMessage(WIRE.withoutAction)).toEqual({ code: FIELDS.code, message: FIELDS.message });
    expect(decodeWorkflowStepMessage(encodeWorkflowStepMessage(FIELDS))).toEqual(FIELDS);
  });

  test("a message carrying a double quote round-trips — the engine embeds the text raw", () => {
    const fields = { code: "secrets/invalid_value", message: 'The value for "api-token" is too long.' };
    expect(decodeWorkflowStepMessage(encodeWorkflowStepMessage(fields))).toEqual(fields);
  });

  test("an adopter's own domain is the same grammar", () => {
    const fields = { code: "acme/too_cold", message: "Warm it up.", action: "Run `acme warm`." };
    expect(decodeWorkflowStepMessage(encodeWorkflowStepMessage(fields))).toEqual(fields);
  });
});

/**
 * **The encoder is total, and this is the regression that says why it has to be.**
 *
 * The reader declines a shape it did not write, which costs the writer everything at once: no code, no
 * sentence, no remedy, and an operator handed `core/workflow_failed` 500 about durable execution. #534
 * put an upstream's `errors[]` into a multi-line `message` and every Cloudflare refusal raised inside a
 * `classifiedSteps` step stopped crossing — the first newline read as the separator, the second as a
 * shape this never writes. Nothing in the channel could have caught it, because the writer had already
 * produced something unreadable by the time the reader saw it.
 *
 * So each half is reshaped on the way out rather than declined on the way in. The asymmetry is the
 * point: text the kit authored may be flattened and truncated; text from a Worker we did not write may
 * not be touched at all.
 */
describe("what the writer hands this, the reader gets back", () => {
  test("a multi-line sentence is flattened, not dropped — the whole of the #534 regression", () => {
    const encoded = encodeWorkflowStepMessage({
      code: "cloudflare/request_failed",
      message: "Cloudflare request failed: list Turnstile widgets.\n  10000 Authentication error",
      action: "Check the token for Account → Turnstile.",
    });
    expect(encoded.split(WORKFLOW_STEP_SEPARATOR)).toHaveLength(2);
    expect(decodeWorkflowStepMessage(encoded)).toEqual({
      code: "cloudflare/request_failed",
      message: "Cloudflare request failed: list Turnstile widgets. 10000 Authentication error",
      action: "Check the token for Account → Turnstile.",
    });
  });

  test("an action carrying a break is flattened too — the remedy is kept, not spent", () => {
    const encoded = encodeWorkflowStepMessage({ ...FIELDS, action: "Run this.\nThen that." });
    expect(decodeWorkflowStepMessage(encoded)).toEqual({ ...FIELDS, action: "Run this. Then that." });
  });

  test("a half past the bound is truncated, so the code and the remedy still arrive", () => {
    const long = "x".repeat(MAX_WORKFLOW_STEP_TEXT * 2);
    const read = decodeWorkflowStepMessage(encodeWorkflowStepMessage({ ...FIELDS, message: long, action: long }));
    expect(read?.code).toBe(FIELDS.code);
    expect(read?.message).toHaveLength(MAX_WORKFLOW_STEP_TEXT);
    expect(read?.message.endsWith("…")).toBe(true);
    expect(read?.action).toHaveLength(MAX_WORKFLOW_STEP_TEXT);
  });

  test("an empty or whitespace action leaves no trailing separator", () => {
    expect(encodeWorkflowStepMessage({ ...FIELDS, action: "" })).toBe(WIRE.withoutAction);
    expect(encodeWorkflowStepMessage({ ...FIELDS, action: "   " })).toBe(WIRE.withoutAction);
    expect(encodeWorkflowStepMessage({ ...FIELDS, action: undefined })).toBe(WIRE.withoutAction);
  });
});

describe("text this did not write is declined, not reshaped", () => {
  test("no code prefix is no encoding", () => {
    expect(decodeWorkflowStepMessage("kaboom, no code here")).toBeNull();
    // `unclassified` is the code a fault no layer recognizes carries, and it is not a `domain/reason`.
    // So the terminal text for a foreign throw stays unpromotable, exactly as it was before #353.
    expect(decodeWorkflowStepMessage("unclassified: something went wrong")).toBeNull();
  });

  test("an empty sentence is declined", () => {
    expect(decodeWorkflowStepMessage("acme/x: ")).toBeNull();
    expect(decodeWorkflowStepMessage("acme/x: \nUse the other one.")).toBeNull();
  });

  test("a second separator is a shape the encoder never writes", () => {
    expect(decodeWorkflowStepMessage("acme/x: One.\nTwo.\nThree.")).toBeNull();
  });

  test("a stray carriage return is declined on either side", () => {
    expect(decodeWorkflowStepMessage("acme/x: One.\rTwo.")).toBeNull();
    expect(decodeWorkflowStepMessage("acme/x: One.\nTwo.\rThree.")).toBeNull();
  });

  test("either half past the bound is declined rather than truncated", () => {
    const long = "x".repeat(MAX_WORKFLOW_STEP_TEXT + 1);
    const fits = "x".repeat(MAX_WORKFLOW_STEP_TEXT);
    expect(decodeWorkflowStepMessage(`acme/x: ${fits}`)).toEqual({ code: "acme/x", message: fits });
    expect(decodeWorkflowStepMessage(`acme/x: ${long}`)).toBeNull();
    expect(decodeWorkflowStepMessage(`acme/x: Broke.\n${fits}`)).toEqual({
      code: "acme/x",
      message: "Broke.",
      action: fits,
    });
    expect(decodeWorkflowStepMessage(`acme/x: Broke.\n${long}`)).toBeNull();
  });
});

describe("the code grammar has one statement", () => {
  test("a leading domain/reason is split off, and anything else is not a code", () => {
    expect(splitWorkflowStepCode("secrets/already_exists: Gone.")).toEqual({
      code: "secrets/already_exists",
      rest: "Gone.",
    });
    expect(splitWorkflowStepCode("Secret not found.")).toEqual({ rest: "Secret not found." });
    expect(splitWorkflowStepCode("Secrets/Already: Gone.")).toEqual({ rest: "Secrets/Already: Gone." });
  });
});

/**
 * **`params` does not cross this boundary, and that is a decision rather than an oversight.**
 *
 * The channel is one string the engine records off the throw, and its reader is an operator — the CLI's
 * `kitSentence`, and a human in the Cloudflare dashboard at three in the morning. That reader wants the
 * English sentence and the remedy, which is exactly what the encoding carries. `params` exists so a
 * *client* can render a code in its own words from a catalog it holds; no client ever reads a step
 * record, and a serialized record here would either need a second grammar or turn the two readable
 * lines back into JSON — the trade the docblock above already declined.
 *
 * Nothing is lost by dropping them, because `message` is the field they accompany rather than replace:
 * it is English permanently, already carries the interpolated value, and is the fallback every
 * translating client falls back to. So a step's text loses the raw values and keeps the sentence.
 *
 * Asserted rather than assumed, because "it does not survive" is only a fact while somebody is checking.
 */
describe("what a step's text deliberately leaves behind", () => {
  test("params do not cross the boundary; the sentence and the remedy do", () => {
    const thrown = new RateLimitError({
      message: "Too many requests. Try again in 30 seconds.",
      action: "Raise `rateLimit.perMinute` in pithy.config.ts.",
      params: { retryAfter: 30 },
      detail: "bucket auth:otp:192.0.2.1 exhausted",
    });
    const { code, message, action } = thrown.payload;
    const text = encodeWorkflowStepMessage({ code, message, action });
    const read = decodeWorkflowStepMessage(text);

    expect(read).toEqual({
      code: "rate_limit/exceeded",
      message: "Too many requests. Try again in 30 seconds.",
      action: "Raise `rateLimit.perMinute` in pithy.config.ts.",
    });
    expect(Object.hasOwn(read ?? {}, "params")).toBe(false);
    expect(text).not.toContain("retryAfter");
  });
});
