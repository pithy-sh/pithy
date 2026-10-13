// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadIntegrationCreds } from "../test-utils/harness";
import { CloudflareAIManager } from "./aiManager";

/**
 * LIVE integration test — Workers AI inference over REST. Stateless: there is no resource to create
 * or tear down, so no `withThrowawayResource` — each call runs a model and asserts the decoded shape.
 * Requires Workers AI on the account (paid plan); skipped without creds. See
 * `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();

describe.skipIf(!creds.hasCreds)("CloudflareAIManager — LIVE", () => {
  const ai = new CloudflareAIManager({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("lists models and proves access", async () => {
    expect(await ai.validateServiceAccess()).toBe(true);
    expect((await ai.listModels()).length).toBeGreaterThan(0);
  });

  test("generates embeddings, decoding the { shape, data } payload", async () => {
    const result = await ai.generateEmbeddings("the saffron stack");
    expect(result.shape[0]).toBe(1); // one input → one vector
    expect(result.data[0]?.length).toBeGreaterThan(0);
    expect(typeof result.data[0]?.[0]).toBe("number");
  });

  test("generates text, normalizing whichever envelope the model returns", async () => {
    const result = await ai.generateText([{ role: "user", content: "Reply with the single word: pithy." }], {
      maxTokens: 16,
    });
    expect(typeof result.response).toBe("string");
    expect(result.response.length).toBeGreaterThan(0);
  });

  test("both live envelopes normalize — the default model and a flat-envelope one", async () => {
    // The regression this guards: Workers AI moved its newer models to the OpenAI chat-completion
    // shape, and the default (`llama-4-scout`) stopped carrying a top-level `response` entirely. A
    // test that exercised only one model would have gone on passing while the other broke, which is
    // exactly what happened. Naming both models pins both arms of the union against the live service.
    const prompt = [{ role: "user" as const, content: "Reply with the single word: ok" }];
    for (const model of ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/meta/llama-3.1-8b-instruct"]) {
      const result = await ai.generateText(prompt, { model, maxTokens: 16 });
      expect(result.response.length, `model ${model} returned no text`).toBeGreaterThan(0);
    }
  });

  test("surfaces an unknown model as a wrapped request failure", async () => {
    const model = "@cf/does-not/exist";
    const error = await ai.runModel(model, { text: "x" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "cloudflare/request_failed",
          message: expect.stringContaining(`AI run model '${model}'`),
        }),
      }),
    );
    // Cloudflare's own answer rides through the wrapper as `params`, and the live account answers an unknown
    // model on a well-formed path with 7000 — the same code the router gave every model while the path was
    // percent-encoded (#709, run 38323817975). So this test cannot tell the two apart, and does not try: the
    // path is proven well-formed by the real-model tests above succeeding and by `aiRunPath`'s unit test.
    const params = (error as { payload?: { params?: { apiCode?: unknown; apiMessage?: unknown } } }).payload?.params;
    expect(params?.apiCode, `Cloudflare answered ${JSON.stringify(params)}`).toBe(7000);
  });
});
