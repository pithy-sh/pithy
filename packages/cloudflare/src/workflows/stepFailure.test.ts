// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CloudflareRequestError } from "../client/errors";
import { kitSentence, stepFailure } from "./stepFailure";
import { CloudflareWorkflowsClient } from "./workflowsClient";

const mockCreate = vi.fn();
const mockGet = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    workflows = { list: vi.fn(), instances: { create: mockCreate, get: mockGet } };
  },
}));

/**
 * **The gate: a platform sentence never reaches the operator in place of the step's** (pithy-sh/pithy#349).
 *
 * The instances below are not written to illustrate the bug — they were *read off the engine that has
 * it*. A Workflow class raising each shape was driven under `wrangler dev` (wrangler 4.123.0, local
 * Workflows engine, 2026-08-14) and the instance detail fetched from the dev session's own instance
 * endpoint. Everything quoted here is verbatim, escaping and grammar included: the engine really does
 * say "threw an NonRetryableError", and the inner text of the envelope really is embedded unquoted, so
 * a message containing a `"` arrives with it raw.
 *
 * The gate drives them through the real client and reads the real `payload.message` — the string the CLI
 * prints. It has three parts, and the last two are what make it able to fail:
 *
 * 1. The sentence is asserted against a **frozen literal** per capture, written down here rather than
 *    computed from `stepFailure`. A gate that asks the code what it produces agrees with the code.
 * 2. Every sentence is put through {@link verdict}, which names it `kit` or `platform` and **throws** on
 *    anything it can name as neither. A capture the corpus grows that produces some third kind of text
 *    fails loudly instead of passing quietly.
 * 3. Every frozen platform sentence is asserted to actually occur in the corpus. A forbidden-string list
 *    nothing ever produces is a green gate policing nothing (#326).
 */

/** Every instance shape captured, by the payload that produced it. The corpus is closed; see below. */
const CAPTURED = {
  /** A terminal step: `classifiedSteps` re-threw `secrets/already_exists` as `NonRetryableError`. */
  terminal: {
    status: "errored",
    output: null,
    error: {
      name: "WorkflowFatalError",
      message:
        "The execution of the Workflow instance was terminated, as a step threw an NonRetryableError and it was not handled",
    },
    steps: [
      {
        name: "write-secret-1",
        type: "step",
        success: false,
        attempts: [
          {
            success: false,
            error: {
              name: "WorkflowFatalError",
              message:
                "Step threw a NonRetryableError with message \"NonRetryableError: secrets/already_exists: Secret 'api-token' already exists.\"",
            },
          },
        ],
      },
    ],
  },
  /** A step that succeeded, then one that failed terminally. The answer is the *last* failed step. */
  twoSteps: {
    status: "errored",
    output: null,
    error: {
      name: "WorkflowFatalError",
      message:
        "The execution of the Workflow instance was terminated, as a step threw an NonRetryableError and it was not handled",
    },
    steps: [
      { name: "resolve-target-1", type: "step", success: true, attempts: [{ success: true, error: null }] },
      {
        name: "write-secret-1",
        type: "step",
        success: false,
        attempts: [
          {
            success: false,
            error: {
              name: "WorkflowFatalError",
              message:
                "Step threw a NonRetryableError with message \"NonRetryableError: secrets/already_exists: Secret 'api-token' already exists.\"",
            },
          },
        ],
      },
    ],
  },
  /** A terminal message containing a double quote — the envelope does not escape it. */
  quoted: {
    status: "errored",
    output: null,
    error: {
      name: "WorkflowFatalError",
      message:
        "The execution of the Workflow instance was terminated, as a step threw an NonRetryableError and it was not handled",
    },
    steps: [
      {
        name: "write-secret-1",
        type: "step",
        success: false,
        attempts: [
          {
            success: false,
            error: {
              name: "WorkflowFatalError",
              message:
                'Step threw a NonRetryableError with message "NonRetryableError: secrets/invalid_value: The value for "api-token" is too long."',
            },
          },
        ],
      },
    ],
  },
  /** A retryable `PithyError`, after the engine spent the retry budget. No envelope, no code. */
  retried: {
    status: "errored",
    output: null,
    error: { name: "Error", message: "PithyError: Secret 'api-token' already exists." },
    steps: [
      {
        name: "write-secret-1",
        type: "step",
        success: false,
        attempts: [
          { success: false, error: { name: "Error", message: "PithyError: Secret 'api-token' already exists." } },
          { success: false, error: { name: "Error", message: "PithyError: Secret 'api-token' already exists." } },
        ],
      },
    ],
  },
  /** A terminal throw carrying no kit code — nothing here is provably ours, so nothing is promoted. */
  foreign: {
    status: "errored",
    output: null,
    error: {
      name: "WorkflowFatalError",
      message:
        "The execution of the Workflow instance was terminated, as a step threw an NonRetryableError and it was not handled",
    },
    steps: [
      {
        name: "write-secret-1",
        type: "step",
        success: false,
        attempts: [
          {
            success: false,
            error: {
              name: "WorkflowFatalError",
              message: 'Step threw a NonRetryableError with message "NonRetryableError: kaboom, no code here"',
            },
          },
        ],
      },
    ],
  },
} as const;

