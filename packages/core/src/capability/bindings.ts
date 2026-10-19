// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { FEATURE_RESOURCE_KINDS } from "../naming/feature";
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
    z
      .literal("hyperdrive")
      .describe("Hyperdrive — a pooled, cached connection to an existing database. The adopter creates the config."),
    z.literal("browser").describe("Browser Rendering — a headless browser the Worker drives."),
    z.literal("images").describe("Cloudflare Images — transform and optimize images from the Worker."),
    z
      .literal("analytics_engine_datasets")
      .describe("Workers Analytics Engine — write data points to a dataset, query them with SQL."),
    z.literal("pipelines").describe("Pipelines — send records into a stream that lands in R2. The adopter creates it."),
    z
      .literal("mtls_certificates")
      .describe("mTLS certificate — present a client certificate on outbound requests. The adopter uploads it."),
    z
      .literal("dispatch_namespaces")
      .describe("Workers for Platforms dispatch namespace — call Workers uploaded into it. The adopter creates it."),
    z
      .literal("artifacts")
      .describe(
        "Artifacts — versioned storage that speaks Git, one namespace of repositories per environment. Cloudflare creates the namespace on its first repo.",
      ),
  ])
  .describe("Kind of Cloudflare resource a binding refers to.");
export type BindingType = z.infer<typeof BindingType>;

/**
 * **How a stanza the kit creates gets this kind's entries** (#662).
 *
 * Every `env.<name>` stanza Pithy creates starts from the top level, because wrangler inherits none of the keys a
 * binding lives in. What it starts with depends on whose resource the entry names, and that is a fact about the
 * kind, not about the JSON shape wrangler happens to give it:
 *
 * - **`carry`** — account-level and identical everywhere. A dataset, a certificate, a rate limiter's
 *   `namespace_id`: the top level's entries come down whole into every stanza, because nothing in them is an
 *   environment's own.
 * - **`provision`** — the environment owns the resource. Seeded empty, refilled by the provisioner, because
 *   dev's database id in staging's stanza is staging writing to dev's database.
 * - **`branch`** — an account-level resource and a per-environment *decision*. Carried into a feature, which is a
 *   branch of `dev`; left empty in a declared environment, which is not. A `send_email` entry names an address
 *   verified once at the account, and where this environment's mail goes is a choice production does not inherit
 *   from a laptop. A Hyperdrive config is one origin database's connection, and a pipeline stream feeds one sink:
 *   the account holds both, but the top level's are dev's, and a declared environment seeded with them would read
 *   and write dev's Postgres and dev's sink with nothing failing.
 *
 * Three values, not a boolean. `send_email` was carried everywhere for a day and wrote a developer's address into
 * production's first stanza (#650 review); emptied everywhere, it left a feature with no `NOTIFY`.
 */
export type SeedPolicy = "carry" | "provision" | "branch";

/**
 * The policy per kind, as a total record — so a kind added to {@link BindingType} without one is a type error
 * here, and `bindings.test.ts` fails on a member whose answer it does not state.
 */
const SEED_POLICY: Record<BindingType, SeedPolicy> = {
  ai: "carry",
  ratelimit: "carry",
  browser: "carry",
  images: "carry",
  hyperdrive: "branch",
  analytics_engine_datasets: "carry",
  mtls_certificates: "carry",
  dispatch_namespaces: "carry",
  pipelines: "branch",
  d1: "provision",
  kv: "provision",
  r2: "provision",
  vectorize: "provision",
  queue: "provision",
  durable_object: "provision",
  workflow: "provision",
  service: "provision",
  secret: "provision",
  email: "branch",
  // The namespace is environment-derived, so a stanza starts empty and its own name is written in (#673).
  artifacts: "provision",
};

