// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { type FeatureIdentity, featureWorkerName, isFeatureOwnedName } from "@pithy-sh/core/src/naming/feature";
import { NAMESPACE_LIMITS } from "@pithy-sh/core/src/naming/limits";
import { environmentScope, featureScope, type ProvisionWorkerNames } from "@pithy-sh/core/src/naming/provisionScope";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { FeatureResource } from "../feature/manifest";
import { unrepeatedKeys } from "../project/wranglerInheritance";
import { featureConfigPath } from "./featureConfig";
import { applyProvisionedEnv, bindFeatureHosts } from "./wranglerEnv";

interface Stanza {
  name?: string;
  services?: { binding: string; service: string }[];
  secrets_store_secrets?: { binding: string; store_id: string; secret_name: string }[];
  d1_databases?: { binding: string; database_name?: string; database_id?: string }[];
  kv_namespaces?: { binding: string; id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
}

interface Parsed {
  env: Record<string, Stanza | undefined>;
}

/** `pithy init replay --worker board`: the directory says `board`, the deploy name `replay-board`. */
const BOARD: ProvisionWorkerNames = { app: "board", script: "replay-board" };

describe("applyProvisionedEnv", () => {
  let dir: string;
  let wranglerPath: string;
  const feature = featureScope({ project: "replay", issue: "69", slug: "demo" });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-wranglerenv-"));
    wranglerPath = join(dir, "wrangler.jsonc");
    await writeFile(wranglerPath, ["{", "  // a starting comment", '  "name": "replay-board"', "}", ""].join("\n"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const resources: FeatureResource[] = [
    { kind: "d1", binding: "DB", name: "replay-f69-demo--db-d1", id: "uuid-1" },
    { kind: "kv", binding: "CACHE", name: "replay-f69-demo--cache-kv", id: "ns-1" },
    { kind: "r2", binding: "ASSETS", name: "replay-f69-demo--assets-r2", id: "bucket-1" },
  ];

  /**
   * Where this scope's ids actually land. A feature's are a build artifact and go to the generated
   * config under the already-ignored `.wrangler/`; a declared environment's are source (#242).
   */
  const written = (scope: typeof feature): string => (scope.source ? wranglerPath : featureConfigPath(dir));

  const read = async (scope: typeof feature): Promise<string> => readFile(written(scope), "utf8");

  const apply = (scope: typeof feature, extra: Partial<Parameters<typeof applyProvisionedEnv>[0]> = {}) =>
    applyProvisionedEnv({
      workerDir: dir,
      worker: BOARD,
      scope,
      resources,
      services: [],
      secrets: [],
      administersItself: false,
      ...extra,
    });

  test("writes each resource's id under env.<stanza>, preserving comments", async () => {
    await apply(feature);

    const raw = await read(feature);
    const stanza = (parse(raw) as unknown as Parsed).env.feature;

    expect(stanza?.d1_databases).toContainEqual({
      binding: "DB",
      database_name: "replay-f69-demo--db-d1",
      database_id: "uuid-1",
    });
    expect(stanza?.kv_namespaces).toContainEqual({ binding: "CACHE", id: "ns-1" });
    expect(stanza?.r2_buckets).toContainEqual({ binding: "ASSETS", bucket_name: "bucket-1" });
    expect(raw).toContain("// a starting comment");
  });

  /**
   * The stanza is the scope's, never a separate argument. Two scopes over the same file therefore write
   * two stanzas, and a name can never land under an environment it does not belong to.
   */
  test("the stanza it writes is the scope's own", async () => {
    await apply(feature);
    await apply(environmentScope("replay", "staging"), {
      resources: [{ kind: "d1", binding: "DB", name: "replay-staging-db", id: "uuid-2" }],
    });

    const generated = parse(await read(feature)) as unknown as Parsed;
    const tracked = parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed;
    expect(generated.env.feature?.d1_databases?.[0]?.database_id).toBe("uuid-1");
    // The tracked file never learned about the feature at all — that is the whole of #242.
    expect(tracked.env.feature).toBeUndefined();
    expect(tracked.env.staging?.d1_databases?.[0]).toEqual({
      binding: "DB",
      database_name: "replay-staging-db",
      database_id: "uuid-2",
    });
    expect(tracked.env.staging?.name).toBe("replay-board-staging");
  });

  test("is idempotent: re-running with a different id replaces rather than duplicates", async () => {
    await apply(feature);
    await apply(feature, {
      resources: [{ kind: "d1", binding: "DB", name: "replay-f69-demo--db-d1", id: "uuid-2" }],
    });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.d1_databases).toHaveLength(1);
    expect(stanza?.d1_databases?.[0]?.database_id).toBe("uuid-2");
  });

  /**
   * `<project>-f<issue>-<slug>-<app>`, with the project once. This pinned `replay-f69-demo--replay-board`
   * until #587 — the defect, locked in by the test that should have caught it.
   */
  test("names the Worker for the scope and points services at that scope's deployments", async () => {
    await apply(feature, { services: [{ binding: "WEB", service: "replay-f69-demo--web" }] });

    const raw = await read(feature);
    const stanza = (parse(raw) as unknown as Parsed).env.feature;

    expect(stanza?.name).toBe("replay-f69-demo--board");
    expect(stanza?.services).toEqual([{ binding: "WEB", service: "replay-f69-demo--web" }]);
    expect(raw).toContain("// a starting comment");
  });

  test("retargets a service in place rather than duplicating it", async () => {
    await apply(feature, { services: [{ binding: "WEB", service: "replay-f69-demo--web" }] });
    await apply(feature, { services: [{ binding: "WEB", service: "replay-f69-demo--web-v2" }] });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.services).toEqual([{ binding: "WEB", service: "replay-f69-demo--web-v2" }]);
  });

  /**
   * The `secrets_store_secrets` stanza `pithy add` deliberately could not write, and nothing came back
   * for (#238, #239). Complete by construction — wrangler refuses a config whose entry is missing a
   * `store_id` or a `secret_name`, so a partial entry is not a degraded binding, it is a broken Worker.
   */
  test("writes the secrets_store_secrets stanza, upserting by binding", async () => {
    await apply(feature, {
      secrets: [
        {
          binding: "SECRETS_ENCRYPTION_KEYS",
          store_id: "store-1",
          secret_name: "replay-f69-demo--secrets-encryption-keys",
        },
      ],
    });
    await apply(feature, {
      secrets: [
        {
          binding: "SECRETS_ENCRYPTION_KEYS",
          store_id: "store-2",
          secret_name: "replay-f69-demo--secrets-encryption-keys",
        },
      ],
    });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.secrets_store_secrets).toEqual([
      {
        binding: "SECRETS_ENCRYPTION_KEYS",
        store_id: "store-2",
        secret_name: "replay-f69-demo--secrets-encryption-keys",
      },
    ]);
  });

  /**
   * **One write, holding everything (#592).** A feature's config is regenerated from the tracked file on
   * every write, so a second write for its secrets started from a stanza with no name, no ids and no
   * services and kept only the secrets. The Worker deployed as `<script>-feature`, a name nothing records
   * and teardown never deletes, with every binding id-less.
   */
  test("a feature's secrets do not cost it its name, its ids or its services", async () => {
    await apply(feature, {
      services: [{ binding: "WEB", service: "replay-f69-demo--web" }],
      secrets: [{ binding: "SECRETS_ENCRYPTION_KEYS", store_id: "store-1", secret_name: "replay-f69-demo--keys" }],
    });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.name).toBe("replay-f69-demo--board");
    expect(stanza?.d1_databases?.[0]?.database_id).toBe("uuid-1");
    expect(stanza?.services).toEqual([{ binding: "WEB", service: "replay-f69-demo--web" }]);
    expect(stanza?.secrets_store_secrets?.map((entry) => entry.binding)).toEqual(["SECRETS_ENCRYPTION_KEYS"]);
  });

