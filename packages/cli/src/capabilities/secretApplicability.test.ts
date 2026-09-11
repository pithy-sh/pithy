// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FreshCopyRefused } from "../project/config";
import type { BindingDeclines } from "./reconcile";
import {
  type ApplicabilityWorker,
  declaredSecrets,
  projectSecretApplicability,
  secretApplicability,
} from "./secretApplicability";

/** A credential bundle whose whole purpose is reaching one bucket. */
const CREDENTIALS: SecretRegistry = {
  "support-r2-credentials": {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    binding: "SUPPORT_BUCKET",
  },
  "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
};

/** One honored decline, resolved — what `workerDeclines` hands back for a bucket an adopter turned off. */
function declining(name: string, reason: string): BindingDeclines {
  return {
    state: "read",
    declines: [{ state: "honored", name, type: "r2", capability: "support", reason, stillPresentIn: [] }],
  };
}

/** A Worker composing one capability, with whatever declaration and declines the case is about. */
function worker(options: Partial<ApplicabilityWorker> = {}): ApplicabilityWorker {
  return {
    name: "api",
    capabilities: [defineCapability({ name: "support", requiredBindings: [] })],
    registry: CREDENTIALS,
    declines: { state: "read", declines: [] },
    ...options,
  };
}

describe("secretApplicability — a declined binding", () => {
  /**
   * The sharpest case in #541: one `pithy doctor` run said `SUPPORT_BUCKET (r2) declined in
   * pithy.config.ts` and then asked for the credential whose only purpose is reaching that bucket.
   */
  test("takes the credential whose binding this Worker declines out of reach", () => {
    const applicability = secretApplicability([
      worker({ declines: declining("SUPPORT_BUCKET", "Attachments are off, so nothing would ever be written to it.") }),
    ]);
    expect(applicability.project.get("support-r2-credentials")).toBe("SUPPORT_BUCKET declined in pithy.config.ts");
  });

  /** A secret that reaches no binding is untouched by any decline — the session secret is always needed. */
  test("leaves a secret that names no binding alone", () => {
    const applicability = secretApplicability([worker({ declines: declining("SUPPORT_BUCKET", "off") })]);
    expect(applicability.project.has("auth-session-secret")).toBe(false);
  });

  /** A decline of something else is not a decline of this. */
  test("ignores a decline naming a different binding", () => {
    const applicability = secretApplicability([worker({ declines: declining("MEDIA_BUCKET", "no media here") })]);
    expect(applicability.project.size).toBe(0);
  });

  /**
   * **A refused decline leaves the secret in reach.** `workerDeclines` resolves an entry naming a
   * required binding as `required` rather than `honored`, and the binding is written anyway — so the
   * credential is still read. Keying on the declaration instead of the resolution would mark a secret
   * unreachable on a project whose Worker is about to read it.
   */
  test("a decline that was refused is not a decline", () => {
    const refused: BindingDeclines = {
      state: "read",
      declines: [
        { state: "required", name: "SUPPORT_BUCKET", type: "r2", capability: "support", reason: "no bucket yet" },
      ],
    };
    expect(secretApplicability([worker({ declines: refused })]).project.size).toBe(0);
  });

  /**
   * **A `declinedBindings` block nobody can read leaves everything in reach.** "Nothing reads this
   * secret" is a negative claim, and a declaration that will not parse is exactly what might have
   * settled it. `pithy doctor`'s bindings tier is what reports the unreadable block; this one only has
   * to stop claiming something it could not establish.
   */
  test("an unreadable declaration claims nothing", () => {
    const invalid: BindingDeclines = { state: "invalid", problem: "SUPPORT_BUCKET: a reason is required." };
    expect(secretApplicability([worker({ declines: invalid })]).project.size).toBe(0);
  });
});

describe("secretApplicability — a capability's own declaration", () => {
  /** The second case in #541: providers the config never enabled, whose credentials were still listed. */
  test("takes a secret the capability says its configuration cannot reach out of reach", () => {
    const auth = defineCapability({
      name: "auth",
      requiredBindings: [],
      inapplicableSecrets: { "auth-apple-credentials": "auth() does not enable the apple provider" },
    });
    const applicability = secretApplicability([
      worker({
        capabilities: [auth],
        registry: {
          ...CREDENTIALS,
          "auth-apple-credentials": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
        },
      }),
    ]);
    expect(applicability.project.get("auth-apple-credentials")).toBe("auth() does not enable the apple provider");
  });

  /**
   * A capability may only speak about a secret this Worker actually declares. A name nothing composed
   * declares is not a secret with a reason — it is a name no surface lists, and carrying a reason for it
   * would put a line in a report about something that does not exist.
   */
  test("ignores a declaration naming a secret this Worker does not declare", () => {
    const stale = defineCapability({
      name: "auth",
      requiredBindings: [],
      inapplicableSecrets: { "auth-apple-credentials": "auth() does not enable the apple provider" },
    });
    expect(secretApplicability([worker({ capabilities: [stale] })]).project.size).toBe(0);
  });

  /** The capability's own sentence wins over the derived one: it is the more specific fact. */
  test("a capability's reason beats the decline-derived one", () => {
    const support = defineCapability({
      name: "support",
      requiredBindings: [],
      inapplicableSecrets: { "support-r2-credentials": "support() has attachments off" },
    });
    const applicability = secretApplicability([
      worker({ capabilities: [support], declines: declining("SUPPORT_BUCKET", "off") }),
    ]);
    expect(applicability.project.get("support-r2-credentials")).toBe("support() has attachments off");
  });
});

