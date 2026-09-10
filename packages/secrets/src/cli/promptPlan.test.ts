// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SecretInvalidValueError } from "../error/errors";
import type { SecretRegistryEntry } from "../registry";
import {
  assembleSecretValue,
  fieldKey,
  promptedFields,
  secretFieldLines,
  secretPromptPlan,
  unaskableSecretFields,
  undeclaredLineFields,
} from "./promptPlan";
import { validateSecretValue } from "./validate";

/**
 * One string leaf that has said it fits on a terminal line — the declaration every leaf of a `json`
 * secret carries, spelled once here because these fixtures are the schemas in miniature.
 */
const line = (description: string) => z.string().min(1).meta({ multiline: false }).describe(description);

/** A flat credential pair — the shape of `auth-google-credentials`. */
const Flat = z
  .object({
    clientId: line("The client id."),
    clientSecret: line("The client secret."),
  })
  .describe("A credential pair.");

/** Two independent optional blocks — the shape of `payments-provider-credentials`. */
const Branched = z
  .strictObject({
    stripe: z
      .object({
        secretKey: line("The Stripe secret key."),
        webhookSecret: line("The Stripe webhook signing secret."),
      })
      .describe("Stripe's credentials.")
      .optional(),
    paddle: z
      .object({
        apiKey: line("The Paddle API key."),
        webhookSecret: line("The Paddle notification secret."),
      })
      .describe("Paddle's credentials.")
      .optional(),
    apple: z
      .object({ issuerId: line("The App Store issuer id.") })
      .describe("Apple's credentials.")
      .optional(),
  })
  .describe("Every enabled rail's credentials.");

function entry(schema: z.ZodType): SecretRegistryEntry {
  return { backend: "d1", scope: "environment", rotatable: false, valueType: "json", schema };
}

const TEXT: SecretRegistryEntry = { backend: "d1", scope: "environment", rotatable: false, valueType: "text" };

/** A plan, or a failure that says which case stopped planning rather than a null-pointer three lines on. */
function requirePlan(plan: ReturnType<typeof secretPromptPlan>): NonNullable<ReturnType<typeof secretPromptPlan>> {
  if (!plan) throw new Error("expected a plan, got the single-prompt fallback");
  return plan;
}

describe("secretPromptPlan", () => {
  test("a flat json secret asks for every field, with its own description", () => {
    const plan = secretPromptPlan(entry(Flat));
    expect(plan?.branches).toEqual([]);
    expect(plan?.fields.map((field) => [fieldKey(field), field.description])).toEqual([
      ["clientId", "The client id."],
      ["clientSecret", "The client secret."],
    ]);
  });

  test("a flat secret needs no declaration, and a declaration for one is a disagreement", () => {
    expect(secretPromptPlan(entry(Flat), [])).not.toBeNull();
    expect(secretPromptPlan(entry(Flat), ["stripe"])).toBeNull();
  });

  test("one configured branch is planned alone — there is nothing to choose between", () => {
    const plan = requirePlan(secretPromptPlan(entry(Branched), ["paddle"]));
    expect(plan.branches.map((branch) => branch.key)).toEqual(["paddle"]);
    expect(plan.branches[0]?.description).toBe("Paddle's credentials.");
    expect(promptedFields(plan, ["paddle"]).map(fieldKey)).toEqual(["paddle.apiKey", "paddle.webhookSecret"]);
  });

  test("only the configured branches are offered — an unconfigured one is not in the plan at all", () => {
    const plan = requirePlan(secretPromptPlan(entry(Branched), ["stripe", "paddle"]));
    expect(plan.branches.map((branch) => branch.key)).toEqual(["stripe", "paddle"]);
    expect(promptedFields(plan, ["stripe", "paddle"]).map(fieldKey)).not.toContain("apple.issuerId");
  });

  test("branches are offered in schema order, however the capability listed them", () => {
    const plan = secretPromptPlan(entry(Branched), ["apple", "stripe"]);
    expect(plan?.branches.map((branch) => branch.key)).toEqual(["stripe", "apple"]);
  });

  test("a branched schema with no declaration falls back — nothing knows which blocks are real", () => {
    expect(secretPromptPlan(entry(Branched))).toBeNull();
  });

  test("a declaration naming a key the schema does not have falls back", () => {
    expect(secretPromptPlan(entry(Branched), ["stripe", "amazon"])).toBeNull();
  });

  test("no configured branch and no root leaf leaves nothing to ask for", () => {
    expect(secretPromptPlan(entry(Branched), [])).toBeNull();
  });

  test("a shape a masked prompt cannot ask for falls back rather than guessing", () => {
    const union = z.union([z.string(), z.number()]).describe("Either.");
    expect(secretPromptPlan(entry(z.object({ mode: union }).describe("o")))).toBeNull();
    expect(secretPromptPlan(entry(z.record(z.string(), z.string()).describe("r")))).toBeNull();
    expect(secretPromptPlan(entry(z.array(Flat).describe("a")))).toBeNull();
    expect(secretPromptPlan(entry(z.object({ port: z.number().describe("p") }).describe("o")))).toBeNull();
    // A required block is not a branch: nothing chooses it, and this module does not decide for it.
    expect(secretPromptPlan(entry(z.object({ stripe: Flat.describe("s") }).describe("o")), ["stripe"])).toBeNull();
    expect(secretPromptPlan(TEXT)).toBeNull();
  });
});