  /** Nothing rewrites a stanza beyond the entries it owns — an adopter's hand-added binding survives. */
  test("leaves a secrets binding it does not own alone", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify(
        {
          name: "replay-board",
          env: {
            feature: {
              secrets_store_secrets: [{ binding: "HAND_ADDED", store_id: "s", secret_name: "theirs" }],
            },
          },
        },
        null,
        2,
      ),
    );

    await apply(feature, {
      secrets: [{ binding: "SECRETS_ENCRYPTION_KEYS", store_id: "store-1", secret_name: "mine" }],
    });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.secrets_store_secrets?.map((entry) => entry.binding)).toEqual([
      "HAND_ADDED",
      "SECRETS_ENCRYPTION_KEYS",
    ]);
  });

  /**
   * **A Worker cannot fetch its own hostname** (#616). The subrequest loops back out through the edge
   * into the Worker it came from and hangs until Cloudflare answers 522, so a project that administers
   * itself dispatches through the runtime instead — and the binding that does it has to name the script
   * *this* stanza deploys as.
   *
   * Taken from the stanza rather than from a literal, deliberately: the assertion is that the two agree,
   * and a literal on both sides would pass while the binding pointed at a script nobody deploys.
   */
  test("a self-administering project binds SELF to the script its own stanza names", async () => {
    await apply(feature, { administersItself: true });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.name).toBe("replay-f69-demo--board");
    expect(stanza?.services).toEqual([{ binding: "SELF", service: stanza?.name }]);
  });

  /** The same, for a declared environment, where the name is read from the file rather than composed. */
  test("and in a declared environment it names that stanza's script", async () => {
    await apply(environmentScope("replay", "staging"), { administersItself: true });

    const stanza = (parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed).env.staging;
    expect(stanza?.name).toBe("replay-board-staging");
    expect(stanza?.services).toEqual([{ binding: "SELF", service: stanza?.name }]);
  });

  test("re-running leaves one entry, never two", async () => {
    await apply(feature, { administersItself: true });
    await apply(feature, { administersItself: true });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.services).toEqual([{ binding: "SELF", service: "replay-f69-demo--board" }]);
  });

  /** Declared, never inferred: a project that says nothing gets nothing, and its stanza is untouched. */
  test("a project that does not declare it gets no services entry at all", async () => {
    await apply(feature);

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.services).toBeUndefined();
  });

  /** A capability's own service bindings keep their targets; the self entry joins them. */
  test("the self entry sits beside the service bindings a capability declares", async () => {
    await apply(feature, { administersItself: true, services: [{ binding: "WEB", service: "replay-f69-demo--web" }] });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.services).toEqual([
      { binding: "WEB", service: "replay-f69-demo--web" },
      { binding: "SELF", service: "replay-f69-demo--board" },
    ]);
  });

  test("preserves comments sitting inside an existing binding array on re-run", async () => {
    // A pre-existing env.feature stanza with a comment INSIDE the d1_databases array.
    await writeFile(
      wranglerPath,
      [
        "{",
        '  "env": {',
        '    "feature": {',
        '      "d1_databases": [',
        "        // primary feature db",
        '        { "binding": "DB", "database_id": "old" }',
        "      ]",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    await apply(feature, {
      resources: [{ kind: "d1", binding: "DB", name: "replay-f69-demo--db-d1", id: "new" }],
    });

    const raw = await read(feature);
    expect(raw).toContain("// primary feature db"); // the in-array comment survived the write.
    const stanza = (parse(raw) as unknown as Parsed).env.feature;
    expect(stanza?.d1_databases).toEqual([
      { binding: "DB", database_name: "replay-f69-demo--db-d1", database_id: "new" },
    ]);
  });
});

