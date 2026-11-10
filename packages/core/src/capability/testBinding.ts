// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { BindingType } from "./bindings";

/** A Worker binding name. Written into the adopter's `vitest.workers.config.ts` as a string or an object key. */
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A path into a module of a scoped package: `@pithy-sh/secrets/src/test-utils/devEncryptionKeys`. Written into the
 * adopter's config as an import specifier, so no quotes, no whitespace and no `..`.
 */
const PACKAGE_MODULE = /^@[a-z0-9-][a-z0-9._-]*\/[a-z0-9-][a-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9_-]*)+$/;

/** A JavaScript identifier: the export a `value` binding is computed by, written as `<export>()`. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const name = z
  .string()
  .regex(BINDING_NAME, "A test binding is named by its binding: letters, digits and `_`, not leading a digit.")
  .describe("The binding name, as the Worker's `env` reads it.");

/**
 * How a Workers test config provides one binding a capability requires, as a Miniflare option of the
 * `cloudflareTest` plugin. `pithy add` writes it into the project's `vitest.workers.config.ts`.
 *
 * `unbound` declares a binding a test config cannot provide on its own: a Durable Object or Workflow class
 * lives in the Worker's entry, which the project-wide test config does not load, and a remote binding needs
 * an account.
 */
export const TestBinding = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("d1").describe("A local D1 database, in `d1Databases`."), name })
      .describe("A D1 database Miniflare creates per run."),
    z
      .object({ kind: z.literal("kv").describe("A local KV namespace, in `kvNamespaces`."), name })
      .describe("A KV namespace Miniflare creates per run."),
    z
      .object({ kind: z.literal("r2").describe("A local R2 bucket, in `r2Buckets`."), name })
      .describe("An R2 bucket Miniflare creates per run."),
    z
      .object({
        kind: z.literal("ratelimit").describe("A local rate limiter, in `ratelimits`."),
        name,
        limit: z.number().int().min(1).describe("Requests allowed per period."),
        period: z
          .union([z.literal(10), z.literal(60)])
          .describe("The period in seconds. Workers Rate Limiting accepts 10 or 60."),
      })
      .describe("A rate limiter Miniflare simulates."),
    z
      .object({
        kind: z.literal("value").describe("A plain value, in `bindings`."),
        name,
        module: z
          .string()
          .regex(PACKAGE_MODULE, "A test binding's module is a path into a scoped package.")
          .describe("The module the value's function is imported from, inside the capability's own package."),
        export: z
          .string()
          .regex(IDENTIFIER, "A test binding's export is a JavaScript identifier.")
          .describe("The function, called with no arguments, that returns the value for one test run."),
      })
      .describe("A value computed for the test run, such as a dev master key."),
    z
      .object({ kind: z.literal("unbound").describe("Nothing a test config can state on its own."), name })
      .describe("A binding the Workers test config cannot provide."),
  ])
  .describe("How a Workers test config provides one binding a capability requires.");
export type TestBinding = z.infer<typeof TestBinding>;

/** The kinds a {@link TestBinding} takes. */
export type TestBindingKind = TestBinding["kind"];

/** The kind a test config states each binding type with. Total, so a new binding type is a type error here. */
const TEST_BINDING_KIND: Record<BindingType, TestBindingKind> = {
  d1: "d1",
  kv: "kv",
  r2: "r2",
  ratelimit: "ratelimit",
  secret: "value",
  ai: "unbound",
  vectorize: "unbound",
  queue: "unbound",
  email: "unbound",
  workflow: "unbound",
  service: "unbound",
  durable_object: "unbound",
  hyperdrive: "unbound",
  browser: "unbound",
  images: "unbound",
  analytics_engine_datasets: "unbound",
  pipelines: "unbound",
  mtls_certificates: "unbound",
  dispatch_namespaces: "unbound",
  artifacts: "unbound",
};

/** The kind a capability's test binding for a binding of `type` must declare. */
export function testBindingKind(type: BindingType): TestBindingKind {
  return TEST_BINDING_KIND[type];
}

/** A binding as {@link appliedTestBindings} reads one; `optional` left out means required. */
interface RequiredBinding {
  type: BindingType;
  name: string;
  optional?: boolean;
}

/**
 * The test bindings that apply to one composition of a capability. A test binding for a binding the manifest
 * requires always applies. One for a binding the manifest marks optional applies only when `composed`, the
 * capability as this Worker's config builds it, requires that binding, which is when its per-request check
 * enforces it: `controlplane({ replayBackend: "kv" })` requires `kv:CONTROL_PLANE`. With no composed instance, only
 * the manifest's required ones apply.
 */
export function appliedTestBindings(
  manifest: { requiredBindings: readonly RequiredBinding[]; testBindings: readonly TestBinding[] },
  composed: { requiredBindings: readonly RequiredBinding[] } | undefined,
): TestBinding[] {
  const key = (binding: RequiredBinding) => `${testBindingKind(binding.type)}:${binding.name}`;
  const optional = new Set(manifest.requiredBindings.filter((binding) => binding.optional === true).map(key));
  const needed = new Set((composed?.requiredBindings ?? []).filter((binding) => binding.optional !== true).map(key));
  return manifest.testBindings.filter((binding) => {
    const declared = `${binding.kind}:${binding.name}`;
    return !optional.has(declared) || needed.has(declared);
  });
}