/** How a newly created stanza gets this kind's entries. See {@link SeedPolicy}. */
export function seedPolicy(type: BindingType): SeedPolicy {
  return SEED_POLICY[type];
}

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
 *
 * **The pure-wrangler-entry kinds are written and never provisioned (#662).** `hyperdrive`, `browser`, `images`,
 * `analytics_engine_datasets`, `pipelines`, `mtls_certificates` and `dispatch_namespaces` each take a binding name
 * and, where wrangler requires one, the account-level resource the spec states as `target`. Pithy writes the
 * entry; the adopter stands the resource up. `queue` writes its `queues.producers` entry under the name
 * `pithy provision` creates the queue with, and `email` writes `send_email` with nothing but its name.
 *
 * **`artifacts` is written and never provisioned (#673).** Its entry is `{ binding, namespace }`, and the namespace
 * is `<project>-<env>`, derivable offline. There is no create call to make: Cloudflare creates a namespace the first
 * time a repo is created in it. There is a teardown call, because repos cost storage, and `pithy feature destroy`
 * makes it.
 */
export function isWrittenBinding(type: BindingType): boolean {
  return WRITTEN.has(type);
}

const WRITTEN = new Set<BindingType>([
  "d1",
  "kv",
  "r2",
  "ai",
  "durable_object",
  "ratelimit",
  "workflow",
  "queue",
  "email",
  "hyperdrive",
  "browser",
  "images",
  "analytics_engine_datasets",
  "pipelines",
  "mtls_certificates",
  "dispatch_namespaces",
  "artifacts",
]);

/**
 * The kinds whose wrangler entry names an account-level resource the adopter creates, and what wrangler calls
 * that field — what `BindingSpec.target` is written as. `true` where wrangler refuses the entry without it.
 */
export const TARGET_KINDS: Readonly<Partial<Record<BindingType, { field: string; required: boolean }>>> = {
  hyperdrive: { field: "id", required: true },
  mtls_certificates: { field: "certificate_id", required: true },
  pipelines: { field: "stream", required: true },
  dispatch_namespaces: { field: "namespace", required: true },
  analytics_engine_datasets: { field: "dataset", required: false },
};

/**
 * A JavaScript class name — what `className` may be.
 *
 * Constrained because it is no longer only a JSON value. A Durable Object's `className` is written into
 * the adopter's Worker entry as `export { <className> } from "…";` (#428), which is generated TypeScript
 * built out of third-party data read from `node_modules` — the shape #171, #174 and #183 each met one
 * field too late. An identifier cannot close the statement and open another.
 */
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A bare module specifier — a package, optionally with a path into it.
 *
 * The other half of the generated export line, and narrowed for the same reason. No quotes, no
 * whitespace, no `..`: a specifier that walked back out of its own package would re-export whatever it
 * landed on, which is `configImports.isInside`'s argument in a regex.
 */
const CLASS_MODULE = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/;

/** What a `target` may be: a Cloudflare id or resource name, starting alphanumeric. */
const TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The kinds whose resource Pithy names and creates — the only kinds `scope` and `resource` mean anything
 * for.
 *
 * {@link FEATURE_RESOURCE_KINDS} rather than a fresh literal, because it is already the repo's answer to
 * "which bindings does a provisioning run compose a `<project>-<scope>-<thing>` name for": it is the
 * domain of `ProvisionScope.resource`, and the CLI's own `PROVISIONABLE` map is the same four. Every
 * other kind's name is composed by a different rule with no `<thing>` slot to fill — a Workflow's from
 * the capability and the job, a Worker script's by wrangler — and a `secret` already states its scope in
 * `defineSecretRegistry`, where the value it names lives.
 */
const NAMED_RESOURCE_KINDS = new Set<string>(FEATURE_RESOURCE_KINDS);

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
      .regex(CLASS_NAME, "A className is a JavaScript identifier: letters, digits, `_` and `$`, not leading a digit.")
      .optional()
      .describe(
        'The exported class this binding is backed by. For a `durable_object` binding it is the DO class (e.g. "MultiplayerSession") the CLI writes into `durable_objects.bindings`, the DO class migration tag, and the `export { … }` line in the Worker entry. For a `workflow` binding it is the `WorkflowEntrypoint` subclass (e.g. "EmailSendWorkflow") the CLI writes as `class_name` — the same value the capability\'s own `WorkflowSpec.className` carries. Ignored for every other kind.',
      ),
    classModule: z
      .string()
      .min(1)
      .regex(CLASS_MODULE, "A classModule is a bare module specifier: a package, optionally with a path into it.")
      .optional()
      .describe(
        'The module the class is exported from (e.g. "@pithy-sh/multiplayer/src/session/durableObject") — what the CLI writes the Worker entry\'s `export { <className> } from "<classModule>";` against. Required for a `durable_object` binding, because wrangler resolves `class_name` against the entry `main` names and refuses the deploy when nothing there exports it. Its own module, never the package entry point, which `pithy.config.ts` loads in Node. Ignored for every other kind.',
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
    target: z
      .string()
      .min(1)
      // An id or a resource name, never prose: a manifest is third-party data out of `node_modules`, and this
      // string lands in the adopter's `wrangler.jsonc` and in every stanza the kit carries it into.
      .regex(TARGET, "A target is a resource id or name: letters, digits, `.`, `_` and `-`.")
      .optional()
      .describe(
        "The account-level resource this binding addresses, which the adopter creates themselves: a Hyperdrive config id, an mTLS certificate id, a Pipelines stream, a dispatch namespace, or an Analytics Engine dataset. Written into the field wrangler names for it (`id`, `certificate_id`, `stream`, `namespace`, `dataset`), and carried whole into every environment, because the resource is the account's. Required for `hyperdrive`, `mtls_certificates`, `pipelines` and `dispatch_namespaces`; optional for `analytics_engine_datasets`. Refused on every other kind.",
      ),
    remote: z
      .boolean()
      .optional()
      .describe(
        "Reach the real Cloudflare resource during local development instead of a local emulation. Set it for a binding that has none — Vectorize and Workers AI both lack local simulation — so `wrangler dev` and any Workflow host, which always runs locally, still work. Left unset rather than defaulting to false, so a spec that does not care emits no flag at all. Ignored in a deployed Worker.",
      ),
    scope: z
      .enum(["environment", "global"])
      .optional()
      .describe(
        "Whether the resource behind this binding is one per environment (absent, the default) or one for the whole project. A `global` resource takes the literal `global` where the environment segment goes — `<project>-global-<thing>` — so every environment's stanza names the identical resource and provisioning creates it once. Declare it where the data is not an environment-local fact: `@pithy-sh/email`'s suppression list is one per project, because an unsubscribe recorded through a staging Worker has to be honored by a production one, and three per-environment databases meant it was not (#513). Say nothing where it is: a session store, a cache, and `@pithy-sh/secrets`' own database are per environment, and one line apart in the same env there is no convention to tell them apart by — which is why this is declared rather than inferred. Meaningful only for a `d1`, `kv`, `r2` or `queue` binding.",
      ),
    resource: z
      .string()
      .min(1)
      // The same rule the composed name answers to, asserted here rather than only where the name is
      // built: a manifest is third-party data read out of `node_modules`, and this string is the last
      // segment of a Cloudflare resource name. A manifest stating something a provisioning run would
      // refuse is refused at parse instead, attributed to the capability, before anything is created.
      .regex(NAME_SEGMENT, "A resource is one name segment: lowercase letters, digits, and single hyphens.")
      .optional()
      .describe(
        "The `<thing>` segment of this resource's name, when it is not the kebabbed binding name. Absent is the ordinary case and means the binding name is the segment (`EMAIL_SUPPRESSIONS` → `email-suppressions`). Declare it where the two must differ: `SUPPORT_BUCKET` backs `<project>-global-support`, because the binding keeps `_BUCKET` for whoever reads `env.SUPPORT_BUCKET` in a Worker while the resource drops it — `r2` is already the composed name's kind, so the suffix repeats it. Meaningful only for a `d1`, `kv`, `r2` or `queue` binding.",
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
    // And the module that class comes from. A DO binding is two halves — the `durable_objects.bindings`
    // entry and a named export on the module `main` points at — and the CLI can only write the second
    // one if the capability says where the class lives. Without it the wiring is complete in the config
    // and the deploy fails on "not exported in your entrypoint file" (#428). Refused at define time,
    // attributed to the capability, for the same reason `className` is.
    if (ctx.value.type === "durable_object" && ctx.value.classModule === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["classModule"],
        message: `Durable Object binding "${ctx.value.name}" needs a classModule — the module its class is exported from.`,
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
    // `scope` and `resource` are the two halves of a *provisioned resource's name*, and only
    // {@link NAMED_RESOURCE_KINDS} have one Pithy composes. On anything else they are inert — a Workflow
    // would keep its `<capability>-<job>` name, a `secret` its registry's scope — so a manifest that
    // states one is not describing a resource that exists. Refused rather than ignored, and refused here
    // rather than in the writer, because a silently-dropped `scope: "global"` reads, in the manifest, as
    // exactly the declaration #513 exists to make true.
    if (!NAMED_RESOURCE_KINDS.has(ctx.value.type)) {
      for (const field of ["scope", "resource"] as const) {
        if (ctx.value[field] === undefined) continue;
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          path: [field],
          message: `Binding "${ctx.value.name}" declares a ${field}, which only a d1, kv, r2 or queue binding has — this one is a ${ctx.value.type}.`,
        });
      }
    }
    // `target` is the resource a carried kind addresses, written into the one field wrangler names for it. A kind
    // that requires it is refused without it — wrangler refuses the entry, and a writer emitting one would stop
    // `wrangler dev` and `wrangler deploy` both. A kind with no such field is refused with it, for the reason
    // `scope` is: a declaration nothing writes reads, in the spec, as one that was honored.
    const target = TARGET_KINDS[ctx.value.type];
    if (target?.required && ctx.value.target === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["target"],
        message: `Binding "${ctx.value.name}" needs a target — the ${ctx.value.type} resource it addresses, written as \`${target.field}\`.`,
      });
    }
    if (target === undefined && ctx.value.target !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["target"],
        message: `Binding "${ctx.value.name}" declares a target, which a ${ctx.value.type} binding does not take.`,
      });
    }
  });
export type BindingSpec = z.infer<typeof BindingSpec>;

/** Authoring shape for a capability's `requiredBindings`: `optional` may be omitted. */
export type BindingSpecInput = z.input<typeof BindingSpec>;