/**
 * The name in an environment stanza is the adopter's, and provisioning reads it rather than writing over it.
 *
 * This reverses what `environmentScope` argued (#580). The old rule recomputed `<name>-<env>` — wrangler's
 * own suffix — on every provision, which was harmless only while nothing else ever wrote a name there. Since
 * #580 the starter template writes one, `<project>-<env>-<worker>`, so recomputing would have made the
 * template's stamp pointless *and* renamed the Worker of every project that had taken it — on the next
 * provision, silently, taking its routes and every `service` binding pointing at it along.
 *
 * The fallback is untouched: a stanza that names nothing still gets wrangler's suffix, so a project that
 * never declared a name deploys exactly where it always did.
 */
describe("applyProvisionedEnv and a declared environment name", () => {
  let dir: string;
  let wranglerPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-envname-"));
    wranglerPath = join(dir, "wrangler.jsonc");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const provision = () =>
    applyProvisionedEnv({
      administersItself: false,
      workerDir: dir,
      worker: BOARD,
      scope: environmentScope("replay", "staging"),
      resources: [],
      services: [],
      secrets: [],
    });

  test("keeps the name the stanza declares", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({ name: "replay-board", env: { staging: { name: "replay-staging-board" } } }, null, 2),
    );

    await provision();
    await provision(); // idempotent: a second run must not drift the name either.

    const config = parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed;
    expect(config.env.staging?.name).toBe("replay-staging-board");
  });

  test("writes wrangler's own suffix when the stanza declares none", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board", env: { staging: {} } }, null, 2));

    await provision();

    const config = parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed;
    expect(config.env.staging?.name).toBe("replay-board-staging");
  });
});

/**
 * **A stanza provisioning creates repeats what an environment does not inherit** (#581).
 *
 * #581 taught the two scaffolders — `project/scaffold.ts` and `project/workerScaffold.ts` — and this is
 * the third writer of the same thing, the one every `pithy provision` and every feature deploy goes
 * through. Its stanza is created empty and filled with ids, so a `feature` stanza (which never pre-exists,
 * `env.feature` being unwritable in a tracked config) repeated nothing: the Worker deployed with no `vars`
 * at all — no `ENVIRONMENT`, no `PROJECT`, no `WORKER` — and no `CF_VERSION_METADATA`.
 *
 * Stated as the invariant rather than as a list of key names. `unrepeatedKeys` reads the config the writer
 * produced and answers for **every** non-inherited key it declares, so a wrangler release that adds one
 * reaches this assertion without anybody coming back to extend it.
 */
