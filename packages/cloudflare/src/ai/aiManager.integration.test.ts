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

  test("generates text, decoding the { response } payload", async () => {
    const result = await ai.generateText([{ role: "user", content: "Reply with the single word: pithy." }], {
      maxTokens: 16,
    });
    expect(typeof result.response).toBe("string");
    expect(result.response.length).toBeGreaterThan(0);
  });

  test("surfaces an unknown model as a wrapped request failure", async () => {
    await expect(ai.runModel("@cf/does-not/exist", { text: "x" })).rejects.toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
    );
  });
});
