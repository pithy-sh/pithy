// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { NAME_SEGMENT } from "../naming/segment";

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
 * Whether a provision command creates the **resource** behind this kind of binding, rather than the
 * adopter standing it up themselves.
 *
 * The three are the ones whose resource exists only after `pithy <capability> provision`: a `secret` is a
 * Secrets Store entry (a `.dev.vars` string in local dev), a `workflow` runs in a deployed host Worker,
 * and a `vectorize` binding addresses a provisioned index. `pithy add` says so in a note, at the moment
 * the adopter is thinking about the capability.
 *
 * **This is not the same question as "did anything write the stanza".** Collapsing the two is what left
 * `workflow:EMAIL_SENDER` unwritten and every route answering 500 (#258): the entry is derivable offline
 * even though the Workflow it names is not deployed yet, so {@link isWrittenBinding} writes it and this
 * one still reports that provisioning is what makes it work. A binding can be in both sets, and the
 * Workflow is.
 *
 * `service` is not here. Its entry is also written for the adopter — by `pithy feature`, out of the
 * target Worker's env-scoped script name — but it is wiring between an app's own Workers rather than a
 * capability's provisioned resource, and no shipped capability declares one.
 */
export function isProvisionedBinding(type: BindingType): boolean {
  return type === "secret" || type === "workflow" || type === "vectorize";
}

/**
 * Whether `pithy add` writes this kind's `wrangler.jsonc` entry, offline, at the moment it composes the
 * capability.
 *
 * Together with {@link isProvisionedBinding} this is the whole answer to "where does this binding come
 * from" — the invariant `capabilities/requiredBindings.test.ts` states. A kind in **neither** set is a
 * binding a capability requires and nothing supplies: the composition refuses to assemble, the error
 * names the binding, and no command anywhere fixes it. `ratelimit` was exactly that, which is why a
 * scaffolded project composing `auth` answered 500 on every route including `/health` (#258).
 *
 * Membership turns on one question only: **is every field wrangler requires derivable offline?** A rate
 * limiter's are — the stanza is a policy with no resource behind it. A Workflow's are, because the
 * manifest binding states the job and the exported class, and the rest is the project-scoped naming rule.
 * A Vectorize index's `index_name` is a provisioning output and is not, so an entry carrying only
 * `binding` would fail wrangler's validator and stop `wrangler dev` and `wrangler deploy` both — worse
 * than no entry. A `secret` has no `wrangler.jsonc` array at all.
 *
 * `service` is in neither, deliberately: `pithy feature` writes it out of the target Worker's env-scoped
 * script name, and no shipped capability declares one.
 */
export function isWrittenBinding(type: BindingType): boolean {
  return (
    type === "d1" ||
    type === "kv" ||
    type === "r2" ||
    type === "ai" ||
    type === "durable_object" ||
    type === "ratelimit" ||
    type === "workflow"
  );
}

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
        'The exported class this binding is backed by. For a `durable_object` binding it is the DO class (e.g. "MultiplayerSession") the CLI writes into `durable_objects.bindings` and the DO class migration tag. For a `workflow` binding it is the `WorkflowEntrypoint` subclass (e.g. "EmailSendWorkflow") the CLI writes as `class_name` — the same value the capability\'s own `WorkflowSpec.className` carries. Ignored for every other kind.',
      ),
    job: z
      .string()
      .min(1)
      // Constrained here rather than only where the name is composed, because a manifest is
      // third-party data read out of `node_modules` and this string lands verbatim in the adopter's
      // `wrangler.jsonc` as a Cloudflare Workflow name. `NAME_SEGMENT` is the one segment rule every
      // composed name answers to, so a manifest that states something a deploy would refuse is refused
      // at parse instead — attributed to the capability, before anything is written.
      .regex(NAME_SEGMENT, "A job is one name segment: lowercase letters, digits, and single hyphens.")
      .optional()
      .describe(
        'The job within the capability this Workflow runs (e.g. "send") — the `<job>` segment of the deployed `<project>-<env>-<capability>-<job>` name, and the second half of the `<capability>/<job>` dispatch key. Meaningful only for a `workflow` binding, where it is what lets `pithy add` name the Workflow offline instead of leaving the binding unwritten. Ignored for every other kind.',
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
