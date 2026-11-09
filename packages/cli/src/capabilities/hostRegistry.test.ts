// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import { kitImport } from "../project/kitResolve";
import { KIT_ROOT } from "../test-utils/kitRoot";
import { HOST_WORKERS, hostOwnerFor, hostTemplatePath, hostWorkerFor, readHostTemplate } from "./hostRegistry";

/**
 * The registry is the production answer to "which capability owns which host Worker". Two properties matter,
 * and both are about the *set* rather than any one entry.
 */

/** `packages/` — the root every capability's template is discovered under. */
const PACKAGES_DIR = resolve(import.meta.dirname, "../../..");

/** Committed templates no resolver drives. One entry, and it is the same decision `hostTemplates.test.ts` records. */
const UNRESOLVED = ["leaderboard/src/rank/wrangler.jsonc"];

/** Every `wrangler.jsonc` committed under a package's `src/`, relative to `packages/`. */
async function committedTemplates(): Promise<string[]> {
  const found: string[] = [];
  for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const entries = await readdir(join(PACKAGES_DIR, pkg.name, "src"), { withFileTypes: true, recursive: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "wrangler.jsonc") {
        found.push(relative(PACKAGES_DIR, join(entry.parentPath, entry.name)));
      }
    }
  }
  return found.sort();
}

/**
 * The options each capability's composer needs before it will build. Two do; the rest default.
 *
 * A table rather than a per-capability fixture, because {@link composed} is what makes every case in
 * this file drive the resolver the way `pithy dev` and `pithy deploy --kit` both do — with the
 * project's real composed object, not a stand-in. The registry requires one, so a case that
 * forgets fails to compile rather than quietly resolving on schema defaults.
 */
const COMPOSE_OPTIONS: Record<string, Record<string, unknown>> = {
  email: { fromAddress: "hello@acme.dev", baseUrl: "https://api.acme.dev" },
  payments: { billingSubject: "user" },
  secrets: { registry: {} },
};

/** One capability, composed from its own package exactly as an adopter's `pithy.config.ts` does. */
async function composed(capability: string): Promise<Capability> {
  const module = await kitImport<Record<string, (options?: unknown) => Capability>>(
    KIT_ROOT,
    `@pithy-sh/${capability}/src/capability`,
  );
  const compose = module[capability];
  if (!compose) throw new Error(`@pithy-sh/${capability} exports no ${capability}() composer.`);
  return compose(COMPOSE_OPTIONS[capability] ?? {});
}

/** A dev context: the shape `pithy dev` builds, with the binding standing in for every resource id. */
function devContext(capability: Capability) {
  return {
    project: "acme",
    projectDir: KIT_ROOT,
    env: LOCAL_ENVIRONMENT,
    baseUrl: "http://localhost:8787",
    databaseId: (binding: string) => binding,
    // Dev's two answers, spelled out here as `pithy dev` spells them out at its own call site.
    storeId: () => "",
    accountId: () => "",
    capability,
  };
}

