// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { createBackend } from "../createBackend";
import type { WorkflowDispatcher } from "./dispatch";

/**
 * Registration and dispatch against a real Miniflare env. Workflow bindings themselves cannot be
 * emulated — `@cloudflare/vitest-plugin` has no Workflow host — so a job's binding is supplied
 * as a plain object on the request env. What this file proves is everything *around* that: that a
 * declared job derives a required binding, that the derivation runs through the same first-request
 * fail-fast path as D1 and KV, and that `c.var.workflows` is wired on a live request.
 */

const IdParams = z.object({ id: z.string().min(1).describe("The record id.") }).describe("Enrichment params.");

/**
 * Inside a capability's `routes`, `c.var.workflows` is the loose `PithyVars` seam — `unknown`, exactly
 * like `db` and `kv` — because the precise key types depend on which capabilities are composed. A
 * capability narrows it at the use site; this helper is that narrowing, once.
 */
function dispatcher(c: { var: { workflows: unknown } }): WorkflowDispatcher {
  return c.var.workflows as WorkflowDispatcher;
}

/** A Workflow binding that records what it started. */
function fakeWorkflow() {
  const started: unknown[] = [];
  return { started, create: async (options?: { params?: unknown }) => void started.push(options?.params) };
}

describe("workflow registration in createBackend", () => {
  test("a declared job derives a required workflow binding, surfaced by the fail-fast check", async () => {
    const cap = defineCapability({
      name: "email",
      requiredBindings: [],
      workflows: { send: { binding: "EMAIL_SENDER", params: IdParams, className: "EmailSendWorkflow" } },
    });
    const app = createBackend({ capabilities: [cap] });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Missing required bindings: workflow:EMAIL_SENDER/);
  });

  test("an optional job derives an optional binding, so an unprovisioned project still boots", async () => {
    const cap = defineCapability({
      name: "media",
      requiredBindings: [],
      workflows: {
        "image-to-text": {
          binding: "MEDIA_IMAGE_TO_TEXT",
          params: IdParams,
          className: "MediaImageToTextWorkflow",
          optional: true,
        },
      },
    });
    const app = createBackend({ capabilities: [cap] });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
  });

  test("a structurally-derived binding is not masked by an author marking the same one optional", async () => {
    // `dedupeBindings` ANDs `optional`, so a required job wins over a hand-declared optional binding.
    const cap = defineCapability({
      name: "email",
      requiredBindings: [{ type: "workflow", name: "EMAIL_SENDER", optional: true }],
      workflows: { send: { binding: "EMAIL_SENDER", params: IdParams, className: "EmailSendWorkflow" } },
    });
    const app = createBackend({ capabilities: [cap] });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/workflow:EMAIL_SENDER/);
  });

  test("c.var.workflows dispatches on a live request", async () => {
    const binding = fakeWorkflow();
    const cap = defineCapability({
      name: "media",
      requiredBindings: [],
      workflows: {
        "image-to-text": { binding: "MEDIA_IMAGE_TO_TEXT", params: IdParams, className: "MediaImageToTextWorkflow" },
      },
      routes: (a) => {
        a.post("/enrich", async (c) => {
          await dispatcher(c).trigger("media/image-to-text", { id: "m1" });
          return c.json({ dispatched: true });
        });
      },
    });
    const app = createBackend({ capabilities: [cap] });
    const res = await app.request("/enrich", { method: "POST" }, { ...env, MEDIA_IMAGE_TO_TEXT: binding });
    expect(res.status).toBe(200);
    expect(binding.started).toEqual([{ id: "m1" }]);
  });

  test("bad params become a 400 through the standard error handler, with no detail on the wire", async () => {
    const binding = fakeWorkflow();
    const cap = defineCapability({
      name: "media",
      requiredBindings: [],
      workflows: {
        "image-to-text": { binding: "MEDIA_IMAGE_TO_TEXT", params: IdParams, className: "MediaImageToTextWorkflow" },
      },
      routes: (a) => {
        a.post("/enrich", async (c) => {
          await dispatcher(c).trigger("media/image-to-text", { id: "" });
          return c.json({ dispatched: true });
        });
      },
    });
    const app = createBackend({ capabilities: [cap] });
    const res = await app.request("/enrich", { method: "POST" }, { ...env, MEDIA_IMAGE_TO_TEXT: binding });
    expect(res.status).toBe(400);

    const body = await res.json<{ error: { code: string; detail?: string } }>();
    expect(body.error.code).toBe("core/invalid_workflow_params");
    // The HTTP codec is the one security boundary: throw-site context never reaches a client.
    expect(body.error.detail).toBeUndefined();
    expect(binding.started).toEqual([]);
  });

  test("jobs from several capabilities share one registry", async () => {
    const sender = fakeWorkflow();
    const sweeper = fakeWorkflow();
    const email = defineCapability({
      name: "email",
      requiredBindings: [],
      workflows: { send: { binding: "EMAIL_SENDER", params: IdParams, className: "EmailSendWorkflow" } },
    });
    const storage = defineCapability({
      name: "storage",
      requiredBindings: [],
      workflows: { sweep: { binding: "STORAGE_SWEEP", params: IdParams, className: "StorageSweepWorkflow" } },
      routes: (a) => {
        a.post("/both", async (c) => {
          await dispatcher(c).trigger("email/send", { id: "j1" });
          await dispatcher(c).trigger("storage/sweep", { id: "s1" });
          return c.json({ ok: true });
        });
      },
    });
    const app = createBackend({ capabilities: [email, storage] });
    const res = await app.request(
      "/both",
      { method: "POST" },
      { ...env, EMAIL_SENDER: sender, STORAGE_SWEEP: sweeper },
    );
    expect(res.status).toBe(200);
    expect(sender.started).toEqual([{ id: "j1" }]);
    expect(sweeper.started).toEqual([{ id: "s1" }]);
  });
});
