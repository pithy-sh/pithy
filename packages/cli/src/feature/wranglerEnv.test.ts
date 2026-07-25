import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FeatureResource } from "./manifest";
import { applyProvisionedIds, applyWorkerEnv } from "./wranglerEnv";

interface ParsedEnvBindings {
  env: {
    feature: {
      name?: string;
      services?: { binding: string; service: string }[];
      d1_databases?: { binding: string; database_id: string }[];
      kv_namespaces?: { binding: string; id: string }[];
      r2_buckets?: { binding: string; bucket_name: string }[];
    };
  };
}

describe("applyProvisionedIds", () => {
  let dir: string;
  let wranglerPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-wranglerenv-"));
    wranglerPath = join(dir, "wrangler.jsonc");
    await writeFile(wranglerPath, ["{", "  // a starting comment", '  "name": "app"', "}", ""].join("\n"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const resources: FeatureResource[] = [
    { kind: "d1", binding: "DB", name: "acme-f69-x-db-d1", id: "uuid-1" },
    { kind: "kv", binding: "CACHE", name: "acme-f69-x-cache-kv", id: "ns-1" },
    { kind: "r2", binding: "ASSETS", name: "acme-f69-x-assets-r2", id: "bucket-1" },
  ];

  test("writes each resource's id under env.<env>, preserving comments", async () => {
    await applyProvisionedIds(dir, "feature", resources);

    const raw = await readFile(wranglerPath, "utf8");
    const config = parse(raw) as unknown as ParsedEnvBindings;

    expect(config.env.feature.d1_databases).toContainEqual({ binding: "DB", database_id: "uuid-1" });
    expect(config.env.feature.kv_namespaces).toContainEqual({ binding: "CACHE", id: "ns-1" });
    expect(config.env.feature.r2_buckets).toContainEqual({ binding: "ASSETS", bucket_name: "bucket-1" });
    expect(raw).toContain("// a starting comment");
  });

  test("is idempotent: re-running with a different id replaces rather than duplicates", async () => {
    await applyProvisionedIds(dir, "feature", resources);
    await applyProvisionedIds(dir, "feature", [{ kind: "d1", binding: "DB", name: "acme-f69-x-db-d1", id: "uuid-2" }]);

    const raw = await readFile(wranglerPath, "utf8");
    const config = parse(raw) as unknown as ParsedEnvBindings;

    expect(config.env.feature.d1_databases).toHaveLength(1);
    expect(config.env.feature.d1_databases?.[0]).toEqual({ binding: "DB", database_id: "uuid-2" });
  });

  test("applyWorkerEnv names the Worker for the env and points services at the feature's own deployments", async () => {
    await applyWorkerEnv({
      workerDir: dir,
      env: "feature",
      name: "acme-f69-demo-api",
      services: [{ binding: "WEB", service: "acme-f69-demo-web" }],
    });

    const raw = await readFile(wranglerPath, "utf8");
    const config = parse(raw) as unknown as ParsedEnvBindings;

    expect(config.env.feature.name).toBe("acme-f69-demo-api");
    expect(config.env.feature.services).toEqual([{ binding: "WEB", service: "acme-f69-demo-web" }]);
    expect(raw).toContain("// a starting comment");
  });

  test("applyWorkerEnv is idempotent — re-running retargets in place rather than duplicating", async () => {
    const call = (service: string) =>
      applyWorkerEnv({
        workerDir: dir,
        env: "feature",
        name: "acme-f69-demo-api",
        services: [{ binding: "WEB", service }],
      });

    await call("acme-f69-demo-web");
    await call("acme-f69-demo-web-v2");

    const config = parse(await readFile(wranglerPath, "utf8")) as unknown as ParsedEnvBindings;
    expect(config.env.feature.services).toEqual([{ binding: "WEB", service: "acme-f69-demo-web-v2" }]);
  });

  test("applyWorkerEnv composes with applyProvisionedIds on the same env stanza", async () => {
    await applyProvisionedIds(dir, "feature", resources);
    await applyWorkerEnv({ workerDir: dir, env: "feature", name: "acme-f69-demo-api", services: [] });

    const config = parse(await readFile(wranglerPath, "utf8")) as unknown as ParsedEnvBindings;
    // Both writers layer onto one stanza; neither clobbers the other.
    expect(config.env.feature.name).toBe("acme-f69-demo-api");
    expect(config.env.feature.d1_databases).toContainEqual({ binding: "DB", database_id: "uuid-1" });
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

    await applyProvisionedIds(dir, "feature", [{ kind: "d1", binding: "DB", name: "acme-f69-x-db-d1", id: "new" }]);

    const raw = await readFile(wranglerPath, "utf8");
    expect(raw).toContain("// primary feature db"); // the in-array comment survived the write.
    const config = parse(raw) as unknown as ParsedEnvBindings;
    expect(config.env.feature.d1_databases).toEqual([{ binding: "DB", database_id: "new" }]);
  });
});
