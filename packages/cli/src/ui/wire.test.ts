// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerConfig } from "../project/config";
import { kitRange } from "../project/scaffold";
import { reactStub } from "./react";
import type { UiStub } from "./stubs";
import { wireAssets, wireManifest, wirePackage, wireSolution } from "./wire";

const WRANGLER = `{
  // The adopter's note. It must survive every edit pithy makes.
  "name": "api",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01"
}
`;

const SOLUTION = `{
  // The adopter's note. It must survive every edit pithy makes.
  "files": [],
  "references": [{ "path": "./apps/api/tsconfig.json" }]
}
`;

const MANIFEST = `{
  // How pithy dev runs this worker locally.
  "dev": {
    "autostart": false,
    "readySignal": "Ready on https?://"
  }
}
`;

const PACKAGE = `${JSON.stringify(
  {
    name: "acme-api",
    private: true,
    type: "module",
    scripts: { dev: "wrangler dev", deploy: "wrangler deploy" },
    dependencies: { "@pithy-sh/core": "^0.0.0", react: "^19.9.9" },
    devDependencies: { wrangler: "^4.115.0" },
  },
  null,
  2,
)}\n`;

const CONFIG: WorkerConfig = {
  capabilities: [
    defineCapability({
      name: "auth",
      requiredBindings: [],
      routes: (app) => {
        app.post("/auth/sign-in/magic-link", (c) => c.json({}));
      },
    }),
  ],
};

/** The environments a project declares when it says nothing — what `pithy init` writes. */
const DECLARED = ["staging", "prod"];

