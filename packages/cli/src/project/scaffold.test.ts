// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureEmptyTarget, scaffoldProject } from "./scaffold";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-init-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scaffoldProject", () => {
  test("writes the root project files and the first worker under apps/", async () => {
    const target = join(dir, "my-app");
    await scaffoldProject({ targetDir: target, appName: "my-app" });

    // Root: identity + policy + the apps/* workspace. No worker lives here.
    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    expect(pkg.workspaces).toEqual(["apps/*"]);
    const rootConfig = await readFile(join(target, "pithy.config.ts"), "utf8");
    expect(rootConfig).toContain('name: "my-app"');
    // Capabilities are per-worker — the root config must not declare the array (prose about it is fine).
    expect(rootConfig).not.toMatch(/^\s*capabilities:\s*\[/m);
    await expect(readFile(join(target, "wrangler.jsonc"), "utf8")).rejects.toThrow();

    // The first worker: its own config, wrangler, manifest, and entrypoint.
    const api = join(target, "apps", "api");
    expect(JSON.parse(await readFile(join(api, "package.json"), "utf8")).name).toBe("my-app-api");
    expect(await readFile(join(api, "wrangler.jsonc"), "utf8")).toContain('"name": "my-app-api"');
    expect(await readFile(join(api, "pithy.config.ts"), "utf8")).toContain("// pithy:capabilities");
    await readFile(join(api, "pithy.worker.jsonc"), "utf8");
    await readFile(join(api, "src", "index.ts"), "utf8");
    await readFile(join(api, "tsconfig.json"), "utf8");

    // gitignore ships unprefixed (npm strips dotfiles) and lands as .gitignore.
    expect(await readFile(join(target, ".gitignore"), "utf8")).toContain(".dev.vars");
    await readFile(join(target, ".dev.vars.example"), "utf8");
  });

  test("scaffolds the first worker under the chosen name, not the default", async () => {
    await scaffoldProject({ targetDir: dir, appName: "acme", worker: "edge" });

    // The directory, the deploy name, and the package name all follow the chosen worker.
    expect(await readFile(join(dir, "apps", "edge", "wrangler.jsonc"), "utf8")).toContain('"name": "acme-edge"');
    expect(JSON.parse(await readFile(join(dir, "apps", "edge", "package.json"), "utf8")).name).toBe("acme-edge");
    await readFile(join(dir, "apps", "edge", "pithy.config.ts"), "utf8");
    // No leftover of the template's default worker.
    await expect(readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")).rejects.toThrow();
  });

  test("rejects a worker name that could not be a directory under apps/", async () => {
    await expect(scaffoldProject({ targetDir: dir, appName: "acme", worker: "Edge_Worker" })).rejects.toThrow(
      PithyError,
    );
  });

  test("the scaffolded worker carries dev, staging, and production config paths", async () => {
    await scaffoldProject({ targetDir: dir, appName: "envs" });
    const wrangler = await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"staging"');
    expect(wrangler).toContain('"prod"');
  });

  test("stamps PROJECT in every vars stanza, so the first worker can mint attributable assets", async () => {
    // Media mints Cloudflare Images/Stream uploads from this Worker, and those stores are account-flat —
    // an asset carries no name we chose, only the owner in its metadata. `assetOwner` refuses to mint
    // without `PROJECT`, so a scaffolded Worker that lacks it 500s on the first upload.
    await scaffoldProject({ targetDir: dir, appName: "acme" });
    const wrangler = parse(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")) as unknown as {
      vars: Record<string, string>;
      env: Record<string, { vars: Record<string, string> }>;
    };

    // `env.<name>.vars` replaces the top-level `vars` rather than merging, so all three stanzas carry it.
    expect(wrangler.vars?.PROJECT).toBe("acme");
    expect(wrangler.env.staging?.vars?.PROJECT).toBe("acme");
    expect(wrangler.env.prod?.vars?.PROJECT).toBe("acme");
  });

  test("the stamped PROJECT is the name requireProjectName resolves, not the raw input", async () => {
    // The Worker's stamp and the CLI's resource names must be the same string, or a sweep filtering on
    // `<project>-` finds nothing the Worker minted. `requireProjectName` kebabs, so the scaffold does too.
    await scaffoldProject({ targetDir: dir, appName: "Launch 2026" });
    const wrangler = parse(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")) as unknown as {
      vars: Record<string, string>;
    };
    expect(wrangler.vars?.PROJECT).toBe("launch-2026");
  });

  test("enables Workers Logs by default — Mode 2 structured logs are queryable with no adopter setup", async () => {
    await scaffoldProject({ targetDir: dir, appName: "obs" });
    const wrangler = parse(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")) as unknown as {
      observability?: { enabled?: boolean; head_sampling_rate?: number };
    };
    expect(wrangler.observability?.enabled).toBe(true);
    expect(wrangler.observability?.head_sampling_rate).toBe(1);
  });

  test("scaffolds into an existing empty directory", async () => {
    await scaffoldProject({ targetDir: dir, appName: "empty-ok" });
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("empty-ok");
  });

  test("normalizes a name with replacement-pattern characters instead of stamping it raw", async () => {
    // `$&`, `$1`, `$\`` are special in String.replace's replacement string, and none of them is legal in a
    // Cloudflare name. `assertValidProjectName` accepts this because it tests the kebabed form, so the
    // scaffold must stamp that same form — writing the raw string produced a wrangler.jsonc wrangler
    // refuses to parse ("alphanumeric and lowercase with dashes only").
    await scaffoldProject({ targetDir: dir, appName: "app-$&-$1-x" });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("app-1-x");
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toContain('name: "app-1-x"');
    expect(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")).toContain('"name": "app-1-x-api"');
  });

  test("lowercases the name everywhere it is stamped, so the project can deploy", async () => {
    // wrangler rejects `"name": "Acme-api"` at config-parse time, which broke every wrangler command in
    // the worker — deploy and `wrangler dev` alike. The guard accepts `Acme` (it kebabs first), so the
    // only thing that kept the scaffold honest was stamping the kebabed form.
    await scaffoldProject({ targetDir: dir, appName: "Acme" });
    const wrangler = await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"name": "acme-api"');
    expect(wrangler).toContain('"PROJECT": "acme"');
    // Nothing uppercase survived into either stamped value — the assertions above would still pass if a
    // second `"name"` or `"PROJECT"` carried the typed form.
    expect(wrangler.match(/"(?:name|PROJECT)": "[^"]*"/g)).not.toContain('"name": "Acme-api"');
    for (const stamp of wrangler.match(/"(?:name|PROJECT)": "([^"]*)"/g) ?? []) {
      expect(stamp, stamp).not.toMatch(/: "[^"]*[A-Z]/);
    }
    // The config shows the adopter the exact string every resource name leads with — not what they typed.
    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toContain('name: "acme"');
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("acme");
  });

  test("refuses the reserved pithy-int- prefix, and leaves nothing behind", async () => {
    const target = join(dir, "reserved");
    await expect(scaffoldProject({ targetDir: target, appName: "pithy-int-test" })).rejects.toThrow(PithyError);
    // The guard runs before the directory is even created — a refusal must not leave a half-scaffold.
    await expect(readFile(join(target, "package.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("the reservation is read after kebabing, so a spaced or capitalised variant is caught too", async () => {
    await expect(scaffoldProject({ targetDir: dir, appName: "Pithy Int Suite" })).rejects.toThrow(PithyError);
  });

  test("refuses the bare `pithy-int`, which composes `pithy-int-dev-db` and so is inside the namespace", async () => {
    // The name is not itself prefixed by `pithy-int-`; the composer's trailing hyphen puts every name it
    // generates in the reservation. A `startsWith` on the raw name would wave it through.
    await expect(scaffoldProject({ targetDir: dir, appName: "pithy-int" })).rejects.toThrow(PithyError);
  });

  test("a name that merely mentions pithy is fine — only the reserved prefix is refused", async () => {
    await scaffoldProject({ targetDir: dir, appName: "pithy-internal-tools" });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("pithy-internal-tools");
  });

  test("refuses a project name that doesn't start with a letter, and leaves nothing behind", async () => {
    // `mkdir 1password-clone && pithy init` took the directory basename as the project name and scaffolded
    // happily. Every Cloudflare name it then composed was legal right up to the first host-worker deploy,
    // which refused it — after D1, KV, and R2 already existed. The refusal belongs here, before the copy.
    const target = join(dir, "1password-clone");
    await expect(scaffoldProject({ targetDir: target, appName: "1password-clone" })).rejects.toThrow(PithyError);
    await expect(readFile(join(target, "package.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("the rule is read after kebabing, so a spaced or capitalised name is judged as Cloudflare sees it", async () => {
    await expect(scaffoldProject({ targetDir: dir, appName: "2026 Launch" })).rejects.toThrow(PithyError);
    // The same shape with a letter in front is fine — this refuses illegal names, not unusual ones. And
    // since the rule was read after kebabing, the scaffold writes the kebabed form: `Launch 2026` is not a
    // legal npm package name either, so stamping it raw broke `bun install` as well as `wrangler deploy`.
    await scaffoldProject({ targetDir: dir, appName: "Launch 2026" });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("launch-2026");
    expect(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")).toContain('"name": "launch-2026-api"');
  });

  test("refuses a non-empty target directory", async () => {
    await writeFile(join(dir, "keep.txt"), "mine");
    await expect(scaffoldProject({ targetDir: dir, appName: "nope" })).rejects.toThrow(PithyError);
    // Nothing was written next to the user's file.
    await expect(readFile(join(dir, "package.json"), "utf8")).rejects.toThrow();
  });
});

describe("ensureEmptyTarget", () => {
  test("a missing directory is fine — scaffoldProject creates it", async () => {
    await expect(ensureEmptyTarget(join(dir, "nope"))).resolves.toBeUndefined();
  });

  test("an existing empty directory is fine", async () => {
    await expect(ensureEmptyTarget(dir)).resolves.toBeUndefined();
  });

  test("a non-empty directory throws before any work — the pre-prompt gate", async () => {
    await writeFile(join(dir, "keep.txt"), "mine");
    await expect(ensureEmptyTarget(dir)).rejects.toThrow(PithyError);
  });
});
