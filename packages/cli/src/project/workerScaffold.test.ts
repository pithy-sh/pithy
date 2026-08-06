// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { NAMESPACE_PATTERN } from "@pithy-sh/core/src/migrations/registry";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { scaffoldWorker, workerNamespace } from "./workerScaffold";

describe("scaffoldWorker", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-worker-scaffold-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("stamps the worker's files, including its own pithy.config.ts", async () => {
    const { dir: workerDir } = await scaffoldWorker({ projectDir: dir, name: "web", project: "acme" });
    expect(workerDir).toBe(join(dir, "apps", "web"));

    // Every worker owns its config — capabilities, bindings, and DO class migrations attach to it.
    const config = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    expect(config).toContain("// pithy:capabilities");
    expect(config).toContain('name: "web"');
    // Its entrypoint composes that config, not a project-wide one.
    expect(await readFile(join(workerDir, "src", "index.ts"), "utf8")).toContain('from "../pithy.config"');

    const wrangler = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
      name: string;
      env: { staging: unknown; prod: unknown };
    };
    // The deploy name leads with the project. A Worker script name is account-flat, so the bare directory
    // name meant two projects that each added `web` deployed to one script and the second overwrote it.
    expect(wrangler.name).toBe("acme-web");
    expect(wrangler.env.staging).toBeDefined();
    expect(wrangler.env.prod).toBeDefined();

    const manifest = parse(await readFile(join(workerDir, "pithy.worker.jsonc"), "utf8")) as unknown as {
      dev: { autostart: boolean; readySignal: string };
    };
    expect(manifest.dev.autostart).toBe(true);
    expect(manifest.dev.readySignal).toBe("Ready on https?://");

    const pkg = JSON.parse(await readFile(join(workerDir, "package.json"), "utf8")) as { name: string };
    expect(pkg.name).toBe("acme-web");

    await readFile(join(workerDir, "src", "index.ts"), "utf8");
  });

  test("stamps the Worker's identity in every vars stanza, so it knows what it is and what it owns", async () => {
    // Media's routes mint Images/Stream uploads from the adopter's own Worker, and those two stores are
    // account-flat: an asset is keyed by a Cloudflare-minted id, so the `PROJECT` var is the only thing
    // that says who owns it (`assetOwner` refuses to mint without it). `WORKER` is the same problem one
    // level down — the runtime tells a script nothing about itself, and two Workers sharing a binding
    // share one database, so it is what separates their audit events. A capability cannot declare either
    // — `BindingType` has no `var` kind — so the scaffold owns them.
    const { dir: workerDir } = await scaffoldWorker({ projectDir: dir, name: "web", project: "acme" });
    const wrangler = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
      vars: Record<string, string>;
      env: Record<string, { vars: Record<string, string> }>;
    };

    // wrangler's `env.<name>.vars` REPLACES the top level rather than merging it, so a single top-level
    // PROJECT would be invisible to staging and production. All three must appear in all three stanzas.
    expect(wrangler.vars).toEqual({ ENVIRONMENT: "dev", PROJECT: "acme", WORKER: "web" });
    expect(wrangler.env.staging?.vars).toEqual({ ENVIRONMENT: "staging", PROJECT: "acme", WORKER: "web" });
    expect(wrangler.env.prod?.vars).toEqual({ ENVIRONMENT: "prod", PROJECT: "acme", WORKER: "web" });
  });

  test("a hyphenated worker gets a legal migration namespace, keeping its kebab-case directory", async () => {
    // The scaffolded app capability's name IS its migration namespace, and a namespace admits no hyphens.
    // Stamping the directory name verbatim wrote `name: "admin-api"`, whose first migration `pithy migrate`
    // rejected outright: 'migration namespace "admin-api" must match /^[a-z][a-z0-9]*$/'.
    const { dir: workerDir } = await scaffoldWorker({ projectDir: dir, name: "admin-api", project: "acme" });
    expect(workerDir).toBe(join(dir, "apps", "admin-api")); // the directory stays kebab-case

    const config = await readFile(join(workerDir, "pithy.config.ts"), "utf8");
    const namespace = config.match(/name: "([^"]+)"/)?.[1];
    expect(namespace).toBe("adminapi");
    expect(namespace).toMatch(NAMESPACE_PATTERN);
    // The Worker still deploys and installs under its real, kebab-case name, behind the project segment.
    const wrangler = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as { name: string };
    expect(wrangler.name).toBe("acme-admin-api");
  });

  test("every accepted worker name deploys under a scoped, Cloudflare-legal script name", async () => {
    // The isolation property, at the one surface that had lost it. `pithy init` already scoped its first
    // Worker (`acme-edge`); `pithy worker add` stamped the bare directory name, so two projects in one
    // account collided on every worker added after init. The two paths have to agree.
    for (const name of ["web", "admin-api", "2fa-api"]) {
      const target = join(dir, name);
      await mkdir(target, { recursive: true });
      const { dir: workerDir } = await scaffoldWorker({ projectDir: target, name, project: "acme" });
      const wrangler = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as {
        name: string;
      };
      expect(wrangler.name).toBe(`acme-${name}`);
      // wrangler parses `name` against this itself and refuses the config outright when it does not match.
      expect(wrangler.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("every accepted worker name yields a namespace the migration registry accepts", () => {
    // A namespace must start with a letter, so a digit-leading worker name cannot simply be stripped.
    for (const name of ["web", "admin-api", "a-b-c", "2fa-api", "9"]) {
      expect(workerNamespace(name)).toMatch(NAMESPACE_PATTERN);
    }
    expect(workerNamespace("2fa-api")).toBe("app2faapi");
  });

  test("emits the same tsconfig.json the starter gives apps/api — no second-class worker", async () => {
    // Workers have no root tsconfig to inherit, so a scaffold without one left the new Worker's src/index.ts
    // with no @cloudflare/workers-types and none of the repo's strictness — two Workers, two TS setups.
    const { dir: workerDir } = await scaffoldWorker({ projectDir: dir, name: "web", project: "acme" });
    const starter = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
      "templates/starter/apps/api/tsconfig.json",
    );

    // Comments stripped: the settings must match, the prose around them need not.
    const settings = async (path: string) =>
      parse(await readFile(path, "utf8"), null, true) as unknown as {
        compilerOptions: Record<string, unknown>;
      };
    const scaffolded = await settings(join(workerDir, "tsconfig.json"));
    const template = await settings(starter);

    // `tsBuildInfoFile` is the one setting that legitimately differs, and it must: `composite` makes tsc
    // write build state, and two Workers pointing at one file overwrite each other's. So it is compared
    // as a rule rather than as a string — each names its own Worker, under the project's dist/ and never
    // a Worker's own, which Vite empties on every client build.
    expect(scaffolded.compilerOptions.tsBuildInfoFile).toBe("../../dist/web.server.tsbuildinfo");
    expect(template.compilerOptions.tsBuildInfoFile).toBe("../../dist/api.server.tsbuildinfo");
    scaffolded.compilerOptions.tsBuildInfoFile = template.compilerOptions.tsBuildInfoFile;

    expect(scaffolded).toEqual(template);
    expect(scaffolded).toMatchObject({
      compilerOptions: { strict: true, composite: true, types: ["@cloudflare/workers-types"] },
    });
  });

  test("rejects a non-kebab-case name", async () => {
    await expect(scaffoldWorker({ projectDir: dir, name: "Web_App", project: "acme" })).rejects.toThrow(PithyError);
  });

  test("refuses to overwrite a non-empty apps/<name>", async () => {
    await mkdir(join(dir, "apps", "web"), { recursive: true });
    await writeFile(join(dir, "apps", "web", "keep.txt"), "mine");
    await expect(scaffoldWorker({ projectDir: dir, name: "web", project: "acme" })).rejects.toThrow(PithyError);
  });
});