/**
 * **A leaf is asked for one line at a time only once somebody has said it fits on one.**
 *
 * A masked prompt truncates a pasted `.p8` to a single line — measured under a real pty in
 * `@pithy-sh/cli`'s `capabilities/secretPrompt.pty.test.ts` — and the fragment satisfies
 * `z.string().min(1)`, so the corrupt bundle passes the gate and nothing surfaces until a signature
 * check fails. So `multi` refuses the plan, and **so does silence**: the polarity is opt-in, because the
 * prompt-side backstop the opt-out version leaned on ("an answer that arrived with a newline") cannot
 * fire. These hold both refusals, and hold that they are narrow: a Stripe-only project still gets its
 * questions even though Apple's PEM is in the same schema.
 */
describe("a field that may not be asked for one line at a time", () => {
  const WithPem = z
    .strictObject({
      stripe: z
        .object({ secretKey: line("The Stripe secret key.") })
        .describe("Stripe's credentials.")
        .optional(),
      apple: z
        .object({
          keyId: line("The key id."),
          privateKey: z.string().min(1).describe("The `.p8` file's contents.").meta({ multiline: true }),
        })
        .describe("Apple's credentials.")
        .optional(),
    })
    .describe("Every enabled rail's credentials.");

  test("is read through the wrapper chain, in either order with .describe()", () => {
    expect(secretFieldLines(z.string().meta({ multiline: true }).describe("d"))).toBe("multi");
    expect(secretFieldLines(z.string().describe("d").meta({ multiline: true }))).toBe("multi");
    expect(secretFieldLines(z.string().describe("d").meta({ multiline: true }).optional())).toBe("multi");
    expect(secretFieldLines(z.string().describe("d").meta({ multiline: false }))).toBe("single");
  });

  /**
   * **Silence is the third answer, and it is not `single`.** Two rounds of review read it as safe on the
   * strength of a prompt-side newline check that can never fire, and an unmarked PEM was asked for and
   * truncated. Nothing infers a shape from what nobody said.
   */
  test("that has said nothing is not asked for, and is not read as single-line", () => {
    expect(secretFieldLines(z.string().min(1).describe("d"))).toBeUndefined();
    // Anything but a boolean is silence too — a typo is reported by the repo-wide sweep, by name.
    expect(secretFieldLines(z.string().describe("d").meta({ multiline: "yes" }))).toBeUndefined();
    const Unmarked = z
      .object({ clientId: line("The client id."), clientSecret: z.string().min(1).describe("The client secret.") })
      .describe("A pair.");
    expect(secretPromptPlan(entry(Unmarked))).toBeNull();
    expect(unaskableSecretFields(entry(Unmarked))).toEqual([
      { key: "clientSecret", reason: "does not say whether it spans lines" },
    ]);
  });

  /** The sweep's own walk: deeper than the planner's, so nothing is exempt by depth. */
  test("is reported wherever it sits, including under a container the planner refuses", () => {
    expect(undeclaredLineFields(Branched, "value")).toEqual([]);
    const nested = z
      .object({ tenants: z.array(z.object({ token: z.string().describe("A token.") }).describe("o")) })
      .describe("o");
    expect(undeclaredLineFields(nested, "value")).toEqual(["value.tenants[array].token"]);
    const keyed = z.object({ keys: z.record(z.string(), z.string().describe("A key.")) }).describe("o");
    expect(undeclaredLineFields(keyed, "value")).toEqual(["value.keys[value]"]);
  });

  test("keeps its .describe() — the marker is added to the metadata, not instead of it", () => {
    expect(z.string().describe("The `.p8` file's contents.").meta({ multiline: true }).description).toBe(
      "The `.p8` file's contents.",
    );
  });

  test("refuses the whole plan when the block holding it is configured", () => {
    expect(secretPromptPlan(entry(WithPem), ["apple"])).toBeNull();
    expect(secretPromptPlan(entry(WithPem), ["stripe", "apple"])).toBeNull();
  });

  test("at the root refuses the plan outright", () => {
    const flatPem = z
      .object({ privateKey: z.string().min(1).describe("A key.").meta({ multiline: true }) })
      .describe("o");
    expect(secretPromptPlan(entry(flatPem))).toBeNull();
  });

  test("does not refuse on behalf of a block this project does not run", () => {
    const plan = requirePlan(secretPromptPlan(entry(WithPem), ["stripe"]));
    expect(promptedFields(plan, ["stripe"]).map(fieldKey)).toEqual(["stripe.secretKey"]);
  });

  test("is named, so the fallback has a reason rather than looking like a fault", () => {
    expect(unaskableSecretFields(entry(WithPem), ["stripe", "apple"])).toEqual([
      { key: "apple.privateKey", reason: "spans lines" },
    ]);
    // Blamed only where it is configured: a Stripe-only project is not told about Apple's key.
    expect(unaskableSecretFields(entry(WithPem), ["stripe"])).toEqual([]);
    expect(unaskableSecretFields(entry(Branched), ["stripe", "paddle"])).toEqual([]);
  });
});

