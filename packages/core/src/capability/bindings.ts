import { z } from "zod";

export const BindingType = z
  .union([
    z.literal("d1").describe("D1 SQL database (SQLite at the edge)."),
    z.literal("kv").describe("Workers KV — eventually-consistent key/value store."),
    z.literal("r2").describe("R2 bucket — S3-compatible object storage."),
    z.literal("ai").describe("Workers AI — run models on Cloudflare's GPU network."),
    z.literal("vectorize").describe("Vectorize — vector DB for embeddings and similarity search."),
    z.literal("queue").describe("Cloudflare Queue — async message producer/consumer."),
    z.literal("ratelimit").describe("Workers Rate Limiting — per-key request limiting."),
    z.literal("email").describe("Email Sending binding (Cloudflare Email Service)."),
    z.literal("secret").describe("Secret from the Secrets Store, encrypted at rest."),
    z.literal("workflow").describe("Cloudflare Workflow — durable, multi-step execution."),
    z.literal("service").describe("Service binding — direct RPC to another Worker."),
  ])
  .describe("Kind of Cloudflare resource a binding refers to.");
export type BindingType = z.infer<typeof BindingType>;

/**
 * Declares a Cloudflare binding a capability requires in the Worker env. The authoring
 * shape lets `optional` be omitted (defaults false); `createBackend` normalizes via parse.
 */
export const BindingSpec = z
  .object({
    type: BindingType.describe("Resource kind this binding provides."),
    name: z.string().min(1).describe('Binding name expected in the Worker env (e.g. "DB", "SESSIONS").'),
    optional: z.boolean().default(false).describe("If true, createBackend won't fail when this binding is absent."),
  })
  .describe("Declares a Cloudflare binding a capability requires in the Worker env.");
export type BindingSpec = z.infer<typeof BindingSpec>;

/** Authoring shape for a capability's `requiredBindings`: `optional` may be omitted. */
export type BindingSpecInput = z.input<typeof BindingSpec>;