describe("secretApplicability — across Workers", () => {
  /**
   * **One Worker in reach is in reach.** A secret is per project and the value is one value, exactly as
   * `projectSecretRegistry` merges every Worker's registry for that reason. Narrowing to the union of
   * what each Worker cannot reach would tell an operator to skip a credential a live Worker reads.
   */
  test("a secret one Worker can still reach is not marked", () => {
    const applicability = secretApplicability([
      worker({ name: "api", declines: declining("SUPPORT_BUCKET", "off here") }),
      worker({ name: "admin" }),
    ]);
    expect(applicability.project.size).toBe(0);
  });

  /** Only when every Worker that declares it says so. The first reason is the one reported. */
  test("marked when every Worker that declares it says so, with the first reason", () => {
    const applicability = secretApplicability([
      worker({ name: "api", declines: declining("SUPPORT_BUCKET", "off here") }),
      worker({ name: "admin", declines: declining("SUPPORT_BUCKET", "off there too") }),
    ]);
    expect(applicability.project.get("support-r2-credentials")).toBe("SUPPORT_BUCKET declined in pithy.config.ts");
  });

  /** A Worker that does not declare the secret at all has no opinion about it either way. */
  test("a Worker that never declares the secret neither saves nor condemns it", () => {
    const applicability = secretApplicability([
      worker({ name: "api", declines: declining("SUPPORT_BUCKET", "off") }),
      worker({ name: "web", registry: { "auth-session-secret": CREDENTIALS["auth-session-secret"] as never } }),
    ]);
    expect(applicability.project.get("support-r2-credentials")).toBe("SUPPORT_BUCKET declined in pithy.config.ts");
  });

  /** No Workers is no claim, which is the honest answer for a directory that is not a project. */
  test("no Workers claims nothing", () => {
    expect(secretApplicability([]).project.size).toBe(0);
  });
});

/**
 * **The union, and deliberately not `aggregateSecretRegistries`.**
 *
 * That function refuses two capabilities describing one name differently — right at a Worker's startup,
 * where the disagreement decides which value gets read, and wrong here, where it would cost a reporting
 * surface its whole answer over a fault the Worker already raises at boot.
 */
describe("declaredSecrets", () => {
  const entry = { backend: "d1", scope: "environment", rotatable: false, valueType: "text" } as const;

  test("merges every capability's slice, first declaration winning", () => {
    const merged = declaredSecrets([
      defineCapability({
        name: "support",
        requiredBindings: [],
        secretRegistry: { shared: { ...entry, binding: "A" } },
      }),
      defineCapability({
        name: "media",
        requiredBindings: [],
        secretRegistry: { shared: { ...entry, binding: "B" }, own: entry },
      }),
    ]);
    expect(Object.keys(merged).sort()).toEqual(["own", "shared"]);
    expect(merged.shared?.binding).toBe("A");
  });

  /** A capability with no secrets contributes nothing rather than throwing on an absent slice. */
  test("a capability declaring no secrets contributes nothing", () => {
    expect(Object.keys(declaredSecrets([defineCapability({ name: "app", requiredBindings: [] })]))).toEqual([]);
  });

  /**
   * Prototype-free, so a capability that calls a secret `constructor` is a declared name here rather
   * than a function inherited from `Object.prototype` — this module judges adopter-supplied names, so
   * it is where a name chosen to look like one would be aimed.
   */
  test("a secret named after an Object.prototype key is a name, not an inherited function", () => {
    const merged = declaredSecrets([
      defineCapability({ name: "rogue", requiredBindings: [], secretRegistry: { constructor: entry } }),
    ]);
    expect(Object.hasOwn(merged, "constructor")).toBe(true);
    expect(Object.hasOwn(merged, "toString")).toBe(false);
  });
});

describe("projectSecretApplicability", () => {
  /**
   * Never throws, because every caller is a reporting surface. A directory that is not a project claims
   * nothing, which is the direction that cannot hide outstanding work: every row then reads exactly as
   * it did before this existed.
   */
  test("a directory that is not a project claims nothing", async () => {
    expect((await projectSecretApplicability(join(tmpdir(), "pithy-not-a-project-541"))).project.size).toBe(0);
  });
});