describe("the host-worker registry", () => {
  test("names every committed host template, or records why not", async () => {
    const covered = HOST_WORKERS.map((spec) => relative(PACKAGES_DIR, hostTemplatePath(KIT_ROOT, spec.entry))).sort();
    expect([...covered, ...UNRESOLVED].sort()).toEqual(await committedTemplates());
  });

  test("resolves a capability by name, and answers nothing for one that hosts no Workflows", () => {
    expect(hostWorkerFor("email")?.entry).toBe("@pithy-sh/email/src/workflows/worker");
    expect(hostWorkerFor("auth")).toBeUndefined();
  });

  describe.each(HOST_WORKERS)("$capability", (spec) => {
    /**
     * `binds` is what decides whether a Worker that owns a binding gets a host of its own, so it must name exactly
     * what the host reads: one binding short and an owning Worker's jobs run against the shared database.
     */
    test("binds names every D1 and R2 binding its resolved host binds", async () => {
      const capability = await composed(spec.capability);
      const config = await spec.resolve(await readHostTemplate(KIT_ROOT, spec.entry), devContext(capability));
      const bound = [...(config.d1_databases ?? []), ...(config.r2_buckets ?? [])].map((entry) => entry.binding);
      expect([...spec.binds(capability)].sort()).toEqual(bound.sort());
    });

    test("resolves a Worker's own host under <project>-dev-<owner>---<capability>, Workflows and all", async () => {
      const capability = await composed(spec.capability);
      const config = await spec.resolve(await readHostTemplate(KIT_ROOT, spec.entry), {
        ...devContext(capability),
        owner: { worker: "two", bindings: [...spec.binds(capability)].slice(0, 1) },
      });
      expect(config.name).toBe(`acme-dev-two---${spec.capability}`);
      for (const workflow of config.workflows ?? []) {
        expect(workflow.name.startsWith(`acme-dev-two---${spec.capability}-`), workflow.name).toBe(true);
      }
    });

    test("resolves for dev under <project>-dev-<capability>", async () => {
      const config = await spec.resolve(
        await readHostTemplate(KIT_ROOT, spec.entry),
        devContext(await composed(spec.capability)),
      );
      expect(config.name).toBe(`acme-dev-${spec.capability}`);
    });

    /**
     * The trap this test exists for. Local D1 identity is `database_id ?? binding` — wrangler's own
     * chain, and the one `pithy migrate --env dev` keys the Miniflare store by. A host resolved with
     * the template's `<filled-at-provision>` (or a real remote id) opens a *different* local database
     * from the app Worker's, and every query fails `no such table` for a reason that reads like a
     * code fault.
     */
    test("gives every D1 binding the binding itself as its local id", async () => {
      const config = await spec.resolve(
        await readHostTemplate(KIT_ROOT, spec.entry),
        devContext(await composed(spec.capability)),
      );
      for (const entry of config.d1_databases ?? []) expect(entry.database_id).toBe(entry.binding);
    });

    /**
     * The other half of the same guarantee, and the reason a first `pithy dev` boots rather than
     * erroring on a missing table.
     *
     * `pithy migrate --env dev` migrates a database per binding an app Worker's capabilities declare,
     * keyed by binding in the shared Miniflare store. A host binds the *same* names, so its tables are
     * already there — but only for these three. A host that declared a fourth would open an empty
     * database and fail `no such table` on its first query, and nothing else in the tree would say so.
     * So the set is written down: a new one fails here, and the fix is `pithy migrate` coverage for it,
     * not a wider list.
     */
    test("binds only databases pithy migrate --env dev has already filled", async () => {
      const config = await spec.resolve(
        await readHostTemplate(KIT_ROOT, spec.entry),
        devContext(await composed(spec.capability)),
      );
      const migrated = new Set(["DB", "SECRETS", "EMAIL_SUPPRESSIONS"]);
      for (const entry of config.d1_databases ?? []) expect(migrated.has(entry.binding), entry.binding).toBe(true);
    });
  });

  /**
   * **A composed object that is not its package's own shape is refused, never defaulted.**
   *
   * A fallback to `Config.parse({})` would fire on exactly the input nobody anticipated, and what it produces is
   * an adopter's Worker deployed on somebody else's settings. A throw reaches an operator as a `failed`
   * row under `pithy deploy` and a named note under `pithy dev`; a default reaches them as nothing.
   */
  test.each(HOST_WORKERS.filter((spec) => spec.capability !== "secrets"))(
    "$capability refuses a capability object that carries no configuration",
    async (spec) => {
      const impostor = { name: spec.capability } as Capability;
      await expect(spec.resolve(await readHostTemplate(KIT_ROOT, spec.entry), devContext(impostor))).rejects.toThrow(
        `The composed ${spec.capability} capability does not carry its configuration.`,
      );
    },
  );

  /**
   * The address a locally sent message points people at.
   *
   * `email({ baseUrl })` is the *deployed* app's public origin — a required key, so it is always set —
   * and a host resolved against it under `pithy dev` mints every tracked click, open pixel and
   * unsubscribe link at production, signed with the local signing key. The context's `baseUrl` is the
   * origin for the environment being resolved, which is what {@link HostResolveContext} says it is and
   * the only one that can be right in both.
   */
  test("email's local host builds its links against the app's local origin, not the deployed one", async () => {
    const spec = hostWorkerFor("email");
    // The real composer, with the deployed origin an adopter is required to state. Nothing else here
    // says `https://api.acme.com`, so a resolver reading `emailConfig.baseUrl` would be visible.
    const module = await kitImport<typeof import("@pithy-sh/email/src/capability")>(
      KIT_ROOT,
      "@pithy-sh/email/src/capability",
    );
    const capability = module.email({ fromAddress: "hello@acme.com", baseUrl: "https://api.acme.com" });
    const config = await spec?.resolve(await readHostTemplate(KIT_ROOT, "@pithy-sh/email/src/workflows/worker"), {
      ...devContext(capability),
    });
    expect(config?.vars?.BASE_URL).toBe("http://localhost:8787");
  });
});