describe("a stanza applyProvisionedEnv creates", () => {
  let dir: string;
  let wranglerPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-envseed-"));
    wranglerPath = join(dir, "wrangler.jsonc");
    // The shape `pithy init` stamps: identity vars and the version binding at the top level, an empty
    // binding array, and no stanza for the environment about to be provisioned.
    await writeFile(
      wranglerPath,
      JSON.stringify(
        {
          name: "replay-board",
          vars: { ENVIRONMENT: "dev", PROJECT: "replay", WORKER: "board" },
          version_metadata: { binding: "CF_VERSION_METADATA" },
          d1_databases: [{ binding: "DB", database_name: "replay-dev-db", database_id: "dev-uuid" }],
        },
        null,
        2,
      ),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const staging = environmentScope("replay", "staging");

  test("goes without nothing the top level declares", async () => {
    await applyProvisionedEnv({
      administersItself: false,
      workerDir: dir,
      worker: BOARD,
      scope: staging,
      resources: [{ kind: "d1", binding: "DB", name: "replay-staging-db", id: "staging-uuid" }],
      services: [],
      secrets: [],
    });

    const config = parse(await readFile(wranglerPath, "utf8"));
    expect(unrepeatedKeys(config)).toEqual([]);
  });

  test("names its own environment rather than carrying dev's", async () => {
    await applyProvisionedEnv({
      administersItself: false,
      workerDir: dir,
      worker: BOARD,
      scope: staging,
      resources: [],
      services: [],
      secrets: [],
    });

    const config = parse(await readFile(wranglerPath, "utf8")) as unknown as {
      env: Record<string, { vars?: Record<string, string> }>;
    };
    expect(config.env.staging?.vars).toEqual({ ENVIRONMENT: "staging", PROJECT: "replay", WORKER: "board" });
  });

  test("binds this environment's database and never dev's", async () => {
    // The reason a new stanza is seeded rather than copied: a `d1_databases` entry carried down verbatim
    // would point staging at the database dev writes to, which is worse than the absent binding it fixes.
    await applyProvisionedEnv({
      administersItself: false,
      workerDir: dir,
      worker: BOARD,
      scope: staging,
      resources: [{ kind: "d1", binding: "DB", name: "replay-staging-db", id: "staging-uuid" }],
      services: [],
      secrets: [],
    });

    const config = parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed;
    expect(config.env.staging?.d1_databases).toEqual([
      { binding: "DB", database_name: "replay-staging-db", database_id: "staging-uuid" },
    ]);
  });

  test("leaves a feature's generated stanza carrying the vars its Worker reads", async () => {
    const feature = featureScope({ project: "replay", issue: "69", slug: "demo" });
    await applyProvisionedEnv({
      administersItself: false,
      workerDir: dir,
      worker: BOARD,
      scope: feature,
      resources: [],
      services: [],
      secrets: [],
    });

    const config = parse(await readFile(featureConfigPath(dir), "utf8"));
    expect(unrepeatedKeys(config)).toEqual([]);
    expect((config as unknown as { env: Record<string, { vars?: Record<string, string> }> }).env.feature?.vars).toEqual(
      { ENVIRONMENT: "feature", PROJECT: "replay", WORKER: "board" },
    );
  });
});

/**
 * **A feature's generated stanza carries its own address (#643).**
 *
 * The Worker cannot look up the account's `workers.dev` subdomain, so provisioning does, derives
 * `https://<script>.<subdomain>.workers.dev` through the one resolver, and stamps it as `vars.BASE_URL` — the
 * var `originFor` reads inside a feature deployment. `replay` and `board`, so the script is neither.
 */
describe("the address applyProvisionedEnv stamps", () => {
  let dir: string;
  let wranglerPath: string;
  const feature = featureScope({ project: "replay", issue: "643", slug: "feature-address" });

  const stanzaVars = async (path: string, key: string): Promise<Record<string, string> | undefined> =>
    (parse(await readFile(path, "utf8")) as unknown as { env: Record<string, { vars?: Record<string, string> }> }).env[
      key
    ]?.vars;

  const provision = (scope: typeof feature, subdomain: string | null) =>
    applyProvisionedEnv({
      administersItself: false,
      workerDir: dir,
      worker: BOARD,
      scope,
      resources: [],
      services: [],
      secrets: [],
      subdomain,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-envaddress-"));
    wranglerPath = join(dir, "wrangler.jsonc");
    // A hand-set top-level `BASE_URL`, production's: exactly what a feature stanza must not inherit as its address.
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        vars: { ENVIRONMENT: "dev", PROJECT: "replay", WORKER: "board", BASE_URL: "https://app.example.com" },
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a feature's is its script's workers.dev origin", async () => {
    await provision(feature, "acme");

    expect(await stanzaVars(featureConfigPath(dir), "feature")).toEqual({
      ENVIRONMENT: "feature",
      PROJECT: "replay",
      WORKER: "board",
      BASE_URL: "https://replay-f643-feature-address--board.acme.workers.dev",
    });
  });

  test("an account with no subdomain gets no address, and never the inherited one", async () => {
    await provision(feature, null);

    expect((await stanzaVars(featureConfigPath(dir), "feature"))?.BASE_URL).toBeUndefined();
  });

  test("a top-level workers_dev: false, which wrangler inherits, stamps no workers.dev address (#643)", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        workers_dev: false,
        vars: { ENVIRONMENT: "dev", PROJECT: "replay", WORKER: "board", BASE_URL: "https://app.example.com" },
      }),
    );

    await provision(feature, "acme");

    expect((await stanzaVars(featureConfigPath(dir), "feature"))?.BASE_URL).toBeUndefined();
  });

  /**
   * **Finding 3: a top-level route never reaches a feature (#643).** wrangler inherits `routes` into a stanza that
   * sets none, so a branch deploy took the project's custom domain, and with routes and no `workers_dev` it got no
   * `workers.dev` address while provisioning stamped one. The feature stanza now states `routes: []` — its own,
   * which wins — and its stamped address is the one wrangler will give it.
   */
  test("a top-level route is stripped from the feature stanza, and the workers.dev address is still stamped", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        routes: [{ pattern: "app.example.com", custom_domain: true }],
        vars: { ENVIRONMENT: "dev", PROJECT: "replay", WORKER: "board", BASE_URL: "https://app.example.com" },
      }),
    );

    await provision(feature, "acme");

    const generated = parse(await readFile(featureConfigPath(dir), "utf8")) as unknown as {
      env: { feature: { routes?: unknown[]; route?: unknown; vars?: Record<string, string> } };
    };
    // As wrangler resolves it: the stanza's own `routes` wins over the top level's, so the feature has none.
    expect(generated.env.feature.routes).toEqual([]);
    expect(generated.env.feature.route).toBeUndefined();
    expect(generated.env.feature.vars?.BASE_URL).toBe("https://replay-f643-feature-address--board.acme.workers.dev");
  });

  test("a top-level route is stripped with no subdomain to stamp from, too", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board", route: "app.example.com" }));

    await provision(feature, null);

    const generated = parse(await readFile(featureConfigPath(dir), "utf8")) as unknown as {
      env: { feature: { routes?: unknown[] } };
    };
    expect(generated.env.feature.routes).toEqual([]);
  });

  test("a declared environment's stanza keeps what the tracked file says about routes", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board", routes: ["app.example.com"] }));

    await provision(environmentScope("replay", "staging"), "acme");

    const tracked = parse(await readFile(wranglerPath, "utf8")) as unknown as {
      env: { staging: { routes?: unknown[] } };
    };
    expect(tracked.env.staging.routes).toBeUndefined();
  });

  test("a declared environment is never stamped from workers.dev (#89)", async () => {
    await provision(environmentScope("replay", "staging"), "acme");

    expect((await stanzaVars(wranglerPath, "staging"))?.BASE_URL).toBe("https://app.example.com");
  });
});

