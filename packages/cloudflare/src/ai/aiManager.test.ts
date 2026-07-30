// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareAIManager, ImageToText, TextGeneration, VectorEmbeddings } from "./aiManager";

const mockAiRun = vi.fn();
const mockModelsList = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    ai = {
      run: mockAiRun,
      models: { list: mockModelsList },
    };
  },
}));

describe("CloudflareAIManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareAIManager;

  beforeEach(() => {
    vi.clearAllMocks();
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

  describe("runModel", () => {
    it("injects account_id and spreads the input, returning the raw response", async () => {
      mockAiRun.mockResolvedValue({ response: "ok" });
      const result = await manager.runModel("@cf/some/model", { text: "hi" });
      expect(mockAiRun).toHaveBeenCalledWith("@cf/some/model", { account_id: "acct-1", text: "hi" });
      expect(result).toEqual({ response: "ok" });
    });

    it("wraps an SDK failure as cloudflare/request_failed with the cause kept in detail", async () => {
      mockAiRun.mockRejectedValue(new Error("model offline"));
      await expect(manager.runModel("m", {})).rejects.toThrowError(
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
      expect(mockAiRun).toHaveBeenCalledWith(
        expect.stringContaining("llama"),
        expect.objectContaining({ account_id: "acct-1", messages }),
      );
      expect(result.response).toBe("Generated text");
    });

    it("passes max_tokens and an overridden model when provided", async () => {
      mockAiRun.mockResolvedValue({ response: "short" });
      const messages = [{ role: "user" as const, content: "test" }];
      await manager.generateText(messages, { model: "@cf/custom", maxTokens: 100 });
      expect(mockAiRun).toHaveBeenCalledWith("@cf/custom", expect.objectContaining({ max_tokens: 100, messages }));
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
        expect.objectContaining({ account_id: "acct-1", text: "some content" }),
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
          account_id: "acct-1",
          image: expect.any(String),
          prompt: expect.stringContaining("alt text"),
        }),
      );
      expect(result.description).toBe("A cat on a mat");
    });

    it("passes a custom prompt, model, and max_tokens", async () => {
      mockAiRun.mockResolvedValue({ description: "caption" });
      await manager.analyzeImage(new Uint8Array([1]), {
        model: "@cf/vision",
        prompt: "Caption this",
        maxTokens: 512,
      });
      expect(mockAiRun).toHaveBeenCalledWith(
        "@cf/vision",
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

      // A flat envelope wins when a model sends both, so behaviour does not depend on union order.
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