describe("hostOwnerFor", () => {
  const email = hostWorkerFor("email");
  const capability = { name: "email", requiredBindings: [] } as unknown as Capability;

  test("a Worker owning a binding its capability's host binds owns a host, named for its directory", () => {
    expect(email && hostOwnerFor(email, capability, { dir: "/p/apps/two", ownBindings: ["DB", "ORDERS"] })).toEqual({
      worker: "two",
      bindings: ["DB"],
    });
  });

  test("a Worker owning nothing the host binds shares the host", () => {
    expect(email && hostOwnerFor(email, capability, { dir: "/p/apps/two", ownBindings: ["ORDERS"] })).toBeUndefined();
    expect(email && hostOwnerFor(email, capability, { dir: "/p/apps/one" })).toBeUndefined();
  });

  test("audit's host reads the database audit({ database }) names, so owning that one is what counts", () => {
    const audit = hostWorkerFor("audit");
    const trail = { name: "audit", requiredBindings: [], auditDatabase: "AUDIT_DB" } as unknown as Capability;
    expect(audit && hostOwnerFor(audit, trail, { dir: "/p/apps/two", ownBindings: ["DB"] })).toBeUndefined();
    expect(
      audit && hostOwnerFor(audit, trail, { dir: "/p/apps/two", ownBindings: ["AUDIT_DB", "AUDIT_CHECKPOINTS"] }),
    ).toEqual({ worker: "two", bindings: ["AUDIT_DB", "AUDIT_CHECKPOINTS"] });
  });

  test("owning the trail's database and sharing the checkpoint bucket is refused, naming the binding to add", () => {
    // Checkpoint keys name a tenant and a count, never a database, and the first write wins: two chains in one
    // bucket would each be verified against the other's head.
    const audit = hostWorkerFor("audit");
    const trail = { name: "audit", requiredBindings: [] } as unknown as Capability;
    expect(() => audit && hostOwnerFor(audit, trail, { dir: "/p/apps/two", ownBindings: ["DB"] })).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({
          message: expect.stringContaining("AUDIT_CHECKPOINTS"),
          action: expect.stringContaining("apps/two/pithy.worker.jsonc"),
        }),
      }),
    );
  });

  test("owning the checkpoint bucket and sharing the trail's database is refused, naming the binding to add", () => {
    // Both hosts would checkpoint and prune one chain, each recording its tombstones in a bucket the other never reads.
    const audit = hostWorkerFor("audit");
    const trail = { name: "audit", requiredBindings: [] } as unknown as Capability;
    expect(
      () => audit && hostOwnerFor(audit, trail, { dir: "/p/apps/two", ownBindings: ["AUDIT_CHECKPOINTS"] }),
    ).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({
          message: expect.stringContaining("two owns AUDIT_CHECKPOINTS but shares DB"),
          action: expect.stringContaining("Add DB to apps/two/pithy.worker.jsonc"),
        }),
      }),
    );
  });

  test("owning storage's database and sharing its bucket is refused, because the sweep deletes unmatched objects", () => {
    const storage = hostWorkerFor("storage");
    const capability = { name: "storage", requiredBindings: [] } as unknown as Capability;
    expect(() => storage && hostOwnerFor(storage, capability, { dir: "/p/apps/two", ownBindings: ["DB"] })).toThrow(
      /STORAGE_BUCKET/,
    );
    expect(
      storage && hostOwnerFor(storage, capability, { dir: "/p/apps/two", ownBindings: ["DB", "STORAGE_BUCKET"] }),
    ).toEqual({ worker: "two", bindings: ["DB", "STORAGE_BUCKET"] });
  });

  test("owning only the bucket is no split: the own host sweeps its bucket against the database its objects' rows are in", () => {
    const storage = hostWorkerFor("storage");
    const capability = { name: "storage", requiredBindings: [] } as unknown as Capability;
    expect(
      storage && hostOwnerFor(storage, capability, { dir: "/p/apps/two", ownBindings: ["STORAGE_BUCKET"] }),
    ).toEqual({ worker: "two", bindings: ["STORAGE_BUCKET"] });
  });

  test("media keys nothing against its database, so owning DB alone still gets a host of its own", () => {
    const media = hostWorkerFor("media");
    const capability = { name: "media", requiredBindings: [] } as unknown as Capability;
    expect(media && hostOwnerFor(media, capability, { dir: "/p/apps/two", ownBindings: ["DB"] })?.bindings).toEqual([
      "DB",
    ]);
  });

  test("a teardown still finds the host a split owner names, so removal never waits on a config fix", () => {
    const audit = hostWorkerFor("audit");
    const trail = { name: "audit", requiredBindings: [] } as unknown as Capability;
    expect(
      audit && hostOwnerFor(audit, trail, { dir: "/p/apps/two", ownBindings: ["DB"] }, { refuseSplit: false }),
    ).toEqual({ worker: "two", bindings: ["DB"] });
  });
});

