// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { isTurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import { isVectorCapability } from "@pithy-sh/vector/src/capability";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { capabilityNotComposed } from "../capabilities/notComposed";
import { resolveConnectScopes } from "../dashboard/resolveTarget";
import { resolveCapabilityWorker } from "../project/capabilityWorker";
import { scaffoldProject } from "../project/scaffold";
import { fixOf } from "../terminal/exitClass";
import { recorder } from "../test-utils/cloudflareRecorder";
import { linkKitPackages } from "../test-utils/linkKit";
import { runCaptured } from "../test-utils/payloadContract";
import { mergedProjectSecrets } from "./secrets";

/**
 * **Every `pithy add` a refusal names as its `fix` runs as written, with nobody to ask (#697).**
 *
 * `docs/CLI.md` §3.3: a `fix` is "one `pithy` command that rights it, runnable as written". For `pithy add` that
 * is three facts the emitter has to read rather than assume — which Worker, by apps/ directory, when there are
 * several; `--with-prerequisites` when the capability declares peers; and no `fix` at all where a required
 * option has no value the kit may pick. Each emitter is driven here to its refusal in a real scaffolded project,
 * and the `fix` it names is then run — `--dry-run --json`, in-process, with the account and the network refusing
 * — and must exit 0.
 *
 * Not here: a capability whose package is not installed. Its `fix` is the same `addFix`, but a dry run plans
 * from the installed manifest and refuses without one (`capabilities/planAdd.ts`), so the run that proves it is
 * the real one.
 */

const cloudflare = vi.hoisted(() => ({ current: undefined as unknown as { clients: () => Promise<unknown> } }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: () => cloudflare.current.clients(),
}));

let dir: string;

beforeEach(async () => {
  cloudflare.current = recorder();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("A dry run reached the network.");
  });
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
  dir = await mkdtemp(join(tmpdir(), "pithy-add-fix-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core", "secrets", "email", "turnstile", "vector"]);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** A second Worker, `apps/web`, deployed as `acme-web`: a directory and a script name that differ from api's. */
async function secondWorker(): Promise<void> {
  const web = join(dir, "apps", "web");
  await cp(join(dir, "apps", "api"), web, { recursive: true });
  const wrangler = join(web, "wrangler.jsonc");
  await writeFile(wrangler, (await readFile(wrangler, "utf8")).replaceAll("acme-api", "acme-web"));
}

/** The `fix` a refusal carried. A call that resolved, or a refusal with no `fix`, fails the test. */
async function fixFrom(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof PithyError)) throw new Error(`expected a refusal, got ${String(error)}`);
  const fix = fixOf(error);
  if (fix === undefined) throw new Error(`the refusal named no fix: ${error.payload.message}`);
  return fix;
}

/** A refusal builder's error, thrown, so it reads like every other emitter's. */
async function thrown(error: PithyError | Promise<PithyError>): Promise<never> {
  throw await error;
}

/** Run `fix` as written, plus `--dry-run --json`, and hand back the exit it ended with. */
async function exitOf(fix: string): Promise<number> {
  const [pithy, command, ...args] = fix.split(" ");
  expect([pithy, command]).toEqual(["pithy", "add"]);
  const exited = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  const errors: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  try {
    await runCaptured("add", [...args.filter((arg) => arg !== "--dry-run" && arg !== "--json"), "--dry-run", "--json"]);
  } catch (error) {
    if (exited.mock.calls.length === 0) throw error;
  }
  const code = exited.mock.calls[0]?.[0];
  expect(errors.join(""), `${fix} --dry-run --json`).toBe("");
  return typeof code === "number" ? code : 0;
}

describe("every pithy add fix runs as written", () => {
  test("one Worker, a capability with prerequisites the project does not compose", async () => {
    const fix = await fixFrom(
      thrown(capabilityNotComposed("email", { message: "m", action: () => "a" }, { projectDir: dir })),
    );
    expect(fix).toBe("pithy add email --worker api --with-prerequisites");
    expect(await exitOf(fix)).toBe(0);
  });

  test("one Worker, resolved on its own, composing a capability with prerequisites", async () => {
    const fix = await fixFrom(
      resolveCapabilityWorker({ projectDir: dir, name: "turnstile", is: isTurnstileCapability }),
    );
    expect(fix).toBe("pithy add turnstile --worker api --with-prerequisites");
    expect(await exitOf(fix)).toBe(0);
  });

  test("one Worker, a capability with none", async () => {
    const fix = await fixFrom(resolveCapabilityWorker({ projectDir: dir, name: "vector", is: isVectorCapability }));
    expect(fix).toBe("pithy add vector --worker api");
    expect(await exitOf(fix)).toBe(0);
  });

  test("one Worker, no secrets composed anywhere", async () => {
    const fix = await fixFrom(mergedProjectSecrets(dir));
    expect(fix).toBe("pithy add secrets --worker api");
    expect(await exitOf(fix)).toBe(0);
  });

  test("one Worker, no control-plane seam to connect", async () => {
    const fix = await fixFrom(resolveConnectScopes({ projectDir: dir, environment: "prod" }));
    expect(fix).toBe("pithy add controlplane --worker api");
    expect(await exitOf(fix)).toBe(0);
  });

  test("two Workers: the fix names the apps/ directory, and runs", async () => {
    await secondWorker();
    const fix = await fixFrom(
      thrown(
        capabilityNotComposed(
          "turnstile",
          { message: "m", action: () => "a" },
          { projectDir: dir, workerDir: join(dir, "apps", "web") },
        ),
      ),
    );
    expect(fix).toBe("pithy add turnstile --worker web --with-prerequisites");
    expect(await exitOf(fix)).toBe(0);
  });

  // #711: `pithy add <capability> --worker <w> --json` with prerequisites missing named a bare
  // `pithy add <capability> --with-prerequisites`, which a two-Worker project refuses for want of the Worker.
  test("two Workers: a missing prerequisite's fix names the Worker the caller named, and runs", async () => {
    await secondWorker();
    const errors: string[] = [];
    const written = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    const exited = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    await runCaptured("add", ["email", "--worker", "web", "--dry-run", "--json"]).catch(() => undefined);
    expect(exited).toHaveBeenCalledWith(2);
    const line = JSON.parse(errors.join("").trim()) as { error: { code: string; action: string; fix?: string } };
    written.mockRestore();
    exited.mockRestore();

    expect(line.error.code).toBe("input/required");
    // A dry run's fix is a dry run too (#711): the caller asked to write nothing, and so does the command it names. And
    // it answers in JSON, as the caller's own call asked to.
    expect(line.error.fix).toBe("pithy add email --worker web --with-prerequisites --dry-run --json");
    expect(line.error.action.startsWith(`Run \`${line.error.fix}\`,`)).toBe(true);
    expect(await exitOf(line.error.fix as string)).toBe(0);
  });

  test("two Workers and a refusal about the project: no single Worker can be named, so no fix", async () => {
    await secondWorker();
    const error = await capabilityNotComposed("email", { message: "m", action: () => "a" }, { projectDir: dir });
    expect(fixOf(error)).toBeUndefined();
  });
});