describe("wire", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-ui-wire-"));
    await writeFile(join(dir, "wrangler.jsonc"), WRANGLER);
    await writeFile(join(dir, "pithy.worker.jsonc"), MANIFEST);
    await writeFile(join(dir, "package.json"), PACKAGE);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A worker at `apps/api` under the project root, so `projectDir` and `workerDir` are the two different
   * directories they are in a real project — the packages resolve from the root, the manifest is the
   * worker's.
   */
  async function scaffoldWorker(overrides: Record<string, unknown> = {}): Promise<string> {
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    const pkg = { ...(JSON.parse(PACKAGE) as Record<string, unknown>), ...overrides };
    await writeFile(join(workerDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    return workerDir;
  }

  test("wireAssets writes the SPA stanza with the derived allowlist and NO directory", async () => {
    const change = await wireAssets(dir, CONFIG, DECLARED);
    expect(change.before).toBeNull();

    const raw = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    const config = parse(raw) as unknown as {
      assets: { not_found_handling: string; run_worker_first: string[]; directory?: string };
    };
    expect(config.assets.not_found_handling).toBe("single-page-application");
    expect(config.assets.run_worker_first).toEqual(["/auth", "/auth/*", "/health", "/health/*"]);
    // The Vite plugin supplies `directory` and overwrites whatever is there without complaining,
    // so writing one would be a line in the adopter's config that only looks authoritative.
    expect(config.assets.directory).toBeUndefined();
    expect(raw).not.toContain("directory");
    // The adopter's comment survived.
    expect(raw).toContain("The adopter's note.");
  });

  test("wireAssets is idempotent and re-derives on a changed route table", async () => {
    await wireAssets(dir, CONFIG, DECLARED);
    const once = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    const again = await wireAssets(dir, CONFIG, DECLARED);
    expect(again.before).toEqual(again.after);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(once);

    const grown = await wireAssets(
      dir,
      {
        capabilities: [
          ...CONFIG.capabilities,
          defineCapability({
            name: "ledger",
            requiredBindings: [],
            routes: (app) => {
              app.get("/ledger/balance", (c) => c.json({}));
            },
          }),
        ],
      },
      DECLARED,
    );
    expect(grown.before).toEqual(["/auth", "/auth/*", "/health", "/health/*"]);
    expect(grown.after).toContain("/ledger");
    expect(grown.after).toContain("/ledger/*");
    // The comment is still there after the in-place array update.
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toContain("The adopter's note.");
  });

  test("wireManifest writes the dev block and the ui block, resolved for the adopter's package manager", async () => {
    await wireManifest(dir, reactStub, "bun");
    const raw = await readFile(join(dir, "pithy.worker.jsonc"), "utf8");
    const manifest = parse(raw) as unknown as {
      dev: { autostart: boolean; readySignal: string; command: string[] };
      ui: { stub: string; build: string[] };
    };
    expect(manifest.dev.autostart).toBe(true);
    expect(manifest.dev.readySignal).toBe("ready in \\d+");
    expect(manifest.dev.command).toEqual([
      "bun",
      "x",
      "vite",
      "dev",
      "--configLoader",
      "runner",
      "--strictPort",
      "--port",
      "{port}",
    ]);
    expect(manifest.ui).toEqual({ stub: "react", build: ["vite", "build", "--configLoader", "runner"] });
    expect(raw).toContain("How pithy dev runs this worker locally.");
  });

  test("wireManifest never gates adoption behind Bun", async () => {
    await wireManifest(dir, reactStub, "npm");
    const manifest = parse(await readFile(join(dir, "pithy.worker.jsonc"), "utf8")) as unknown as {
      dev: { command: string[] };
    };
    expect(manifest.dev.command).toEqual([
      "npx",
      "vite",
      "dev",
      "--configLoader",
      "runner",
      "--strictPort",
      "--port",
      "{port}",
    ]);
  });

  test("wirePackage merges — an existing pin is never downgraded", async () => {
    const change = await wirePackage(dir, dir, reactStub);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    // react was already pinned ahead of the stub's version; it keeps the adopter's pin.
    expect(pkg.dependencies.react).toBe("^19.9.9");
    expect(change.dependencies).toEqual(["react-dom"]);
    expect(pkg.dependencies["react-dom"]).toBe("^19.2.8");
    expect(pkg.devDependencies.vite).toBe("^8.0.16");
    // Every existing key survives.
    expect(pkg.name).toBe("acme-api");
    expect(pkg.dependencies["@pithy-sh/core"]).toBe("^0.0.0");
    expect(pkg.scripts.deploy).toBe("wrangler deploy");
    // The one replacement: pithy's own scaffolded `wrangler dev`, which serving through Vite supersedes.
    expect(pkg.scripts).toMatchObject({
      dev: "vite dev --configLoader runner",
      build: "vite build --configLoader runner",
      preview: "vite preview --configLoader runner",
    });
  });

  test("wirePackage keeps a dev script the adopter wrote", async () => {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    pkg.scripts.dev = "wrangler dev --remote";
    await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

    await wirePackage(dir, dir, reactStub);
    const after = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(after.scripts.dev).toBe("wrangler dev --remote");
  });

  test("wirePackage writes no registry range for a @pithy-sh package a checkout provides", async () => {
    // The local-checkout case: `@pithy-sh/vite` is linked in, and nothing under the scope is published.
    // A `"^0.0.0"` here succeeds now and 404s on the adopter's next install — the failure lands on an
    // unrelated command, days later.
    const workerDir = await scaffoldWorker();
    const checkout = join(dir, "checkout", "vite");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "@pithy-sh/vite" }));
    await mkdir(join(dir, "node_modules", "@pithy-sh"), { recursive: true });
    await symlink(checkout, join(dir, "node_modules", "@pithy-sh", "vite"), "dir");

    const change = await wirePackage(dir, workerDir, reactStub);
    const pkg = JSON.parse(await readFile(join(workerDir, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };

    expect(pkg.devDependencies["@pithy-sh/vite"]).toBeUndefined();
    expect(change.devDependencies).not.toContain("@pithy-sh/vite");
    // Every registry package still lands — the rule is about the unpublished scope, not about hoisting.
    expect(pkg.devDependencies.vite).toBe("^8.0.16");
    expect(change.devDependencies).toContain("@vitejs/plugin-react");
  });

  test("wirePackage writes the @pithy-sh range when the project has no checkout linked in", async () => {
    // The published world, and the hoisted-transitive one: a real directory in `node_modules` is a
    // registry install with a version, so the range is correct and the worker must declare it. Omitting
    // it would leave the build resolving whatever happened to be hoisted, unpinned and unlocked.
    //
    // Until the scope publishes there IS no correct range, so the line is dropped instead — the same
    // answer `kitRange` gives the starter template. Both sides asserted from `kitRange`, so the release
    // commit flips this test's expectation without editing it.
    const workerDir = await scaffoldWorker();
    const installed = join(dir, "node_modules", "@pithy-sh", "vite");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify({ name: "@pithy-sh/vite", version: "0.1.0" }));

    const change = await wirePackage(dir, workerDir, reactStub);
    const pkg = JSON.parse(await readFile(join(workerDir, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };

    const range = kitRange(PACKAGE_VERSION);
    expect(pkg.devDependencies["@pithy-sh/vite"]).toBe(range ?? undefined);
    expect(change.devDependencies.includes("@pithy-sh/vite")).toBe(range !== null);
  });

  test("wirePackage writes no range the registry cannot resolve, whatever the project looks like", async () => {
    // The adopter this regressed for: a plain project, nothing under `@pithy-sh` linked in, so
    // `withoutProvided` keeps every stub package — and `pithy ui add react` said Done while planting
    // `"@pithy-sh/vite": "^0.0.0"`. The 404 landed on the next `bun install`, on an unrelated command.
    // Asserting an absence, so it stays true after the scope publishes. The worker starts with empty
    // dependency maps: whatever an adopter already declared is theirs and is never rewritten, so only
    // what this call adds is on trial here.
    const workerDir = await scaffoldWorker({ dependencies: {}, devDependencies: {} });
    await wirePackage(dir, workerDir, reactStub);
    const pkg = JSON.parse(await readFile(join(workerDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    for (const [name, declared] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(declared, name).not.toBe("^0.0.0");
    }
  });

  test("wirePackage drops a provided @pithy-sh runtime dependency too, not only a dev one", async () => {
    // `withoutProvided` guards both maps. The react stub happens to carry the scope only in
    // devDependencies, so the runtime call site would otherwise never be exercised.
    const workerDir = await scaffoldWorker({ dependencies: {} });
    const checkout = join(dir, "checkout", "core");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "@pithy-sh/core" }));
    await mkdir(join(dir, "node_modules", "@pithy-sh"), { recursive: true });
    await symlink(checkout, join(dir, "node_modules", "@pithy-sh", "core"), "dir");

    const stub: UiStub = {
      ...reactStub,
      dependencies: { "@pithy-sh/core": "^0.0.0", react: "^19.2.8" },
    };
    const change = await wirePackage(dir, workerDir, stub);
    const pkg = JSON.parse(await readFile(join(workerDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(pkg.dependencies["@pithy-sh/core"]).toBeUndefined();
    expect(change.dependencies).toEqual(["react"]);
  });

  test("wirePackage is idempotent", async () => {
    await wirePackage(dir, dir, reactStub);
    const once = await readFile(join(dir, "package.json"), "utf8");
    const change = await wirePackage(dir, dir, reactStub);
    expect(change).toEqual({ dependencies: [], devDependencies: [], scripts: [] });
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(once);
  });

  test("wireSolution adds the client's programs to the root tsconfig, comments intact", async () => {
    // Two tsconfigs nothing references are two tsconfigs nothing checks — which is what `pithy ui add`
    // left behind, so an adopter's `typecheck` covered the Worker and none of the client it just wrote.
    await writeFile(join(dir, "tsconfig.json"), SOLUTION);

    expect(await wireSolution(dir, "api")).toEqual([
      "./apps/api/tsconfig.client.json",
      "./apps/api/tsconfig.node.json",
    ]);

    const written = await readFile(join(dir, "tsconfig.json"), "utf8");
    expect(written).toContain("The adopter's note");
    const solution = parse(written) as unknown as { files: string[]; references: { path: string }[] };
    expect(solution.files).toEqual([]);
    expect(solution.references.map((reference) => reference.path)).toEqual([
      "./apps/api/tsconfig.json",
      "./apps/api/tsconfig.client.json",
      "./apps/api/tsconfig.node.json",
    ]);
  });

  test("wireSolution is idempotent", async () => {
    // `pithy ui add --auth` backfills a scaffold created with `--no-auth`, and that run wires everything
    // again. A second reference to the same program is a `tsc -b` error, not a duplicate it tolerates.
    await writeFile(join(dir, "tsconfig.json"), SOLUTION);
    await wireSolution(dir, "api");
    const once = await readFile(join(dir, "tsconfig.json"), "utf8");

    expect(await wireSolution(dir, "api")).toEqual([]);
    expect(await readFile(join(dir, "tsconfig.json"), "utf8")).toBe(once);
  });

  test("wireSolution leaves a project that has no solution file alone", async () => {
    // A project scaffolded before the root tsconfig existed has Workers whose programs are not
    // `composite`, and `tsc -b` refuses a reference to one of those outright. Writing the file would hand
    // that adopter a typecheck that cannot pass.
    expect(await wireSolution(dir, "api")).toEqual([]);
    await expect(readFile(join(dir, "tsconfig.json"), "utf8")).rejects.toThrow();
  });
});

/**
 * A `package.json` that is missing and one that is malformed are different faults (#217).
 *
 * One `try` wrapped the read and the parse, and answered both with *pithy worker add creates one*. For a
 * worker whose `package.json` is there and holds a stray comma, that command will not run — it refuses
 * on an existing worker — so the adopter is sent to a door that is already shut.
 */
describe("wirePackage refusals", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-wire-refusal-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a missing package.json is the one case `pithy worker add` answers", async () => {
    await expect(wirePackage(dir, dir, reactStub)).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).toMatch(/pithy worker add/);
      return true;
    });
  });

  test("a package.json that is not JSON is never answered with `pithy worker add`", async () => {
    await writeFile(join(dir, "package.json"), '{ "name": "api",, }', "utf8");

    await expect(wirePackage(dir, dir, reactStub)).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).not.toMatch(/pithy worker add/);
      expect(error.payload.action).toMatch(/JSON/i);
      return true;
    });
  });

  test("a package.json holding valid JSON that is not an object is not a missing file either", async () => {
    await writeFile(join(dir, "package.json"), "[]", "utf8");

    await expect(wirePackage(dir, dir, reactStub)).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).not.toMatch(/pithy worker add/);
      return true;
    });
  });

  test("a package.json that is a directory is not a missing file", async () => {
    await mkdir(join(dir, "package.json"));

    await expect(wirePackage(dir, dir, reactStub)).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).not.toMatch(/pithy worker add/);
      return true;
    });
  });
});
