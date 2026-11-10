// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { defineVars } from "@pithy-sh/core/src/worker/vars";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { copiedFromTopLevel, declaredWorkerVars, reconcileWorkerVars } from "./workerVars";

const VARS = defineVars({
  READY_AFTER_MINUTES: {
    description: "Minutes after the cron the next file is ready.",
    schema: z.number().int().min(0),
    default: 15,
    environments: { prod: 30 },
  },
});

const WRANGLER = `{
  "name": "stats-api",
  // The top level is dev.
  "vars": { "ENVIRONMENT": "dev" },
  "env": {
    "staging": { "name": "stats-staging-api", "vars": { "ENVIRONMENT": "staging" } },
    "prod": { "name": "stats-prod-api", "vars": { "ENVIRONMENT": "prod" } }
  }
}
`;

type Config = { vars?: Record<string, unknown>; env: Record<string, { vars?: Record<string, unknown> }> };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-vars-"));
  await writeFile(join(dir, "wrangler.jsonc"), WRANGLER);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function config(): Promise<Config> {
  return parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as Config;
}

describe("declaredWorkerVars", () => {
  test("collects the Worker's own vars and every composed capability's", () => {
    const feed = defineCapability({
      name: "feed",
      requiredBindings: [],
      vars: defineVars({ FEED_URL: { description: "Where the feed is.", schema: z.string(), default: "x" } }),
    });
    const declared = declaredWorkerVars({ vars: VARS }, [feed]);
    expect([...declared.keys()]).toEqual(["READY_AFTER_MINUTES", "FEED_URL"]);
    expect(declared.get("FEED_URL")?.from).toBe("feed");
    expect(declared.get("READY_AFTER_MINUTES")?.from).toBe("pithy.config.ts");
  });

  test("is empty for a Worker that declares none", () => {
    expect(declaredWorkerVars({}, []).size).toBe(0);
  });

  test("refuses a vars key not built with defineVars", () => {
    expect(() => declaredWorkerVars({ vars: { READY_AFTER_MINUTES: 15 } }, [])).toThrow(/defineVars/);
  });

  test("refuses a name two sources declare, naming both", () => {
    const twin = defineCapability({ name: "twin", requiredBindings: [], vars: VARS });
    expect(() => declaredWorkerVars({ vars: VARS }, [twin])).toThrow(/READY_AFTER_MINUTES.*pithy\.config\.ts.*twin/);
  });
});

describe("copiedFromTopLevel", () => {
  const entry = (environments?: Record<string, number>) =>
    defineVars({
      MINUTES: { description: "Minutes.", schema: z.number(), default: 15, ...(environments ? { environments } : {}) },
    }).vars.MINUTES;

  test("is the top level's value held where the environment declares its own", () => {
    expect(copiedFromTopLevel(entry({ prod: 30 }), "prod", 15, 15)).toBe(true);
    expect(copiedFromTopLevel(entry({ dev: 5, prod: 30 }), "prod", 5, 5)).toBe(true);
  });

  test("never fires for the top level itself", () => {
    expect(copiedFromTopLevel(entry({ dev: 5 }), "dev", 15, 15)).toBe(false);
  });

  test("is false where the stanza holds nothing, or the top level holds nothing", () => {
    expect(copiedFromTopLevel(entry({ prod: 30 }), "prod", undefined, 15)).toBe(false);
    expect(copiedFromTopLevel(entry({ prod: 30 }), "prod", 15, undefined)).toBe(false);
  });

  test("is false where the held value differs from the top level's, or is already the environment's", () => {
    expect(copiedFromTopLevel(entry({ prod: 30 }), "prod", 20, 15)).toBe(false);
    expect(copiedFromTopLevel(entry({ prod: 30 }), "prod", 30, 30)).toBe(false);
  });

  test("is false where no environment declares a value of its own", () => {
    expect(copiedFromTopLevel(entry(), "staging", 15, 15)).toBe(false);
  });

  test("compares against dev's value, not the default", () => {
    // default 15, dev 5, no staging value: staging takes 15, which is not dev's, so a held 5 is a copy.
    expect(copiedFromTopLevel(entry({ dev: 5 }), "staging", 5, 5)).toBe(true);
    // default 15, dev 5, staging 15: staging's own equals the default but not dev's, so the copied 5 is rewritten.
    expect(copiedFromTopLevel(entry({ dev: 5, staging: 15 }), "staging", 5, 5)).toBe(true);
    // default 15, dev 5, staging 5: staging's own is dev's, so a held 5 is the declared value.
    expect(copiedFromTopLevel(entry({ dev: 5, staging: 5 }), "staging", 5, 5)).toBe(false);
  });
});

