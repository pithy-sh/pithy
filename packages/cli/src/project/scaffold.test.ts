// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureEmptyTarget, ensureScaffoldable, scaffoldProject } from "./scaffold";

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

  test("refuses a target that already holds a file it would write", async () => {
    await writeFile(join(dir, "package.json"), "mine");
    await expect(scaffoldProject({ targetDir: dir, appName: "nope" })).rejects.toThrow(PithyError);
    // The adopter's file is untouched.
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe("mine");
    await expect(readFile(join(dir, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("scaffolds into a freshly cloned repo — a clone is how a project normally starts", async () => {
    // .git, a README, a licence, an editor config, and a CLAUDE.md. None of them is a project, and
    // refusing them meant `pithy init` could not run in the repo the adopter had just made for it.
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(dir, "README.md"), "# acme\n");
    await writeFile(join(dir, "LICENSE"), "MIT\n");
    await writeFile(join(dir, ".editorconfig"), "root = true\n");
    await writeFile(join(dir, "CLAUDE.md"), "rules\n");

    await scaffoldProject({ targetDir: dir, appName: "acme" });

    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("acme");
    await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8");
    // Everything that was there stays there.
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("# acme\n");
    expect(await readFile(join(dir, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  });

  test("merges into an existing apps/api rather than refusing it, and keeps what was there", async () => {
    // The default worker is copied, not renamed, so a directory that already exists is merged into.
    // Collision, not emptiness: only a file the template writes is in the way.
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "NOTES.md"), "mine\n");

    await scaffoldProject({ targetDir: dir, appName: "acme" });

    expect(await readFile(join(dir, "apps", "api", "NOTES.md"), "utf8")).toBe("mine\n");
    expect(await readFile(join(dir, "apps", "api", "wrangler.jsonc"), "utf8")).toContain('"name": "acme-api"');
  });

  test("refuses an occupied apps/<worker> instead of crashing mid-copy, and leaves nothing behind", async () => {
    // The rename target holds a file the template never writes, so no *file* collides — and the
    // rename then died on ENOTEMPTY as a raw Error, after package.json and pithy.config.ts had
    // already landed. A half-scaffolded repo, and a stack trace where the error envelope belongs.
    await mkdir(join(dir, "apps", "edge"), { recursive: true });
    await writeFile(join(dir, "apps", "edge", "NOTES.md"), "mine\n");

    await expect(scaffoldProject({ targetDir: dir, appName: "acme", worker: "edge" })).rejects.toThrow(PithyError);

    expect(await readdir(dir)).toEqual(["apps"]);
    expect(await readdir(join(dir, "apps"))).toEqual(["edge"]);
    expect(await readFile(join(dir, "apps", "edge", "NOTES.md"), "utf8")).toBe("mine\n");
  });

  test("refuses an occupied apps/api when another worker is named — the rename would sweep it along", async () => {
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "NOTES.md"), "mine\n");

    await expect(scaffoldProject({ targetDir: dir, appName: "acme", worker: "edge" })).rejects.toThrow(PithyError);
    expect(await readFile(join(dir, "apps", "api", "NOTES.md"), "utf8")).toBe("mine\n");
  });

  test("refuses a file where the scaffold needs a directory, and leaves nothing behind", async () => {
    await writeFile(join(dir, "apps"), "mine\n");
    await expect(scaffoldProject({ targetDir: dir, appName: "acme" })).rejects.toThrow(PithyError);
    expect(await readdir(dir)).toEqual(["apps"]);
    expect(await readFile(join(dir, "apps"), "utf8")).toBe("mine\n");
  });

  test("refuses a dangling symlink at a template path, and writes nothing outside the target", async () => {
    // The severity is the write, not the trigger: with the gate following the link, `cp` and
    // `stampPackageName` wrote the scaffolded package.json to wherever the link pointed — outside
    // targetDir — while the run reported success.
    const outside = join(dir, "outside", "package.json");
    await mkdir(join(dir, "outside"), { recursive: true });
    const target = join(dir, "my-app");
    await mkdir(target, { recursive: true });
    await symlink(outside, join(target, "package.json"));

    await expect(scaffoldProject({ targetDir: target, appName: "my-app" })).rejects.toThrow(PithyError);
    await expect(readFile(outside, "utf8")).rejects.toThrow();
  });

  test("refuses an adopter's undotted gitignore — the template's copy lands on it, then renames it away", async () => {
    await writeFile(join(dir, "gitignore"), "mine\n");
    await expect(scaffoldProject({ targetDir: dir, appName: "acme" })).rejects.toThrow(PithyError);
    expect(await readFile(join(dir, "gitignore"), "utf8")).toBe("mine\n");
  });
});

describe("ensureScaffoldable", () => {
  test("a missing directory is fine — scaffoldProject creates it", async () => {
    await expect(ensureScaffoldable(join(dir, "nope"))).resolves.toBeUndefined();
  });

  test("an existing empty directory is fine", async () => {
    await expect(ensureScaffoldable(dir)).resolves.toBeUndefined();
  });

  test("files the template never writes are fine — .git and a README are not a project", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "README.md"), "");
    await writeFile(join(dir, ".editorconfig"), "");
    await expect(ensureScaffoldable(dir)).resolves.toBeUndefined();
  });

  test("names every colliding path, so the adopter knows what is in the way", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "mine");
    await mkdir(join(dir, "apps", "api", "src"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "src", "index.ts"), "mine");

    const error = await ensureScaffoldable(dir).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    const { message } = (error as PithyError).payload;
    expect(message).toContain("pithy.config.ts");
    expect(message).toContain(join("apps", "api", "src", "index.ts"));
  });

  test("the .gitignore the template lands as is checked under the name it lands under", async () => {
    // The template ships it as `gitignore` (npm strips dotfiles) and it is renamed on the way in.
    // Checking the shipped name would have waved an adopter's own .gitignore straight through.
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    await expect(ensureScaffoldable(dir)).rejects.toThrow(PithyError);
  });

  test("apps/api is checked whatever the first worker is called — the copy lands there, then renames", async () => {
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "wrangler.jsonc"), "mine");
    await expect(ensureScaffoldable(dir, "edge")).rejects.toThrow(PithyError);
    // And so is the name it will be renamed to.
    await rm(join(dir, "apps", "api"), { recursive: true });
    await mkdir(join(dir, "apps", "edge"), { recursive: true });
    await writeFile(join(dir, "apps", "edge", "wrangler.jsonc"), "mine");
    await expect(ensureScaffoldable(dir, "edge")).rejects.toThrow(PithyError);
  });

  test("an occupied apps/<worker> collides even when nothing in it is a template file", async () => {
    // Pithy renames `apps/api` onto this path and owns it outright for the length of the operation,
    // so emptiness is the question here — the file-by-file rule is the project root's, not this one's.
    await mkdir(join(dir, "apps", "edge"), { recursive: true });
    await writeFile(join(dir, "apps", "edge", "NOTES.md"), "mine");

    const error = await ensureScaffoldable(dir, "edge").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(join("apps", "edge"));
  });

  test("an empty apps/<worker> is fine — the rename replaces it", async () => {
    await mkdir(join(dir, "apps", "edge"), { recursive: true });
    await expect(ensureScaffoldable(dir, "edge")).resolves.toBeUndefined();
  });

  test("an occupied apps/api collides when another worker is named — the rename would carry it along", async () => {
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "NOTES.md"), "mine");
    await expect(ensureScaffoldable(dir, "edge")).rejects.toThrow(PithyError);
    // The same directory is fine for the default worker: that copy merges, and nothing is swept anywhere.
    await expect(ensureScaffoldable(dir)).resolves.toBeUndefined();
  });

  test("a file where a directory belongs collides — mkdir and cp both die on it", async () => {
    await writeFile(join(dir, "apps"), "mine");
    const error = await ensureScaffoldable(dir).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("apps");
  });

  test("a symlink where a directory belongs collides — cp refuses to copy a directory onto one", async () => {
    await mkdir(join(dir, "elsewhere"), { recursive: true });
    await symlink(join(dir, "elsewhere"), join(dir, "apps"), "dir");
    await expect(ensureScaffoldable(dir)).rejects.toThrow(PithyError);
  });

  test("the template's undotted gitignore is checked too — the copy lands on it before the rename", async () => {
    // `gitignore` (no dot) is a known git footgun and a file an adopter can genuinely have. The copy
    // overwrote it and the rename then moved it to `.gitignore`: gone, silently, from a gate whose
    // whole purpose is not to clobber.
    await writeFile(join(dir, "gitignore"), "mine\n");
    const error = await ensureScaffoldable(dir).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("gitignore");
  });

  test("a dangling symlink where a template file belongs collides — the copy writes through it", async () => {
    // `access` follows the link, so a dangling one read as "does not exist", cleared the gate, and was
    // never named in the refusal. Then `cp` and `stampPackageName` both wrote *through* it: the
    // scaffolded package.json landed outside targetDir. `lstat`, for the reason blocksDirectory gives —
    // the symlink itself is the problem. Node and Bun disagree on the copy here, which is worse, not
    // better: the unit tests and the shipped CLI would answer differently on the same input.
    const outside = join(dir, "outside", "package.json");
    await mkdir(dirname(outside), { recursive: true });
    const target = join(dir, "app");
    await mkdir(target, { recursive: true });
    await symlink(outside, join(target, "package.json"));

    const error = await ensureScaffoldable(target).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("package.json");
  });

  test("an unreadable directory refuses through PithyError, never a raw node:fs error", async () => {
    // `occupied` read the directory outside its try, so an EACCES escaped the PithyError contract this
    // module promises: `pithy init --json` printed a stack trace where a CI wrapper parses {"error":{…}}.
    // A directory that cannot be read is certainly occupied. Relies on the test NOT running as root,
    // where chmod has no effect — standard CI and dev are fine.
    const edge = join(dir, "apps", "edge");
    await mkdir(edge, { recursive: true });
    await chmod(edge, 0o000);

    const error = await ensureScaffoldable(dir, "edge").catch((cause: unknown) => cause);
    await chmod(edge, 0o755); // restore before asserting, so the temp dir is removable either way

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(join("apps", "edge"));
  });

  test("an illegal worker name is refused before any path is probed", async () => {
    // The gate builds `apps/<worker>/…` out of the name, so `pithy init --worker ../../etc` had it
    // walking paths outside the project and echoing hits back. Validate first; probe after.
    await expect(ensureScaffoldable(dir, "../../etc")).rejects.toThrow(PithyError);
    await expect(ensureScaffoldable(dir, "")).rejects.toThrow(PithyError);
  });
});

describe("ensureEmptyTarget", () => {
  test("a missing directory is fine", async () => {
    await expect(ensureEmptyTarget(join(dir, "nope"))).resolves.toBeUndefined();
  });

  test("an existing empty directory is fine", async () => {
    await expect(ensureEmptyTarget(dir)).resolves.toBeUndefined();
  });

  test("anything at all in the directory refuses it — this guards a path Pithy owns outright", async () => {
    await writeFile(join(dir, "README.md"), "not a project, still in the way");
    await expect(ensureEmptyTarget(dir)).rejects.toThrow(PithyError);
  });
});
