// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentScope, featureScope, type ProvisionWorkerNames } from "@pithy-sh/core/src/naming/provisionScope";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FeatureResource } from "../feature/manifest";
import { unrepeatedKeys } from "../project/wranglerInheritance";
import { featureConfigPath } from "./featureConfig";
import { applyProvisionedEnv } from "./wranglerEnv";

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
    { kind: "d1", binding: "DB", name: "replay-f69-demo-db-d1", id: "uuid-1" },
    { kind: "kv", binding: "CACHE", name: "replay-f69-demo-cache-kv", id: "ns-1" },
    { kind: "r2", binding: "ASSETS", name: "replay-f69-demo-assets-r2", id: "bucket-1" },
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
      database_name: "replay-f69-demo-db-d1",
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
      resources: [{ kind: "d1", binding: "DB", name: "replay-f69-demo-db-d1", id: "uuid-2" }],
    });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.d1_databases).toHaveLength(1);
    expect(stanza?.d1_databases?.[0]?.database_id).toBe("uuid-2");
  });

  /**
   * `<project>-f<issue>-<slug>-<app>`, with the project once. This pinned `replay-f69-demo-replay-board`
   * until #587 — the defect, locked in by the test that should have caught it.
   */
  test("names the Worker for the scope and points services at that scope's deployments", async () => {
    await apply(feature, { services: [{ binding: "WEB", service: "replay-f69-demo-web" }] });

    const raw = await read(feature);
    const stanza = (parse(raw) as unknown as Parsed).env.feature;

    expect(stanza?.name).toBe("replay-f69-demo-board");
    expect(stanza?.services).toEqual([{ binding: "WEB", service: "replay-f69-demo-web" }]);
    expect(raw).toContain("// a starting comment");
  });

  test("retargets a service in place rather than duplicating it", async () => {
    await apply(feature, { services: [{ binding: "WEB", service: "replay-f69-demo-web" }] });
    await apply(feature, { services: [{ binding: "WEB", service: "replay-f69-demo-web-v2" }] });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.services).toEqual([{ binding: "WEB", service: "replay-f69-demo-web-v2" }]);
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
          secret_name: "replay-f69-demo-secrets-encryption-keys",
        },
      ],
    });
    await apply(feature, {
      secrets: [
        {
          binding: "SECRETS_ENCRYPTION_KEYS",
          store_id: "store-2",
          secret_name: "replay-f69-demo-secrets-encryption-keys",
        },
      ],
    });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.secrets_store_secrets).toEqual([
      {
        binding: "SECRETS_ENCRYPTION_KEYS",
        store_id: "store-2",
        secret_name: "replay-f69-demo-secrets-encryption-keys",
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
      services: [{ binding: "WEB", service: "replay-f69-demo-web" }],
      secrets: [{ binding: "SECRETS_ENCRYPTION_KEYS", store_id: "store-1", secret_name: "replay-f69-demo-keys" }],
    });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.name).toBe("replay-f69-demo-board");
    expect(stanza?.d1_databases?.[0]?.database_id).toBe("uuid-1");
    expect(stanza?.services).toEqual([{ binding: "WEB", service: "replay-f69-demo-web" }]);
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
    expect(stanza?.name).toBe("replay-f69-demo-board");
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
    expect(stanza?.services).toEqual([{ binding: "SELF", service: "replay-f69-demo-board" }]);
  });

  /** Declared, never inferred: a project that says nothing gets nothing, and its stanza is untouched. */
  test("a project that does not declare it gets no services entry at all", async () => {
    await apply(feature);

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.services).toBeUndefined();
  });

  /** A capability's own service bindings keep their targets; the self entry joins them. */
  test("the self entry sits beside the service bindings a capability declares", async () => {
    await apply(feature, { administersItself: true, services: [{ binding: "WEB", service: "replay-f69-demo-web" }] });

    const stanza = (parse(await read(feature)) as unknown as Parsed).env.feature;
    expect(stanza?.services).toEqual([
      { binding: "WEB", service: "replay-f69-demo-web" },
      { binding: "SELF", service: "replay-f69-demo-board" },
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
      resources: [{ kind: "d1", binding: "DB", name: "replay-f69-demo-db-d1", id: "new" }],
    });

    const raw = await read(feature);
    expect(raw).toContain("// primary feature db"); // the in-array comment survived the write.
    const stanza = (parse(raw) as unknown as Parsed).env.feature;
    expect(stanza?.d1_databases).toEqual([
      { binding: "DB", database_name: "replay-f69-demo-db-d1", database_id: "new" },
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
      BASE_URL: "https://replay-f643-feature-address-board.acme.workers.dev",
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

  test("a declared environment is never stamped from workers.dev (#89)", async () => {
    await provision(environmentScope("replay", "staging"), "acme");

    expect((await stanzaVars(wranglerPath, "staging"))?.BASE_URL).toBe("https://app.example.com");
  });
});