describe("reconcileWorkerVars", () => {
  const declared = () => declaredWorkerVars({ vars: VARS }, []);

  test("writes each var into the top level and every env stanza, the environment's value or the default", async () => {
    const runs = await reconcileWorkerVars({ workerDir: dir, declared: declared() });
    expect(runs).toEqual([
      { env: "dev", written: [{ name: "READY_AFTER_MINUTES", value: 15 }], invalid: [] },
      { env: "staging", written: [{ name: "READY_AFTER_MINUTES", value: 15 }], invalid: [] },
      { env: "prod", written: [{ name: "READY_AFTER_MINUTES", value: 30 }], invalid: [] },
    ]);
    const written = await config();
    expect(written.vars).toEqual({ ENVIRONMENT: "dev", READY_AFTER_MINUTES: 15 });
    expect(written.env.staging?.vars).toEqual({ ENVIRONMENT: "staging", READY_AFTER_MINUTES: 15 });
    expect(written.env.prod?.vars).toEqual({ ENVIRONMENT: "prod", READY_AFTER_MINUTES: 30 });
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toContain("// The top level is dev.");
  });

  test("is idempotent: a second run writes nothing and does not touch the file", async () => {
    await reconcileWorkerVars({ workerDir: dir, declared: declared() });
    const before = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    const stamp = (await stat(join(dir, "wrangler.jsonc"))).mtimeMs;
    const runs = await reconcileWorkerVars({ workerDir: dir, declared: declared() });
    expect(runs.every((run) => run.written.length === 0 && run.invalid.length === 0)).toBe(true);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(before);
    expect((await stat(join(dir, "wrangler.jsonc"))).mtimeMs).toBe(stamp);
  });

  test("keeps a valid value set by hand, and reports an invalid one without overwriting it", async () => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      WRANGLER.replace('"ENVIRONMENT": "staging"', '"ENVIRONMENT": "staging", "READY_AFTER_MINUTES": 5').replace(
        '"ENVIRONMENT": "prod"',
        '"ENVIRONMENT": "prod", "READY_AFTER_MINUTES": "soon"',
      ),
    );
    const runs = await reconcileWorkerVars({ workerDir: dir, declared: declared() });
    expect(runs.find((run) => run.env === "staging")).toEqual({ env: "staging", written: [], invalid: [] });
    const prod = runs.find((run) => run.env === "prod");
    expect(prod?.written).toEqual([]);
    expect(prod?.invalid).toEqual([{ name: "READY_AFTER_MINUTES", value: "soon", problem: expect.any(String) }]);
    const written = await config();
    expect(written.env.staging?.vars?.READY_AFTER_MINUTES).toBe(5);
    expect(written.env.prod?.vars?.READY_AFTER_MINUTES).toBe("soon");
  });

  test("rewrites a stanza holding the top level's value where the declaration gives that environment its own", async () => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      WRANGLER.replace('"ENVIRONMENT": "dev"', '"ENVIRONMENT": "dev", "READY_AFTER_MINUTES": 15')
        .replace('"ENVIRONMENT": "staging"', '"ENVIRONMENT": "staging", "READY_AFTER_MINUTES": 15')
        .replace('"ENVIRONMENT": "prod"', '"ENVIRONMENT": "prod", "READY_AFTER_MINUTES": 15'),
    );
    const runs = await reconcileWorkerVars({ workerDir: dir, declared: declared() });
    expect(runs.find((run) => run.env === "staging")?.written).toEqual([]);
    expect(runs.find((run) => run.env === "prod")?.written).toEqual([{ name: "READY_AFTER_MINUTES", value: 30 }]);
    expect((await config()).env.prod?.vars?.READY_AFTER_MINUTES).toBe(30);
  });

  test("writes a var named like an object's own key, which no stanza holds by inheritance", async () => {
    const entry = { description: "Shadowed.", schema: z.string(), default: "a" };
    const runs = await reconcileWorkerVars({
      workerDir: dir,
      declared: new Map([["constructor", { entry, from: "pithy.config.ts" }]]),
      env: "dev",
    });
    expect(runs).toEqual([{ env: "dev", written: [{ name: "constructor", value: "a" }], invalid: [] }]);
  });

  test("never deletes a var it did not declare", async () => {
    await reconcileWorkerVars({ workerDir: dir, declared: declared() });
    const written = await config();
    expect(written.vars?.ENVIRONMENT).toBe("dev");
    expect(written.env.prod?.vars?.ENVIRONMENT).toBe("prod");
  });

  test("narrows to one environment when asked", async () => {
    const runs = await reconcileWorkerVars({ workerDir: dir, declared: declared(), env: "prod" });
    expect(runs.map((run) => run.env)).toEqual(["prod"]);
    expect((await config()).vars?.READY_AFTER_MINUTES).toBeUndefined();
  });

  test("declares nothing, reads nothing, writes nothing", async () => {
    expect(await reconcileWorkerVars({ workerDir: dir, declared: new Map() })).toEqual([]);
  });
});
