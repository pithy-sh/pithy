// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { isProvisionedBinding, isWrittenBinding } from "@pithy-sh/core/src/capability/bindings";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { addCapability } from "./add";

/**
 * **A project that composes a capability has a binding for everything that capability requires.**
 *
 * That is the invariant, stated over the composition rather than over a list of capabilities, and it is
 * the one a scaffolded project broke on its very first request. `@pithy-sh/auth` declares
 * `ratelimit:AUTH_RATE_LIMITER` and `@pithy-sh/email` declares `workflow:EMAIL_SENDER`; both are
 * non-optional, `createBackend` correctly refuses to assemble without them, and **nothing wrote either
 * one**. So `pithy init` → `pithy add email` → `pithy dev` → `curl /health` answered 500, on the shortest
 * path through the product, in the order the docs teach it (#258).
 *
 * A binding is honestly one of two things, and the invariant has to admit both:
 *
 * - one `pithy add` can write into `wrangler.jsonc` offline ({@link isWrittenBinding}) — and then it is
 *   *there*, in every environment, which is what the second half of this file checks against the real
 *   writer;
 * - one whose resource only a provision command can create ({@link isProvisionedBinding}) — a Secrets
 *   Store entry, a Vectorize index — where the entry carries a value nothing offline knows, so `pithy
 *   add` says so in a note instead (`addBootstrap.ts`) rather than emitting a stanza wrangler refuses
 *   to load.
 *
 * A kind that is **neither** is the defect: nothing writes it, nothing announces it, and the adopter
 * meets it as a 500 naming a binding they have never heard of. That is exactly what `ratelimit` and
 * `workflow` were.
 *
 * Repo-wide over the shipped manifests, like `migrations/orders.test.ts` and
 * `project/capabilityVersions.test.ts`, and for the same reason: the property is only true as a set. A
 * capability added next year gets this gate for free.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "../../../../packages");

/** Whether a path exists — `statSync` throwing is the only way to ask without a race. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every shipped capability manifest, by package directory. */
function shippedManifests(): { pkg: string; manifest: CapabilityManifest }[] {
  const found: { pkg: string; manifest: CapabilityManifest }[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const path = join(PACKAGES, dir, "pithy.manifest.json");
    if (!exists(path)) continue;
    found.push({ pkg: dir, manifest: CapabilityManifest.parse(JSON.parse(readFileSync(path, "utf8"))) });
  }
  return found;
}

const MANIFESTS = shippedManifests();

/** How a binding is named in a failure, matching `validateBindings`: `workflow:EMAIL_SENDER`. */
function label(binding: BindingSpec): string {
  return `${binding.type}:${binding.name}`;
}

/** The bindings a capability's own composition refuses to boot without — the ones this gate is about. */
function required(manifest: CapabilityManifest): BindingSpec[] {
  return manifest.requiredBindings.filter((binding) => !binding.optional);
}

describe("every required binding has somewhere to come from", () => {
  test("each is either written by pithy add or created by a provision command", () => {
    const orphaned: string[] = [];
    for (const { pkg, manifest } of MANIFESTS) {
      for (const binding of required(manifest)) {
        if (isWrittenBinding(binding.type) || isProvisionedBinding(binding.type)) continue;
        orphaned.push(`${pkg}: ${label(binding)}`);
      }
    }
    expect(orphaned).toEqual([]);
  });

  test("it bites — a planted binding of a kind nothing writes is orphaned", () => {
    // The planted violation. `queue` is a real `BindingType` that no shipped capability declares and no
    // writer emits, so a capability that declared one would boot into "Missing required bindings:
    // queue:PLANTED" with no command anywhere to fix it. This is the shape `ratelimit` and `workflow`
    // had before #258.
    const planted = CapabilityManifest.parse({
      name: "planted",
      package: "@pithy-sh/planted",
      requiredBindings: [{ type: "queue", name: "PLANTED" }],
    });
    const orphaned = required(planted).filter(
      (binding) => !isWrittenBinding(binding.type) && !isProvisionedBinding(binding.type),
    );
    expect(orphaned.map(label)).toEqual(["queue:PLANTED"]);
  });

  test("a workflow binding nothing can name is refused, because a partial entry fails wrangler's validator", () => {
    // A `workflows` entry needs a `name` and a `class_name`, and both are derived from the job and the
    // exported class. A manifest that declares neither leaves the writer with nothing to emit — so the
    // binding would be "written" in name only and the Worker would still refuse its first request.
    const incomplete: string[] = [];
    for (const { pkg, manifest } of MANIFESTS) {
      for (const binding of required(manifest)) {
        if (binding.type !== "workflow") continue;
        if (binding.job === undefined || binding.className === undefined) incomplete.push(`${pkg}: ${label(binding)}`);
      }
    }
    expect(incomplete).toEqual([]);
  });
});

/**
 * The other half: the kinds that claim to be written really are, through the real writer, into a real
 * scaffold. A predicate that says "add writes this" and an `add` that does not is the same defect wearing
 * a different hat.
 */
describe("what pithy add claims to write, it writes", () => {
  let dir: string;
  let worker: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-bindings-"));
    await scaffoldProject({ targetDir: dir, appName: "bindings" });
    worker = join(dir, "apps", DEFAULT_WORKER);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Whether one environment's stanza declares a binding, by the key wrangler files each kind under. */
  function declares(stanza: Record<string, unknown>, binding: BindingSpec): boolean {
    const list = (key: string): Record<string, unknown>[] =>
      Array.isArray(stanza[key]) ? (stanza[key] as Record<string, unknown>[]) : [];
    switch (binding.type) {
      case "d1":
        return list("d1_databases").some((entry) => entry.binding === binding.name);
      case "kv":
        return list("kv_namespaces").some((entry) => entry.binding === binding.name);
      case "r2":
        return list("r2_buckets").some((entry) => entry.binding === binding.name);
      case "ai":
        return (stanza.ai as { binding?: string } | undefined)?.binding === binding.name;
      case "durable_object":
        return ((stanza.durable_objects as { bindings?: Record<string, unknown>[] } | undefined)?.bindings ?? []).some(
          (entry) => entry.name === binding.name,
        );
      case "ratelimit":
        return list("ratelimits").some((entry) => entry.name === binding.name);
      case "workflow":
        return list("workflows").some((entry) => entry.binding === binding.name);
      default:
        return false;
    }
  }

  test.each(MANIFESTS.map(({ pkg, manifest }) => [pkg, manifest] as const))(
    "%s: every written binding lands in every environment",
    async (_pkg, manifest) => {
      await addCapability({ workerDir: worker, manifest, project: "bindings" });
      const config = parse(await readFile(join(worker, "wrangler.jsonc"), "utf8")) as unknown as Record<
        string,
        unknown
      > & { env?: Record<string, Record<string, unknown>> };

      const stanzas: [string, Record<string, unknown>][] = [["dev", config]];
      for (const [env, stanza] of Object.entries(config.env ?? {})) stanzas.push([env, stanza]);

      const missing: string[] = [];
      for (const binding of required(manifest)) {
        if (!isWrittenBinding(binding.type)) continue;
        for (const [env, stanza] of stanzas) {
          if (!declares(stanza, binding)) missing.push(`${env}: ${label(binding)}`);
        }
      }
      expect(missing).toEqual([]);
    },
  );
});
