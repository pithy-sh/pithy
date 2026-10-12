// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError, type PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDocsCatalog } from "../docs/catalog";
import { scopedSettingsFix } from "../doctor/settingsSources";
import { scaffoldProject } from "../project/scaffold";
import { resolveSingleWorker } from "../project/workerScope";
import { secretsDatabaseMissing, suppressionDatabaseMissing } from "../provision/missingDatabase";
import { withProvisionFix } from "../provision/provisionFix";
import { fixOf } from "../terminal/exitClass";
import { recorder } from "../test-utils/cloudflareRecorder";
import { linkKitPackages } from "../test-utils/linkKit";
import { runCaptured } from "../test-utils/payloadContract";

/**
 * **A `fix` runs as written in a project with two Workers (#697).**
 *
 * `docs/CLI.md` §3.3: a `fix` is "one `pithy` command that rights it, runnable as written". A command that acts
 * on one Worker resolves it with `resolveSingleWorker`, and with two Workers and no `--worker` it refuses
 * `input/required` — so a `fix` naming such a command bare is a refusal an agent walks into. `pithy add`'s fixes
 * are `addFix.test.ts`'s. These are the rest: every emitter of a `fix` naming a command, driven in a two-Worker
 * project. A command that plans is run with `--dry-run --json` and must exit 0; one that does not is parsed
 * against the installed tree, and where it acts on one Worker it must name that Worker.
 *
 * The sweep that found them: `pithy email provision` (one Worker) from the suppression refusal and from
 * `@pithy-sh/email`'s settings check; `pithy secrets provision` and `pithy provision` (every Worker, and neither
 * takes `--worker`); and the doctor fixes that already name `--worker` (`upgrade`, `turnstile provision`,
 * `support provision`, `worker sync`, `add`) or name a command with no Worker in it (`migrate --env`, `seed`,
 * `secrets create`, `secrets update`, `docs connect`).
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
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-fix-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  // A second Worker, `apps/web`, deployed as `acme-web`: a directory and a script name that differ from api's.
  const web = join(dir, "apps", "web");
  await cp(join(dir, "apps", "api"), web, { recursive: true });
  const wrangler = join(web, "wrangler.jsonc");
  await writeFile(wrangler, (await readFile(wrangler, "utf8")).replaceAll("acme-api", "acme-web"));
  // The project claims the account, so a lookup that finds nothing is an answer rather than a refusal.
  const root = join(dir, "pithy.config.ts");
  await writeFile(
    root,
    (await readFile(root, "utf8")).replace(
      '// cloudflare: { accountName: "acme", accountId: "" },',
      'cloudflare: { accountId: "acct" },',
    ),
  );
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** The `fix` a refusal carries, or `undefined`. */
function fixFrom(error: PithyError): string | undefined {
  return fixOf(error);
}

/**
 * `fix`, read against the installed tree: the longest path it names is a command, and every flag it passes is
 * one that command declares. Hands back the command's path and the flags it was given.
 */
async function parsed(fix: string): Promise<{ path: string; flags: string[] }> {
  const [pithy, ...words] = fix.split(" ");
  expect(pithy).toBe("pithy");
  const { commands } = await buildDocsCatalog();
  const positional = words.filter((word) => !word.startsWith("--"));
  let path = "";
  for (let length = positional.length; length > 0 && path === ""; length--) {
    const candidate = positional.slice(0, length).join(" ");
    if (commands.some((command) => command.path === candidate)) path = candidate;
  }
  expect(path, `${fix} names a command`).not.toBe("");
  const declared = commands.find((command) => command.path === path)?.flags ?? [];
  const flags = words.filter((word) => word.startsWith("--"));
  for (const flag of flags) expect(declared, `${fix}: ${flag}`).toContain(flag);
  return { path, flags };
}

/** The Worker `--worker <value>` resolves to, through the one resolver a one-Worker command uses. */
async function resolvesTo(fix: string): Promise<string> {
  const words = fix.split(" ");
  const value = words[words.indexOf("--worker") + 1] as string;
  return (await resolveSingleWorker({ projectDir: dir, worker: value })).dir;
}

describe("a fix runs as written in a project with two Workers", () => {
  test("the premise: a one-Worker command with no --worker is refused here", async () => {
    const refused = await resolveSingleWorker({ projectDir: dir }).catch((error: unknown) => error);
    expect((refused as PithyError).payload.code).toBe("input/required");
  });

  test("a missing suppression database, the Worker known: email provision names it, and it resolves", async () => {
    const fix = fixFrom(suppressionDatabaseMissing("acme-global-email-suppressions", "why.", join(dir, "apps", "web")));
    expect(fix).toBe("pithy email provision --worker web");
    expect((await parsed(fix as string)).path).toBe("email provision");
    expect(await resolvesTo(fix as string)).toBe(join(dir, "apps", "web"));
  });

  test("a missing suppression database, no Worker known: no fix, since a bare one is refused here", () => {
    expect(fixFrom(suppressionDatabaseMissing("acme-global-email-suppressions", "why."))).toBeUndefined();
  });

  test("email's settings finding names the Worker it was found in; one from an unknown Worker names none", async () => {
    const fix = scopedSettingsFix("pithy email provision", join(dir, "apps", "api"));
    expect(fix).toBe("pithy email provision --worker api");
    expect(await resolvesTo(fix as string)).toBe(join(dir, "apps", "api"));
    expect(scopedSettingsFix("pithy email provision", undefined)).toBeUndefined();
  });

  test("a fix for a command that spans every Worker is left as it is, and takes no --worker", async () => {
    expect(scopedSettingsFix("pithy secrets provision", join(dir, "apps", "api"))).toBe("pithy secrets provision");
    const fix = fixFrom(secretsDatabaseMissing("staging", "acme-staging-secrets", "why."));
    expect(fix).toBe("pithy secrets provision");
    const { path } = await parsed(fix as string);
    const declared = (await buildDocsCatalog()).commands.find((command) => command.path === path)?.flags;
    expect(declared).not.toContain("--worker");
  });

  test("an unprovisioned environment's fix plans, with --dry-run, and exits 0", async () => {
    const fix = fixOf(withProvisionFix(new InternalError({ message: "m" }), "staging"));
    expect(fix).toBe("pithy provision --env staging --yes");
    const { flags } = await parsed(fix as string);
    expect(flags).not.toContain("--worker");
    const exited = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    const [, , ...args] = (fix as string).split(" ");
    await runCaptured("provision", [...args, "--dry-run", "--json"]);
    expect(errors.join(""), `${fix} --dry-run --json`).toBe("");
    expect(exited).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });
});
