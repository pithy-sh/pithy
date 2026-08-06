// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerConfig } from "../project/config";
import { reactStub } from "./react";
import type { UiStub } from "./stubs";
import { wireAssets, wireManifest, wirePackage } from "./wire";

const WRANGLER = `{
  // The adopter's note. It must survive every edit pithy makes.
  "name": "api",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01"
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
    const change = await wireAssets(dir, CONFIG);
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
    await wireAssets(dir, CONFIG);
    const once = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    const again = await wireAssets(dir, CONFIG);
    expect(again.before).toEqual(again.after);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(once);

    const grown = await wireAssets(dir, {
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
    });
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
    const workerDir = await scaffoldWorker();
    const installed = join(dir, "node_modules", "@pithy-sh", "vite");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify({ name: "@pithy-sh/vite", version: "0.1.0" }));

    const change = await wirePackage(dir, workerDir, reactStub);
    const pkg = JSON.parse(await readFile(join(workerDir, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };

    expect(pkg.devDependencies["@pithy-sh/vite"]).toBe(reactStub.devDependencies["@pithy-sh/vite"]);
    expect(change.devDependencies).toContain("@pithy-sh/vite");
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
});