/** The corpus, named. Frozen so a capture cannot be dropped to make a failing gate pass. */
const CAPTURE_NAMES = Object.freeze(["terminal", "twoSteps", "quoted", "retried", "foreign"] as const);

/**
 * Prose the Workflows engine writes itself, captured verbatim. Not derived from `stepFailure` — this is
 * the list the gate polices *with*, and a list computed from the code under test polices nothing.
 */
const PLATFORM_SENTENCES = Object.freeze([
  "The execution of the Workflow instance was terminated, as a step threw an NonRetryableError and it was not handled",
  "Step threw a NonRetryableError with message",
  "WorkflowFatalError",
] as const);

/**
 * The exact line the operator must read, per capture. Literals, written by hand from what each step
 * raised — `foreign` is the client's own fallback, because nothing in that instance is provably ours.
 */
const EXPECTED_SENTENCE: Readonly<Record<(typeof CAPTURE_NAMES)[number], string>> = Object.freeze({
  terminal: "Secret 'api-token' already exists.",
  twoSteps: "Secret 'api-token' already exists.",
  quoted: 'The value for "api-token" is too long.',
  retried: "Secret 'api-token' already exists.",
  foreign: "Workflow secrets-write did not complete (errored).",
});

/**
 * Name a sentence, or refuse to. **Throwing is the point**: a sentence this cannot place is neither
 * proved safe nor proved leaked, and returning "not platform" for it would let an unrecognised shape
 * ride through green. Every string it can name is a literal above.
 */
function verdict(sentence: string): "kit" | "platform" {
  if (PLATFORM_SENTENCES.some((platform) => sentence.includes(platform))) return "platform";
  const named = Object.values(EXPECTED_SENTENCE).includes(sentence);
  if (named) return "kit";
  throw new Error(
    `Unnameable operator sentence — neither a captured platform sentence nor a stated kit one: ${sentence}`,
  );
}

/** The message a real `dispatchAndPoll` hands the operator for one captured instance. */
async function operatorSentence(instance: unknown): Promise<string> {
  mockCreate.mockResolvedValue({ id: "wf-1", status: "queued" });
  mockGet.mockResolvedValue(instance);
  const client = new CloudflareWorkflowsClient({ accountId: "acc", apiToken: "tok", sleeper: async () => {} });
  const error = await client.dispatchAndPoll("secrets-write", { secret: "TOPSECRET" }).catch((e: unknown) => e);
  return (error as CloudflareRequestError).payload.message;
}

