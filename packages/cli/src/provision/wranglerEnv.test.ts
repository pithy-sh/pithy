// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentScope, featureScope } from "@pithy-sh/core/src/naming/provisionScope";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FeatureResource } from "../feature/manifest";
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

  const apply = (scope: typeof feature, extra: Partial<Parameters<typeof applyProvisionedEnv>[0]> = {}) =>
    applyProvisionedEnv({
      workerDir: dir,
      worker: "replay-board",
      scope,
      resources,
      services: [],
      secrets: [],
      ...extra,
    });

  test("writes each resource's id under env.<stanza>, preserving comments", async () => {
    await apply(feature);

    const raw = await readFile(wranglerPath, "utf8");
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

    const parsed = parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed;
    expect(parsed.env.feature?.d1_databases?.[0]?.database_id).toBe("uuid-1");
    expect(parsed.env.staging?.d1_databases?.[0]).toEqual({
      binding: "DB",
      database_name: "replay-staging-db",
      database_id: "uuid-2",
    });
    expect(parsed.env.staging?.name).toBe("replay-board-staging");
  });

  test("is idempotent: re-running with a different id replaces rather than duplicates", async () => {
    await apply(feature);
    await apply(feature, {
      resources: [{ kind: "d1", binding: "DB", name: "replay-f69-demo-db-d1", id: "uuid-2" }],
    });

    const stanza = (parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed).env.feature;
    expect(stanza?.d1_databases).toHaveLength(1);
    expect(stanza?.d1_databases?.[0]?.database_id).toBe("uuid-2");
  });

  test("names the Worker for the scope and points services at that scope's deployments", async () => {
    await apply(feature, { services: [{ binding: "WEB", service: "replay-f69-demo-replay-web" }] });

    const raw = await readFile(wranglerPath, "utf8");
    const stanza = (parse(raw) as unknown as Parsed).env.feature;

    expect(stanza?.name).toBe("replay-f69-demo-replay-board");
    expect(stanza?.services).toEqual([{ binding: "WEB", service: "replay-f69-demo-replay-web" }]);
    expect(raw).toContain("// a starting comment");
  });

  test("retargets a service in place rather than duplicating it", async () => {
    await apply(feature, { services: [{ binding: "WEB", service: "replay-f69-demo-replay-web" }] });
    await apply(feature, { services: [{ binding: "WEB", service: "replay-f69-demo-replay-web-v2" }] });

    const stanza = (parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed).env.feature;
    expect(stanza?.services).toEqual([{ binding: "WEB", service: "replay-f69-demo-replay-web-v2" }]);
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

    const stanza = (parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed).env.feature;
    expect(stanza?.secrets_store_secrets).toEqual([
      {
        binding: "SECRETS_ENCRYPTION_KEYS",
        store_id: "store-2",
        secret_name: "replay-f69-demo-secrets-encryption-keys",
      },
    ]);
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

    const stanza = (parse(await readFile(wranglerPath, "utf8")) as unknown as Parsed).env.feature;
    expect(stanza?.secrets_store_secrets?.map((entry) => entry.binding)).toEqual([
      "HAND_ADDED",
      "SECRETS_ENCRYPTION_KEYS",
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

    const raw = await readFile(wranglerPath, "utf8");
    expect(raw).toContain("// primary feature db"); // the in-array comment survived the write.
    const stanza = (parse(raw) as unknown as Parsed).env.feature;
    expect(stanza?.d1_databases).toEqual([
      { binding: "DB", database_name: "replay-f69-demo-db-d1", database_id: "new" },
    ]);
  });
});
