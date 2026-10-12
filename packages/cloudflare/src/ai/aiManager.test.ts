// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiRunPath, CloudflareAIManager, ImageToText, TextGeneration, VectorEmbeddings } from "./aiManager";

/** The SDK's raw `post`, which `runModel` calls with the path it built. Answers the REST envelope. */
const mockPost = vi.fn();
/** What the model answers, by model name and body — the envelope's `result`, for the typed helpers' tests. */
const mockAiRun = vi.fn();
const mockModelsList = vi.fn();
/** The SDK's own `ai.run`, which percent-encodes the model's `/`. Asserted never to be called. */
const mockSdkRun = vi.fn();

const RUN_PREFIX = "/accounts/acct-1/ai/run/";

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    ai = {
      run: mockSdkRun,
      models: { list: mockModelsList },
    };
    post = mockPost;
  },
}));

describe("CloudflareAIManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareAIManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockImplementation(async (path: string, options: { body: Record<string, unknown> }) => ({
      success: true,
      result: await mockAiRun(path.slice(RUN_PREFIX.length), options.body),
    }));
    manager = new CloudflareAIManager(config);
  });

  describe("constructor and info", () => {
    it("reports its service type", () => {
      expect(manager.getServiceType()).toBe("Workers AI");
    });

    it("throws a configured PithyError when apiToken is missing (base guard)", () => {
      expect(() => new CloudflareAIManager({ accountId: "a", apiToken: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("aiRunPath", () => {
    // The SDK's `ai.run` builds this path with its `path` tag, which percent-encodes every `/` in the
    // model name: `/ai/run/@cf%2Fbaai%2Fbge-m3`. Cloudflare routes on the literal slashes and answers
    // 7000 "No route for that URI" to the encoded one, for every model (#709).
    it("keeps the model name's slashes literal", () => {
      expect(aiRunPath("acct-1", "@cf/baai/bge-m3")).toBe("/accounts/acct-1/ai/run/@cf/baai/bge-m3");
      expect(aiRunPath("acct-1", "@cf/llava-hf/llava-1.5-7b-hf")).toBe(
        "/accounts/acct-1/ai/run/@cf/llava-hf/llava-1.5-7b-hf",
      );
      expect(aiRunPath("acct-1", "@hf/thebloke/deepseek-coder-6.7b-instruct-awq")).toBe(
        "/accounts/acct-1/ai/run/@hf/thebloke/deepseek-coder-6.7b-instruct-awq",
      );
    });

    it("accepts every default model this manager runs", () => {
      for (const model of [
        "@cf/meta/llama-4-scout-17b-16e-instruct",
        "@cf/meta/llama-3.1-8b-instruct",
        "@cf/baai/bge-small-en-v1.5",
      ]) {
        expect(aiRunPath("acct-1", model)).toBe(`${RUN_PREFIX}${model}`);
      }
    });

    // The name goes into the path unencoded, so the pattern is the whole of the defense: nothing that
    // could walk the path, end it, or add a query reaches a request.
    it.each([
      ["an empty name", ""],
      ["no @ prefix", "cf/meta/llama"],
      ["no namespace segment", "@cf"],
      ["a parent segment", "@cf/../../tokens"],
      ["a dot segment", "@cf/./x"],
      ["a segment that starts with a dot", "@cf/meta/.hidden"],
      ["an empty segment", "@cf//x"],
      ["a trailing slash", "@cf/meta/"],
      ["a query", "@cf/meta/llama?x=1"],
      ["a fragment", "@cf/meta/llama#x"],
      ["a percent escape", "@cf/meta%2Fllama"],
      ["a space", "@cf/meta/lla ma"],
      ["a backslash", "@cf/meta\\llama"],
      ["a newline", "@cf/meta/llama\n"],
      ["an absolute URL", "https://example.com/x"],
    ])("refuses %s before building a path", (_label, model) => {
      expect(() => aiRunPath("acct-1", model)).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
      );
    });

    it("encodes the account id", () => {
      expect(aiRunPath("a/b", "@cf/x/y")).toBe("/accounts/a%2Fb/ai/run/@cf/x/y");
    });
  });

  describe("runModel", () => {
    it("posts the input to the literal model path and returns the envelope's result", async () => {
      mockPost.mockResolvedValue({ success: true, result: { response: "ok" } });
      const result = await manager.runModel("@cf/some/model", { text: "hi" });
      expect(mockPost).toHaveBeenCalledWith("/accounts/acct-1/ai/run/@cf/some/model", { body: { text: "hi" } });
      expect(mockSdkRun).not.toHaveBeenCalled();
      expect(result).toEqual({ response: "ok" });
    });

    it("refuses a malformed model name without sending anything", async () => {
      await expect(manager.runModel("@cf/../x", { text: "hi" })).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
      );
      expect(mockPost).not.toHaveBeenCalled();
    });

    it("wraps an SDK failure as cloudflare/request_failed with the cause kept in detail", async () => {
      mockAiRun.mockRejectedValue(new Error("model offline"));
      await expect(manager.runModel("@cf/x/m", {})).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "model offline" }),
        }),
      );
    });
  });

  describe("generateText", () => {
    it("runs the default text model with messages and returns the validated payload", async () => {
      mockAiRun.mockResolvedValue({ response: "Generated text" });
      const messages = [{ role: "user" as const, content: "Hello" }];
      const result = await manager.generateText(messages);
      expect(mockAiRun).toHaveBeenCalledWith(expect.stringContaining("llama"), expect.objectContaining({ messages }));
      expect(result.response).toBe("Generated text");
    });

    it("passes max_tokens and an overridden model when provided", async () => {
      mockAiRun.mockResolvedValue({ response: "short" });
      const messages = [{ role: "user" as const, content: "test" }];
      await manager.generateText(messages, { model: "@cf/custom/text", maxTokens: 100 });
      expect(mockAiRun).toHaveBeenCalledWith("@cf/custom/text", expect.objectContaining({ max_tokens: 100, messages }));
    });

    it("throws cloudflare/invalid_response when the payload has no response field", async () => {
      mockAiRun.mockResolvedValue({ unexpected: true });
      await expect(manager.generateText([{ role: "user", content: "x" }])).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockAiRun.mockRejectedValue(new Error("Model not available"));
      await expect(manager.generateText([{ role: "user", content: "x" }])).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("generateEmbeddings", () => {
    it("runs the default embedding model for a single text and returns the validated payload", async () => {
      const embeddings = { shape: [1, 1024], data: [[0.1, 0.2, 0.3]] };
      mockAiRun.mockResolvedValue(embeddings);
      const result = await manager.generateEmbeddings("some content");
      expect(mockAiRun).toHaveBeenCalledWith(
        expect.stringContaining("bge-m3"),
        expect.objectContaining({ text: "some content" }),
      );
      expect(result).toEqual(embeddings);
    });

    it("accepts a batch of texts and an overridden model", async () => {
      const embeddings = { shape: [2, 768], data: [[0.1], [0.2]] };
      mockAiRun.mockResolvedValue(embeddings);
      const result = await manager.generateEmbeddings(["a", "b"], "@cf/custom-embed");
      expect(mockAiRun).toHaveBeenCalledWith("@cf/custom-embed", expect.objectContaining({ text: ["a", "b"] }));
      expect(result).toEqual(embeddings);
    });

    it("throws cloudflare/invalid_response on a malformed embeddings payload", async () => {
      mockAiRun.mockResolvedValue({ shape: "nope" });
      await expect(manager.generateEmbeddings("content")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockAiRun.mockRejectedValue(new Error("Embedding failed"));
      await expect(manager.generateEmbeddings("content")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("analyzeImage", () => {
    it("base64-encodes the bytes and runs the default vision model", async () => {
      mockAiRun.mockResolvedValue({ description: "A cat on a mat" });
      const result = await manager.analyzeImage(new Uint8Array([1, 2, 3]));
      expect(mockAiRun).toHaveBeenCalledWith(
        expect.stringContaining("llava"),
        expect.objectContaining({
          image: expect.any(String),
          prompt: expect.stringContaining("alt text"),
        }),
      );
      expect(result.description).toBe("A cat on a mat");
    });

    it("passes a custom prompt, model, and max_tokens", async () => {
      mockAiRun.mockResolvedValue({ description: "caption" });
      await manager.analyzeImage(new Uint8Array([1]), {
        model: "@cf/vision/caption",
        prompt: "Caption this",
        maxTokens: 512,
      });
      expect(mockAiRun).toHaveBeenCalledWith(
        "@cf/vision/caption",
        expect.objectContaining({ prompt: "Caption this", max_tokens: 512 }),
      );
    });

    it("throws cloudflare/invalid_response when description is absent", async () => {
      mockAiRun.mockResolvedValue({});
      await expect(manager.analyzeImage(new Uint8Array([1]))).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });
  });

  describe("listModels", () => {
    it("returns the model array", async () => {
      const models = [{ id: "model-1", name: "Test Model" }];
      mockModelsList.mockResolvedValue({ result: models });
      expect(await manager.listModels()).toEqual(models);
      expect(mockModelsList).toHaveBeenCalledWith({ account_id: "acct-1" });
    });

    it("returns an empty array when result is not an array", async () => {
      mockModelsList.mockResolvedValue({ result: null });
      expect(await manager.listModels()).toEqual([]);
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockModelsList.mockRejectedValue(new Error("Unauthorized"));
      await expect(manager.listModels()).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when models are available", async () => {
      mockModelsList.mockResolvedValue({ result: [{ id: "m1" }] });
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false when validation fails", async () => {
      mockModelsList.mockRejectedValue(new Error("Unauthorized"));
      expect(await manager.validateServiceAccess()).toBe(false);
    });

    it("returns false when no models are present", async () => {
      mockModelsList.mockResolvedValue({ result: [] });
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  it("only ever throws PithyError from public methods", async () => {
    mockAiRun.mockRejectedValue("a bare string, not an Error");
    await expect(manager.generateText([{ role: "user", content: "x" }])).rejects.toBeInstanceOf(PithyError);
  });

  describe("schema round-trips", () => {
    it("round-trips VectorEmbeddings through parse", () => {
      const value = { shape: [1, 3], data: [[0.1, 0.2, 0.3]] };
      expect(VectorEmbeddings.parse(value)).toEqual(value);
    });

    it("rejects a VectorEmbeddings payload with a non-numeric vector", () => {
      expect(VectorEmbeddings.safeParse({ shape: [1], data: [["x"]] }).success).toBe(false);
    });

    it("round-trips TextGeneration and ImageToText through parse", () => {
      expect(TextGeneration.parse({ response: "hi" })).toEqual({ response: "hi" });

      // Workers AI returns two envelopes and which one depends on the model. The default
      // (`llama-4-scout`) returns the OpenAI chat-completion shape with no top-level `response`,
      // which is what broke `generateText` live — both must normalize to the same result.
      expect(TextGeneration.parse({ choices: [{ message: { content: "hi" } }] })).toEqual({ response: "hi" });

      // A flat envelope wins when a model sends both, so behavior does not depend on union order.
      expect(TextGeneration.parse({ response: "flat", choices: [{ message: { content: "nested" } }] })).toEqual({
        response: "flat",
      });

      // Neither shape present is still a decode failure — normalizing must not become "accept anything".
      expect(TextGeneration.safeParse({ text: "hi" }).success).toBe(false);
      expect(TextGeneration.safeParse({ choices: [] }).success).toBe(false);
      expect(TextGeneration.safeParse({ choices: [{ message: {} }] }).success).toBe(false);
      expect(ImageToText.parse({ description: "a photo" })).toEqual({ description: "a photo" });
    });
  });
});
