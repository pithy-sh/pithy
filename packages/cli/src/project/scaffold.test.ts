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
  test("writes the starter files with the chosen app name", async () => {
    const target = join(dir, "my-app");
    await scaffoldProject({ targetDir: target, appName: "my-app" });

    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");

    const wrangler = await readFile(join(target, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"name": "my-app"');

    // gitignore ships unprefixed (npm strips dotfiles) and lands as .gitignore.
    const gitignore = await readFile(join(target, ".gitignore"), "utf8");
    expect(gitignore).toContain(".dev.vars");

    // The rest of the template arrived intact.
    await readFile(join(target, "pithy.config.ts"), "utf8");
    await readFile(join(target, "src", "index.ts"), "utf8");
    await readFile(join(target, "tsconfig.json"), "utf8");
    await readFile(join(target, ".dev.vars.example"), "utf8");
  });

  test("the scaffold carries dev, staging, and production config paths", async () => {
    await scaffoldProject({ targetDir: dir, appName: "envs" });
    const wrangler = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    // Phase 0 ships config paths for all three environments; staging serves test
    // users, production serves paid users (remote execution lands in Phase 1+).
    expect(wrangler).toContain('"staging"');
    expect(wrangler).toContain('"production"');
  });

  test("enables Workers Logs by default — Mode 2 structured logs are queryable with no adopter setup", async () => {
    await scaffoldProject({ targetDir: dir, appName: "obs" });
    const wrangler = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as {
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

  test("writes a name containing $ literally, not as a replacement pattern", async () => {
    // `$&`, `$1`, `$\`` are special in String.replace's replacement string.
    await scaffoldProject({ targetDir: dir, appName: "app-$&-$1-x" });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("app-$&-$1-x");
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toContain('"name": "app-$&-$1-x"');
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