/**
 * **A composition is per environment, and a project that says so must not lose a credential (#541).**
 *
 * `pithy init` scaffolds `originFor(compositionEnvironment(), DOMAINS)` into every config, so reading the
 * environment *while the config is evaluated* is a pattern the kit teaches. Composed once with nothing
 * stamped, a provider enabled only for production resolves as disabled, its credential is reported as
 * **not applicable**, and doctor drops it from outstanding work — a strictly worse outcome than the noise
 * this feature removes, and with no invocation that gets it right, since neither `doctor` nor `secrets ls`
 * takes an `--env`.
 *
 * Every fixture here is a real project on disk with a real `pithy.config.ts`, because the defect is in
 * *when the config is evaluated* and no seam over the loader can observe that.
 */
describe("projectSecretApplicability — across environments", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-applicability-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A registry entry, spelled the way an adopter's own config would spell one. */
  const ENTRY = '{ backend: "d1", scope: "environment", rotatable: false, valueType: "text" }';

  /**
   * One Worker whose google provider is on in `prod` alone, and whose apple provider is off everywhere.
   * The gate is read at module scope, which is exactly where an adopter writes one.
   */
  async function writeProject(environments: readonly string[]): Promise<void> {
    await writeFile(
      join(dir, "pithy.config.ts"),
      `export default { name: "acme", environments: ${JSON.stringify(environments)} };\n`,
    );
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: "api" }));
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      [
        'const google = process.env.ENVIRONMENT === "prod";',
        "export default {",
        "  capabilities: [",
        "    {",
        '      name: "auth",',
        "      requiredBindings: [],",
        "      secretRegistry: {",
        `        "auth-google-credentials": ${ENTRY},`,
        `        "auth-apple-credentials": ${ENTRY},`,
        "      },",
        "      inapplicableSecrets: {",
        '        ...(google ? {} : { "auth-google-credentials": "auth() does not enable the google provider" }),',
        '        "auth-apple-credentials": "auth() does not enable the apple provider",',
        "      },",
        "    },",
        "  ],",
        "};",
        "",
      ].join("\n"),
    );
  }

  test("a provider enabled only in prod keeps its credential in reach", async () => {
    await writeProject(["staging", "prod"]);
    const applicability = await projectSecretApplicability(dir);
    // The regression: composed once with nothing stamped, this came back marked `not applicable`, and
    // `pithy doctor` printed no `Dev secrets:` block at all for a credential production reads.
    expect(applicability.project.has("auth-google-credentials")).toBe(false);
  });

  test("and a provider no environment enables is still marked", async () => {
    await writeProject(["staging", "prod"]);
    // The union is over reachability, not over the marking: one environment in reach saves a name, and a
    // name no environment reaches keeps the reason the capability gave. Both halves, one composition.
    expect((await projectSecretApplicability(dir)).project.get("auth-apple-credentials")).toBe(
      "auth() does not enable the apple provider",
    );
  });

  test("follows the project's own declaration — an environment it never declares is never composed", async () => {
    await writeProject(["staging"]);
    // `prod` is not this project's environment, so nothing here will ever run under it and the gate is
    // false in every composition that exists. The answer is the project's declaration, not a fixed list.
    expect((await projectSecretApplicability(dir)).project.get("auth-google-credentials")).toBe(
      "auth() does not enable the google provider",
    );
  });

  test("leaves ENVIRONMENT exactly as it found it", async () => {
    // Restored, never defaulted: a variable this process never had must not exist afterwards, or the next
    // thing to read it in this CLI run is told something the project never said.
    await writeProject(["staging", "prod"]);
    const before = process.env.ENVIRONMENT;
    await projectSecretApplicability(dir);
    expect(process.env.ENVIRONMENT).toBe(before);
    expect(Object.hasOwn(process.env, "ENVIRONMENT")).toBe(before !== undefined);
  });

  /**
   * **What a read-only checkout costs, and what it is told.**
   *
   * Re-reading a config per environment writes a copy beside it — the only way a second environment gets a
   * second answer rather than the first one's module. On a checkout that cannot be written, every one of
   * those copies fails the same way, so trying once per Worker per declared environment is work that
   * cannot succeed, done into somebody's source tree, on every `pithy doctor` and every `pithy secrets ls`
   * including `--json`. One attempt establishes it; the rest are noise.
   */
  test("stops after the first refusal instead of retrying per Worker and per environment", async () => {
    await writeProject(["staging", "prod"]);
    let attempts = 0;
    const applicability = await projectSecretApplicability(dir, {
      loadConfig: async (workerDir) => {
        attempts += 1;
        throw new FreshCopyRefused({
          message: `Could not re-read ${workerDir}.`,
          action: `Make ${workerDir} writable.`,
          detail: "staged",
        });
      },
    });

    // Three environments are declared once `dev` is added, and this project has one Worker — so the
    // unfixed sweep made three doomed copies to reach the same answer.
    expect(attempts).toBe(1);
    // And the answer is the permissive one: nothing was composed, so nothing is claimed, and every surface
    // renders what it rendered before #541 rather than marking a name on a composition nobody could take.
    expect(applicability.project.size).toBe(0);
  });
});