describe("the operator reads the step's sentence, not the platform's", () => {
  beforeEach(() => vi.clearAllMocks());

  test("the corpus is exactly the captures the gate names", () => {
    expect(Object.keys(CAPTURED).sort()).toEqual([...CAPTURE_NAMES].sort());
  });

  test("every platform sentence the gate forbids really is in the captured corpus", () => {
    const corpus = JSON.stringify(CAPTURED);
    for (const platform of PLATFORM_SENTENCES) expect(corpus).toContain(platform);
  });

  test("verdict throws on a sentence it cannot name, rather than passing it", () => {
    expect(() => verdict("Something nobody wrote down.")).toThrow(/Unnameable operator sentence/);
    expect(verdict(PLATFORM_SENTENCES[0])).toBe("platform");
  });

  for (const name of CAPTURE_NAMES) {
    test(`${name}: the operator reads the stated sentence, and it is not the platform's`, async () => {
      const sentence = await operatorSentence(CAPTURED[name]);
      expect(sentence).toBe(EXPECTED_SENTENCE[name]);
      expect(verdict(sentence)).toBe("kit");
    });
  }

  test("the raw platform text is still in detail, and the dispatched params never are", async () => {
    mockCreate.mockResolvedValue({ id: "wf-1", status: "queued" });
    mockGet.mockResolvedValue(CAPTURED.terminal);
    const client = new CloudflareWorkflowsClient({ accountId: "acc", apiToken: "tok", sleeper: async () => {} });
    const error = await client.dispatchAndPoll("secrets-write", { secret: "TOPSECRET" }).catch((e: unknown) => e);
    const payload = (error as CloudflareRequestError).payload;
    expect(payload.detail).toContain("Step threw a NonRetryableError");
    expect(payload.detail).toContain("secrets/already_exists");
    expect(payload.detail).toContain("write-secret-1");
    expect(payload.detail).not.toContain("TOPSECRET");
  });
});

describe("kitSentence promotes only text the kit authored as public", () => {
  test("the terminal envelope, unwrapped to its code and its sentence", () => {
    expect(
      kitSentence(
        "Step threw a NonRetryableError with message \"NonRetryableError: secrets/already_exists: Secret 'x' already exists.\"",
      ),
    ).toEqual({ code: "secrets/already_exists", message: "Secret 'x' already exists." });
  });

  test("an adopter's own domain is the same grammar and is promoted too", () => {
    expect(
      kitSentence('Step threw a NonRetryableError with message "NonRetryableError: acme/too_cold: Warm it up."'),
    ).toEqual({ code: "acme/too_cold", message: "Warm it up." });
  });

  test("a bare PithyError is promoted on the strength of its name", () => {
    expect(kitSentence("PithyError: Secret not found.")).toEqual({ message: "Secret not found." });
  });

  test("a terminal throw with no kit code is not promoted — anyone can throw one with anything in it", () => {
    expect(kitSentence('Step threw a NonRetryableError with message "NonRetryableError: kaboom"')).toBeNull();
  });

  test("a throw from outside the kit is not promoted", () => {
    expect(kitSentence("TypeError: undefined is not a function")).toBeNull();
    expect(kitSentence("Instance timed out")).toBeNull();
  });

  test("a sentence carrying a newline is declined — it would forge the CLI's action line", () => {
    expect(kitSentence("PithyError: Broke.\nrm -rf /")).toBeNull();
  });

  test("a sentence past the bound is declined rather than truncated", () => {
    expect(kitSentence(`PithyError: ${"x".repeat(512)}`)).toEqual({ message: "x".repeat(512) });
    expect(kitSentence(`PithyError: ${"x".repeat(513)}`)).toBeNull();
  });
});

describe("stepFailure", () => {
  test("no steps at all — an instance the platform failed on its own", () => {
    expect(stepFailure(undefined)).toBeNull();
    expect(stepFailure([])).toBeNull();
  });

  test("a step shape it cannot parse is skipped, not thrown on", () => {
    expect(stepFailure([{ attempts: "not an array" }, CAPTURED.terminal.steps[0]])?.code).toBe(
      "secrets/already_exists",
    );
  });

  test("a step with no recorded text yields no sentence, and the caller falls back", () => {
    expect(stepFailure([{ name: "sleep-1", type: "sleep", success: false }])).toBeNull();
  });

  test("a sleep-shaped step records its failure on the entry rather than per attempt", () => {
    expect(
      stepFailure([
        { name: "wait-1", type: "waitForEvent", success: false, error: { name: "Error", message: "Timed out" } },
      ]),
    ).toEqual({ step: "wait-1", raw: "Timed out" });
  });
});