describe("a Worker's own host binds what that Worker owns", () => {
  test("an owned bucket is the bucket provision creates for that Worker", async () => {
    const spec = hostWorkerFor("media");
    const capability = await composed("media");
    const config = await spec?.resolve(await readHostTemplate(KIT_ROOT, "@pithy-sh/media/src/workflows/worker"), {
      ...devContext(capability),
      env: "staging",
      owner: { worker: "two", bindings: ["MEDIA_BUCKET"] },
    });
    expect(config?.r2_buckets?.[0]?.bucket_name).toBe("acme-staging-two---media-bucket");
  });
});

/** **One master key, every vault under it.** The shared manager binds each owned vault, so its rotation re-seals it. */
describe("the shared secrets manager beside a Worker that owns SECRETS", () => {
  const vault = { binding: "VAULT_TWO", databaseName: "acme-staging-two---secrets", databaseId: "two-secrets" };

  test("binds each owned vault the deploy names, and stamps it for the at-rest rotation", async () => {
    const spec = hostWorkerFor("secrets");
    const capability = await composed("secrets");
    const config = await spec?.resolve(await readHostTemplate(KIT_ROOT, "@pithy-sh/secrets/src/manager/worker"), {
      ...devContext(capability),
      env: "staging",
      ownedVaults: async () => [vault],
    });
    expect(config?.d1_databases).toContainEqual({
      binding: "VAULT_TWO",
      database_name: "acme-staging-two---secrets",
      database_id: "two-secrets",
    });
    expect(config?.vars?.OWNED_VAULTS).toBe(JSON.stringify(["VAULT_TWO"]));
  });

  test("a Worker's own manager binds no other vault", async () => {
    const spec = hostWorkerFor("secrets");
    const capability = await composed("secrets");
    const config = await spec?.resolve(await readHostTemplate(KIT_ROOT, "@pithy-sh/secrets/src/manager/worker"), {
      ...devContext(capability),
      env: "staging",
      owner: { worker: "two", bindings: ["SECRETS"] },
      ownedVaults: async () => [vault],
    });
    expect(config?.vars?.OWNED_VAULTS).toBeUndefined();
    expect(config?.vars?.OWNER).toBe("two");
  });
});
