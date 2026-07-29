import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry } from "@pithy-sh/core/src/workflow/spec";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { applyAppBindings, appWorkflowBindings, incompleteBindings } from "./appBindings";

/**
 * The provisioner-owned wrangler bindings.
 *
 * The property under test is one sentence: **a `workflows` or `vectorize` entry is never written without
 * the fields wrangler requires**. That is the defect this module exists to close — `pithy add` used to
 * write `{ binding: "STORAGE_SWEEP" }`, which fails wrangler's config validation, so the adopter's
 * `wrangler.jsonc` stopped loading and no command ever completed the entry.
 */

/** A stand-in registry with one hosted job, shaped exactly like a capability's own. */
const registry: WorkflowRegistry = {
  [workflowKey("storage", "sweep")]: {
    key: workflowKey("storage", "sweep"),
    capability: "storage",
    job: "sweep",
    spec: { binding: "STORAGE_SWEEP", className: "StorageSweepWorkflow", params: z.object({}) },
  },
};

/** The stanza shape these tests read back out of the written file. */
interface Stanza {
  workflows?: { binding: string; name?: string; class_name?: string; script_name?: string }[];
  vectorize?: { binding: string; index_name?: string; remote?: boolean }[];
}
interface Wrangler extends Stanza {
  env?: Record<string, Stanza | undefined>;
}

const fixture = `{
  "name": "pithy-app",
  "main": "src/index.ts",

  // The app database. Every capability shares it.
  "d1_databases": [{ "binding": "DB" }],

  "env": {
    "staging": {
      "d1_databases": [{ "binding": "DB" }]
    }
  }
}
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-appbindings-"));
  await writeFile(join(dir, "wrangler.jsonc"), fixture);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<Wrangler> =>
  parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as Wrangler;

describe("appWorkflowBindings", () => {
  test("carries every field wrangler requires, plus the host script the class lives in", () => {
    expect(appWorkflowBindings(registry, "storage", "staging")).toEqual([
      {
        binding: "STORAGE_SWEEP",
        name: "pithy-storage-sweep-staging",
        class_name: "StorageSweepWorkflow",
        script_name: "pithy-storage-staging",
      },
    ]);
  });

  test("the names are environment-scoped — which is why add cannot write them", () => {
    const [staging] = appWorkflowBindings(registry, "storage", "staging");
    const [production] = appWorkflowBindings(registry, "storage", "production");
    expect(staging?.name).not.toBe(production?.name);
    expect(staging?.script_name).not.toBe(production?.script_name);
  });
});

describe("applyAppBindings", () => {
  test("writes a complete workflows entry into env.<env>", async () => {
    await applyAppBindings(dir, "staging", { workflows: appWorkflowBindings(registry, "storage", "staging") });

    const stanza = (await read()).env?.staging;
    expect(stanza?.workflows).toEqual([
      {
        binding: "STORAGE_SWEEP",
        name: "pithy-storage-sweep-staging",
        class_name: "StorageSweepWorkflow",
        script_name: "pithy-storage-staging",
      },
    ]);
    // The regression, stated as the property: nothing incomplete reached the file.
    expect(incompleteBindings(stanza)).toEqual([]);
  });

  test("writes a complete vectorize entry, index name and all", async () => {
    await applyAppBindings(dir, "staging", {
      vectorize: [{ binding: "VECTORIZE", index_name: "pithy-vector-docs-staging", remote: true }],
    });

    const stanza = (await read()).env?.staging;
    expect(stanza?.vectorize).toEqual([
      { binding: "VECTORIZE", index_name: "pithy-vector-docs-staging", remote: true },
    ]);
    expect(incompleteBindings(stanza)).toEqual([]);
  });

  test("dev writes the top-level stanza, because wrangler's default environment is not env.dev", async () => {
    await applyAppBindings(dir, "dev", { workflows: appWorkflowBindings(registry, "storage", "dev") });

    const config = await read();
    expect(config.workflows?.[0]?.name).toBe("pithy-storage-sweep-dev");
    expect(config.env?.dev).toBeUndefined();
  });

  test("is idempotent and keeps the adopter's comments", async () => {
    const bindings = { workflows: appWorkflowBindings(registry, "storage", "staging") };
    await applyAppBindings(dir, "staging", bindings);
    const once = await readFile(join(dir, "wrangler.jsonc"), "utf8");

    await applyAppBindings(dir, "staging", bindings);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(once);
    expect(once).toContain("// The app database. Every capability shares it.");
  });

  test("re-provisioning replaces the entry rather than appending a second one", async () => {
    await applyAppBindings(dir, "staging", {
      vectorize: [{ binding: "VECTORIZE", index_name: "pithy-vector-docs-staging", remote: true }],
    });
    await applyAppBindings(dir, "staging", {
      vectorize: [{ binding: "VECTORIZE", index_name: "pithy-vector-faqs-staging", remote: true }],
    });

    expect((await read()).env?.staging?.vectorize).toEqual([
      { binding: "VECTORIZE", index_name: "pithy-vector-faqs-staging", remote: true },
    ]);
  });

  test("nothing to write touches no file", async () => {
    await applyAppBindings(dir, "staging", {});
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(fixture);
  });

  test("refuses to write when a hand-edited entry already lacks a required field", async () => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{
  "name": "pithy-app",
  "main": "src/index.ts",
  "env": { "staging": { "vectorize": [{ "binding": "LEGACY" }] } }
}
`,
    );
    const before = await readFile(join(dir, "wrangler.jsonc"), "utf8");

    await expect(
      applyAppBindings(dir, "staging", { workflows: appWorkflowBindings(registry, "storage", "staging") }),
    ).rejects.toBeInstanceOf(PithyError);
    // And the file is untouched: a refusal never leaves a half-written config behind.
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(before);
  });
});

describe("incompleteBindings", () => {
  test("names the missing field of the entry pithy add used to write", () => {
    expect(incompleteBindings({ workflows: [{ binding: "STORAGE_SWEEP" }] })).toEqual([
      "workflows[STORAGE_SWEEP] is missing name, class_name",
    ]);
  });

  test("a vectorize entry with no index_name is incomplete", () => {
    expect(incompleteBindings({ vectorize: [{ binding: "VECTORIZE" }] })).toEqual([
      "vectorize[VECTORIZE] is missing index_name",
    ]);
  });

  test("a complete stanza reports nothing, and a stanza with neither key is fine", () => {
    expect(
      incompleteBindings({
        workflows: [{ binding: "B", name: "n", class_name: "C", script_name: "s" }],
        vectorize: [{ binding: "V", index_name: "i" }],
      }),
    ).toEqual([]);
    expect(incompleteBindings({ d1_databases: [{ binding: "DB" }] })).toEqual([]);
  });
});