/**
 * **F4 of #643's review: what a feature stanza gives up, and what it must carry.** Routes are stripped from a
 * feature stanza — and the run is told which, whether they were inherited or declared under a tracked
 * `env.feature`. Rate limiters are bound whether or not that stanza already exists, and every one of them gets
 * the feature's own namespace: nothing is shared between a feature and any other environment.
 */
describe("a feature stanza's routes and rate limiters", () => {
  let dir: string;
  let wranglerPath: string;
  const identity = { project: "replay", issue: "643", slug: "feature-address" };
  const feature = featureScope(identity);
  const LIMITER = { name: "AUTH_RATE_LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } };

  const provision = (onRoutesDropped?: (routes: string[]) => void) =>
    applyProvisionedEnv({
      administersItself: false,
      workerDir: dir,
      worker: BOARD,
      scope: feature,
      resources: [],
      services: [],
      secrets: [],
      subdomain: "acme",
      ...(onRoutesDropped ? { onRoutesDropped } : {}),
    });
  const generated = async () =>
    (
      parse(await readFile(featureConfigPath(dir), "utf8")) as unknown as {
        env: { feature: { ratelimits?: { name: string; namespace_id: string }[]; routes?: unknown[] } };
      }
    ).env.feature;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-envlimits-"));
    wranglerPath = join(dir, "wrangler.jsonc");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("tells the operator which inherited routes it stripped", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board", routes: ["app.example.com/*"] }));
    const dropped: string[][] = [];
    await provision((routes) => dropped.push(routes));
    expect(dropped).toEqual([["app.example.com/*"]]);
    expect((await generated()).routes).toEqual([]);
  });

  test("tells the operator which routes a tracked env.feature declared, and strips them too", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        routes: ["app.example.com/*"],
        env: { feature: { route: { pattern: "preview.example.com/*" }, routes: ["beta.example.com/*"] } },
      }),
    );
    const dropped: string[][] = [];
    await provision((routes) => dropped.push(routes));
    expect(dropped).toEqual([["preview.example.com/*", "beta.example.com/*"]]);
    expect((await generated()).routes).toEqual([]);
  });

  test("says nothing when there was no route to strip", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board" }));
    const dropped: string[][] = [];
    await provision((routes) => dropped.push(routes));
    expect(dropped).toEqual([]);
  });

  test("copies the top level's limiter into a tracked env.feature that lacks it, in the feature's own namespace", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({ name: "replay-board", ratelimits: [LIMITER], env: { feature: { vars: { A: "b" } } } }),
    );
    await provision();
    const limits = (await generated()).ratelimits ?? [];
    expect(limits.map((entry) => entry.name)).toEqual(["AUTH_RATE_LIMITER"]);
    expect(limits[0]?.namespace_id).toBe("1000001001");
    expect(limits[0]?.namespace_id).not.toBe(LIMITER.namespace_id);
  });

  test("never keeps the top level's namespace in a stanza it creates", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board", ratelimits: [LIMITER] }));
    await provision();
    expect((await generated()).ratelimits?.map((entry) => entry.namespace_id)).toEqual(["1000001001"]);
  });

  test("renumbers a namespace a tracked env.feature declared, since every branch would share it", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        env: { feature: { ratelimits: [{ ...LIMITER, name: "FEATURE_LIMITER", namespace_id: "2002" }] } },
      }),
    );
    await provision();
    expect((await generated()).ratelimits?.map((entry) => [entry.name, entry.namespace_id])).toEqual([
      ["FEATURE_LIMITER", "1000002002"],
    ]);
  });

  test("gives two limiters two namespaces, each its own fixed one", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        ratelimits: [LIMITER, { ...LIMITER, name: "UPLOAD_LIMITER", namespace_id: "2002" }],
      }),
    );
    await provision();
    expect((await generated()).ratelimits?.map((entry) => [entry.name, entry.namespace_id])).toEqual([
      ["AUTH_RATE_LIMITER", "1000001001"],
      ["UPLOAD_LIMITER", "1000002002"],
    ]);
  });

  test("refuses a limiter it cannot map, rather than keep the declared one", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({ name: "replay-board", ratelimits: [{ ...LIMITER, namespace_id: "2000000001" }] }),
    );
    await expect(provision()).rejects.toThrow(/rate limiter AUTH_RATE_LIMITER declares namespace 2000000001/);
  });
});

/**
 * **The app's own same-script bindings in a feature's stanza (#650).**
 *
 * A feature deployment answered 500 on every request — `Missing required bindings: workflow:CONNECTION_ROTATION,
 * workflow:ROTATION_SWEEP` — because the generated stanza carried the kit hosts' Workflows and none of the app's
 * own. Staging and prod carry theirs, written by `pithy worker sync` into the tracked file; the feature's stanza
 * is regenerated from that file on every run and `stanzaFor` empties every binding array it seeds, so nothing
 * put them back. A Durable Object namespace the app declares went the same way, for the same reason.
 */
describe("a feature stanza's app-owned bindings", () => {
  let dir: string;
  let wranglerPath: string;
  const identity: FeatureIdentity = { project: "replay", issue: "650", slug: "app-workflows" };
  const feature = featureScope(identity);

  /** The dashboard's real shape, reduced: two Workflows whose classes are exported by the app's own main. */
  const app = defineCapability({
    name: "board",
    requiredBindings: [],
    workflows: {
      rotate: {
        binding: "CONNECTION_ROTATION",
        params: z.object({}),
        className: "ConnectionRotationWorkflow",
        schedule: "0 4 * * *",
      },
      sweep: { binding: "ROTATION_SWEEP", params: z.object({}), className: "RotationSweepWorkflow" },
    },
  });

  interface FeatureStanza {
    workflows?: { binding: string; name: string; class_name: string; script_name?: string }[];
    durable_objects?: { bindings?: { name: string; class_name: string; script_name?: string }[] };
    triggers?: { crons?: string[] };
    send_email?: { name: string; destination_address?: string }[];
    services?: { binding: string; service: string }[];
  }

  /**
   * This project's Workers, as `provisionEnvironment` resolves them for the writer: the sibling `apps/realtime`
   * deploying as `replay-realtime`, and this Worker itself. Anything else is another project's.
   */
  const scopedScript = (target: string): string | undefined =>
    ({
      "replay-realtime": featureWorkerName(identity, "realtime"),
      "replay-board": featureWorkerName(identity, "board"),
    })[target];

  const provision = (scope = feature, extra: Partial<Parameters<typeof applyProvisionedEnv>[0]> = {}) =>
    applyProvisionedEnv({
      administersItself: false,
      workerDir: dir,
      worker: BOARD,
      scope,
      resources: [],
      services: [],
      secrets: [],
      app,
      ...extra,
    });

  const generated = async (): Promise<FeatureStanza> =>
    (parse(await readFile(featureConfigPath(dir), "utf8")) as unknown as { env: Record<string, FeatureStanza> }).env
      .feature as FeatureStanza;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-envapp-"));
    wranglerPath = join(dir, "wrangler.jsonc");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("carries every Workflow the app declares, feature-named and same-script", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board", main: "src/index.ts" }));
    await provision();
    expect((await generated()).workflows).toEqual([
      {
        binding: "CONNECTION_ROTATION",
        name: "replay-f650-app-workflows--board-rotate",
        class_name: "ConnectionRotationWorkflow",
      },
      {
        binding: "ROTATION_SWEEP",
        name: "replay-f650-app-workflows--board-sweep",
        class_name: "RotationSweepWorkflow",
      },
    ]);
  });

  test("every name it writes is this feature's own, and within the Workflow limit", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board" }));
    await provision();
    const entries = (await generated()).workflows ?? [];
    // Not vacuously: an empty table would satisfy every clause below, and an empty table is the defect.
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(isFeatureOwnedName(identity, entry.name)).toBe(true);
      expect(entry.name.length).toBeLessThanOrEqual(NAMESPACE_LIMITS.workflow.maxLength);
      // Same-script: the class is exported by this Worker's own main, so there is no host to point at.
      expect(entry.script_name).toBeUndefined();
    }
  });

  test("never writes dev's names, which a carried-whole table would have", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        workflows: [
          { binding: "CONNECTION_ROTATION", name: "replay-dev-board-rotate", class_name: "ConnectionRotationWorkflow" },
          { binding: "ROTATION_SWEEP", name: "replay-dev-board-sweep", class_name: "RotationSweepWorkflow" },
        ],
      }),
    );
    await provision();
    const names = ((await generated()).workflows ?? []).map((entry) => entry.name);
    expect(names).toHaveLength(2);
    expect(names.some((name) => name.includes("-dev-"))).toBe(false);
  });

  test("replaces a stale app-owned entry a tracked env.feature declared, and keeps a host's", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        env: {
          feature: {
            workflows: [
              {
                binding: "EMAIL_SENDER",
                name: "replay-f650-app-workflows--email-send",
                class_name: "EmailSendWorkflow",
                script_name: "replay-f650-app-workflows--email",
              },
              { binding: "GONE", name: "replay-dev-board-gone", class_name: "GoneWorkflow" },
            ],
          },
        },
      }),
    );
    await provision();
    expect(((await generated()).workflows ?? []).map((entry) => entry.binding)).toEqual([
      "EMAIL_SENDER",
      "CONNECTION_ROTATION",
      "ROTATION_SWEEP",
    ]);
  });

  test("carries the same-script Durable Object namespaces the top level declares", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
      }),
    );
    await provision();
    expect((await generated()).durable_objects?.bindings).toEqual([{ name: "ROOM", class_name: "Room" }]);
  });

  test("keeps a Durable Object naming a Worker this project does not own, and says so", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        durable_objects: {
          bindings: [
            { name: "ROOM", class_name: "Room" },
            { name: "LOBBY", class_name: "Lobby", script_name: "someone-elses-prod-lobby" },
          ],
        },
      }),
    );
    const foreign: string[][] = [];
    await provision(feature, { scopedScript, onForeignScripts: (entries: string[]) => foreign.push(entries) });
    expect((await generated()).durable_objects?.bindings).toEqual([
      { name: "ROOM", class_name: "Room" },
      { name: "LOBBY", class_name: "Lobby", script_name: "someone-elses-prod-lobby" },
    ]);
    expect(foreign).toEqual([["durable object LOBBY: someone-elses-prod-lobby"]]);
  });

  test("a Durable Object a tracked env.feature already binds is the adopter's, and is not duplicated", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
        env: { feature: { durable_objects: { bindings: [{ name: "ROOM", class_name: "BranchRoom" }] } } },
      }),
    );
    await provision();
    expect((await generated()).durable_objects?.bindings).toEqual([{ name: "ROOM", class_name: "BranchRoom" }]);
  });

  test("a project that declares no Durable Object gets no key at all — wrangler reads an empty one as a declaration", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board" }));
    await provision();
    expect((await generated()).durable_objects).toBeUndefined();
  });

  /**
   * **The acceptance criterion that keeps this fix inside the feature.** A declared environment's table is
   * `pithy worker sync`'s, written into the tracked file and reviewed in a pull request; provisioning writing
   * it too would be a second writer of one fact. So the same project's staging stanza is byte-identical with
   * the app handed in and without it.
   */
  test("a declared environment's stanza is byte-identical, app capability or not", async () => {
    const tracked = JSON.stringify({ name: "replay-board", main: "src/index.ts" });
    await writeFile(wranglerPath, tracked);
    await provision(environmentScope("replay", "staging"));
    const withApp = await readFile(wranglerPath, "utf8");

    await writeFile(wranglerPath, tracked);
    await provision(environmentScope("replay", "staging"), { app: undefined });
    expect(await readFile(wranglerPath, "utf8")).toBe(withApp);
    expect(withApp).not.toContain("CONNECTION_ROTATION");
  });

  test("and so is prod's", async () => {
    const tracked = JSON.stringify({ name: "replay-board", durable_objects: { bindings: [] } });
    await writeFile(wranglerPath, tracked);
    await provision(environmentScope("replay", "prod"));
    const withApp = await readFile(wranglerPath, "utf8");

    await writeFile(wranglerPath, tracked);
    await provision(environmentScope("replay", "prod"), { app: undefined });
    expect(await readFile(wranglerPath, "utf8")).toBe(withApp);
  });

  test("a Worker with no app capability writes no workflows key at all", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board" }));
    await provision(feature, { app: undefined });
    expect((await generated()).workflows).toBeUndefined();
  });

  test("the app's cron schedule is stated in the stanza rather than left to inheritance", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board" }));
    await provision();
    expect((await generated()).triggers?.crons).toEqual(["0 4 * * *"]);
  });

  /**
   * **A feature states its own schedule, empty included (#650 review, defect 4).** `triggers` is one of the keys
   * wrangler *does* inherit, so a stanza that says nothing takes the top level's crons — and the top level's are
   * `dev`'s, or whatever the adopter runs in production. `setCrons` writing nothing is right for a tracked
   * stanza, where an absent `crons` means "leave the deployed schedule alone"; it is wrong for a feature, which
   * is generated whole on every run and has no deployed schedule of its own to preserve.
   */
  test("an app with no schedule leaves the feature an empty cron list, never the top level's", async () => {
    const unscheduled = defineCapability({
      name: "board",
      requiredBindings: [],
      workflows: { rotate: { binding: "CONNECTION_ROTATION", params: z.object({}), className: "Rotate" } },
    });
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board", triggers: { crons: ["0 4 * * *"] } }));
    await provision(feature, { app: unscheduled });
    expect((await generated()).triggers?.crons).toEqual([]);
  });

  test("and a Worker with no app capability at all still states an empty one", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board", triggers: { crons: ["0 4 * * *"] } }));
    await provision(feature, { app: undefined });
    expect((await generated()).triggers?.crons).toEqual([]);
  });

  test("a declared environment keeps the inheritance it always had", async () => {
    await writeFile(wranglerPath, JSON.stringify({ name: "replay-board", triggers: { crons: ["0 4 * * *"] } }));
    await provision(environmentScope("replay", "staging"));
    const tracked = parse(await readFile(wranglerPath, "utf8")) as unknown as {
      env: Record<string, FeatureStanza | undefined>;
    };
    expect(tracked.env.staging?.triggers).toBeUndefined();
  });

  /**
   * **A Durable Object in a sibling Worker of this project is retargeted, not dropped (#650 review, defect 2).**
   *
   * `services` to that very Worker is retargeted through `scope.worker(...)` two statements down. A DO binding
   * naming the same script is the same wiring by another key, and dropping it deployed the feature with no
   * `LOBBY` — `Missing required bindings: durable_object:LOBBY`, the error this whole issue is about.
   */
  test("a Durable Object in a sibling Worker of this project is retargeted at the feature's copy", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        services: [{ binding: "REALTIME", service: "replay-realtime" }],
        durable_objects: { bindings: [{ name: "LOBBY", class_name: "Lobby", script_name: "replay-realtime" }] },
      }),
    );
    await provision(feature, {
      scopedScript,
      services: [{ binding: "REALTIME", service: featureWorkerName(identity, "realtime") }],
    });
    const stanza = await generated();
    // The two keys reach one Worker and must name one script.
    expect(stanza.durable_objects?.bindings).toEqual([
      { name: "LOBBY", class_name: "Lobby", script_name: "replay-f650-app-workflows--realtime" },
    ]);
    expect(stanza.services).toEqual([{ binding: "REALTIME", service: "replay-f650-app-workflows--realtime" }]);
  });

  test("a Durable Object naming this Worker's own script is retargeted at the feature's name for it", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        durable_objects: { bindings: [{ name: "ROOM", class_name: "Room", script_name: "replay-board" }] },
      }),
    );
    await provision(feature, { scopedScript });
    expect((await generated()).durable_objects?.bindings).toEqual([
      { name: "ROOM", class_name: "Room", script_name: "replay-f650-app-workflows--board" },
    ]);
  });

  test("one naming a Worker outside this project is left alone, and the run is told", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        durable_objects: { bindings: [{ name: "SHARED", class_name: "Shared", script_name: "other-prod-thing" }] },
      }),
    );
    const foreign: string[][] = [];
    await provision(feature, { scopedScript, onForeignScripts: (entries: string[]) => foreign.push(entries) });
    expect((await generated()).durable_objects?.bindings).toEqual([
      { name: "SHARED", class_name: "Shared", script_name: "other-prod-thing" },
    ]);
    expect(foreign).toEqual([["durable object SHARED: other-prod-thing"]]);
  });

  test("says nothing when every Durable Object is this project's", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
      }),
    );
    const foreign: string[][] = [];
    await provision(feature, { scopedScript, onForeignScripts: (entries: string[]) => foreign.push(entries) });
    expect(foreign).toEqual([]);
  });

  /**
   * **`send_email` is carried whole (#650 review, defect 5).** A send binding names an account-level Cloudflare
   * Email Service address: nothing in the entry belongs to an environment, which is `CARRIED_WHOLE`'s stated
   * rule. Emptied, a hand-written one failed at runtime as `env.NOTIFY is undefined` — `email` is in neither
   * `isWrittenBinding` nor `isProvisionedBinding`, so no command anywhere would have put it back.
   */
  test("a send_email binding the top level declares is carried into the feature whole", async () => {
    await writeFile(
      wranglerPath,
      JSON.stringify({
        name: "replay-board",
        send_email: [{ name: "NOTIFY", destination_address: "ops@example.com" }],
      }),
    );
    await provision();
    expect((await generated()).send_email).toEqual([{ name: "NOTIFY", destination_address: "ops@example.com" }]);
  });
});

