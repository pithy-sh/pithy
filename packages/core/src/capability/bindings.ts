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
    z
      .literal("durable_object")
      .describe(
        "Durable Object — a single-threaded, stateful actor with its own storage. Backed by an exported DO class; the CLI wires the namespace binding and the class migration tag.",
      ),
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
    className: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The exported Durable Object class this namespace is backed by (e.g. "MultiplayerSession"). Meaningful only for a `durable_object` binding — it is the `class_name` the CLI writes into `durable_objects.bindings` and the DO class migration tag. Ignored for every other kind.',
      ),
    service: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The Worker this binding calls, named as it appears in `apps/<name>/` (e.g. "api"). Meaningful only for a `service` binding — the CLI resolves it to that Worker\'s environment-scoped script name when writing `services` into wrangler.jsonc, so worker-to-worker RPC targets the right deployment per environment. Ignored for every other kind.',
      ),
    remote: z
      .boolean()
      .optional()
      .describe(
        "Reach the real Cloudflare resource during local development instead of a local emulation. Set it for a binding that has none — Vectorize and Workers AI both lack local simulation — so `wrangler dev` and any Workflow host, which always runs locally, still work. Left unset rather than defaulting to false, so a spec that does not care emits no flag at all. Ignored in a deployed Worker.",
      ),
  })
  .describe("Declares a Cloudflare binding a capability requires in the Worker env.")
  .check((ctx) => {
    // A durable_object binding is inert without the class that backs it — the CLI would emit a
    // `durable_objects.bindings` entry with no `class_name`, which wrangler rejects. Fail here, at
    // define/manifest-parse time, attributed to the capability, rather than deep in the writer.
    if (ctx.value.type === "durable_object" && ctx.value.className === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["className"],
        message: `Durable Object binding "${ctx.value.name}" needs a className — the exported DO class it is backed by.`,
      });
    }
    // A service binding with no target is unresolvable: the CLI cannot know which Worker to point
    // `services[].service` at, and wrangler rejects the entry. Fail at define time, attributed to the
    // capability, rather than emitting a broken binding into an environment's wrangler.jsonc.
    if (ctx.value.type === "service" && ctx.value.service === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["service"],
        message: `Service binding "${ctx.value.name}" needs a service — the Worker it calls, as named in apps/.`,
      });
    }
  });
export type BindingSpec = z.infer<typeof BindingSpec>;

/** Authoring shape for a capability's `requiredBindings`: `optional` may be omitted. */
export type BindingSpecInput = z.input<typeof BindingSpec>;