describe("assembleSecretValue", () => {
  test("an unchosen branch is absent entirely, never an empty block", () => {
    const plan = requirePlan(secretPromptPlan(entry(Branched), ["stripe", "paddle"]));
    const value = assembleSecretValue(plan, ["paddle"], {
      "paddle.apiKey": "pdl_live_apikey_1",
      "paddle.webhookSecret": "pdl_ntfset_1",
    });
    expect(JSON.parse(value)).toEqual({ paddle: { apiKey: "pdl_live_apikey_1", webhookSecret: "pdl_ntfset_1" } });
    expect(value).not.toContain("stripe");
  });

  test("an empty answer is not a value", () => {
    const optional = z
      .object({
        clientId: line("The client id."),
        note: z.string().meta({ multiline: false }).optional().describe("An optional note."),
      })
      .describe("A pair.");
    const plan = requirePlan(secretPromptPlan(entry(optional)));
    expect(JSON.parse(assembleSecretValue(plan, [], { clientId: "abc", note: "" }))).toEqual({ clientId: "abc" });
  });

  test("what it assembles goes through the one parse gate, unchanged", () => {
    const plan = requirePlan(secretPromptPlan(entry(Branched), ["stripe"]));
    const value = assembleSecretValue(plan, ["stripe"], {
      "stripe.secretKey": "sk_live_1",
      "stripe.webhookSecret": "whsec_1",
    });
    expect(JSON.parse(validateSecretValue(entry(Branched), "payments-provider-credentials", value))).toEqual({
      stripe: { secretKey: "sk_live_1", webhookSecret: "whsec_1" },
    });
  });

  test("a field left empty fails the gate, and the failure names that field", () => {
    const plan = requirePlan(secretPromptPlan(entry(Branched), ["stripe"]));
    const value = assembleSecretValue(plan, ["stripe"], {
      "stripe.secretKey": "sk_live_1",
      "stripe.webhookSecret": "",
    });
    const error = (() => {
      try {
        validateSecretValue(entry(Branched), "payments-provider-credentials", value);
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(SecretInvalidValueError);
    // The field, by the same dotted path the prompt asked under — and never the value beside it.
    const payload = (error as SecretInvalidValueError).payload;
    expect(payload.detail).toContain("stripe.webhookSecret");
    // **On `message`, which is the only reason the operator ever reads it.** `renderTerminal` prints
    // `message` and `action`; `detail` is the throw site's and reaches no surface at all. Six masked
    // prompts and a refusal that named only the secret is a run started again from the first question.
    expect(payload.message).toContain("stripe.webhookSecret");
    expect(JSON.stringify(payload)).not.toContain("sk_live_1");
  });
});