/**
 * **F2 of #643's review: a host that failed to deploy leaves no binding to it.** The app Worker's entries into
 * the kit hosts are written after the deploy, and only for the hosts that deployed — and a re-run whose host now
 * fails takes back the entry an earlier run wrote.
 */
describe("bindFeatureHosts", () => {
  let dir: string;
  const EMAIL = {
    binding: "EMAIL_SENDER",
    name: "replay-f643-feature-address--email-send",
    class_name: "EmailSendWorkflow",
    script_name: "replay-f643-feature-address--email",
  };
  const MEDIA = {
    binding: "MEDIA_IMAGE_TO_TEXT",
    name: "replay-f643-feature-address--media-image-to-text",
    class_name: "ImageToTextWorkflow",
    script_name: "replay-f643-feature-address--media",
  };
  const OWN = { binding: "KEY_ROTATION", name: "replay-f643-feature-address--app-rotate", class_name: "Rotate" };

  const workflows = async () =>
    (
      parse(await readFile(featureConfigPath(dir), "utf8")) as unknown as {
        env: { feature: { workflows?: { binding: string }[]; vectorize?: { binding: string; index_name: string }[] } };
      }
    ).env.feature;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-envhosts-"));
    await mkdir(join(dir, ".wrangler", "pithy"), { recursive: true });
    await writeFile(featureConfigPath(dir), JSON.stringify({ name: "board", env: { feature: { workflows: [OWN] } } }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("binds only the hosts that deployed, and keeps the Worker's own entries", async () => {
    await bindFeatureHosts({ workerDir: dir, hosted: [EMAIL, MEDIA], bound: [EMAIL], indexes: [] });
    expect((await workflows()).workflows?.map((entry) => entry.binding)).toEqual(["KEY_ROTATION", "EMAIL_SENDER"]);
  });

  test("takes back an entry an earlier run wrote when its host now fails", async () => {
    await bindFeatureHosts({ workerDir: dir, hosted: [EMAIL, MEDIA], bound: [EMAIL, MEDIA], indexes: [] });
    await bindFeatureHosts({ workerDir: dir, hosted: [EMAIL, MEDIA], bound: [MEDIA], indexes: [] });
    expect((await workflows()).workflows?.map((entry) => entry.binding)).toEqual([
      "KEY_ROTATION",
      "MEDIA_IMAGE_TO_TEXT",
    ]);
  });

  test("binds the feature's own indexes by binding", async () => {
    const index = { binding: "VECTORIZE", name: "replay-f643-feature-address--vector-notes" };
    await bindFeatureHosts({ workerDir: dir, hosted: [], bound: [], indexes: [index] });
    await bindFeatureHosts({ workerDir: dir, hosted: [], bound: [], indexes: [index] });
    expect((await workflows()).vectorize).toEqual([{ binding: "VECTORIZE", index_name: index.name }]);
  });
});
