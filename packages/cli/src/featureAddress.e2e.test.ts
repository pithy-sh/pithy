// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "comment-json";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { devSecretsFile } from "./devSecrets/location";
import { featureConfigPath } from "./provision/featureConfig";
import { GIT_NO_MAINTENANCE, removeTempDir } from "./test-utils/tempRepo";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");
const REPO = resolve(import.meta.dirname, "..", "..", "..");

/**
 * **A feature deployment's address, driven with the real binary (#643).**
 *
 * `pithy provision --feature` derives the feature Worker's `workers.dev` origin and stamps it where the Worker
 * reads it; `pithy seed --env feature` hands that origin to a prepared set, and `--host` overrides it; and the
 * seed never opens the dev secrets file to do it.
 *
 * ## What is real here, and what is not
 *
 * Real: `bun bin.ts …`, a scaffolded project on a real `feature/<issue>-<slug>` branch, its own
 * `pithy.config.ts`, the generated feature config, the Cloudflare SDK's HTTP transport. A stand-in: the
 * Cloudflare account. The SDK honors `CLOUDFLARE_BASE_URL`, so the one lookup a feature's address needs — the
 * account's `workers.dev` subdomain — is answered by a local server, and every request the CLI makes is
 * recorded, so the test can say which calls reached "Cloudflare" at all.
 *
 * ## `--name replay --worker board`, deliberately unequal
 *
 * The feature Worker deploys as `replay-f643-feature-address-board`. A fixture where both names are `api`
 * would pass a script composed from either one.
 */

/** Every kit package the composed Worker imports, linked the way a working checkout is. */
const LINKED = ["core", "auth", "email", "secrets", "turnstile", "audit", "cloudflare"];

const SCRIPT = "replay-f643-feature-address-board";
const FEATURE_ORIGIN = `https://${SCRIPT}.acme.workers.dev`;
/**
 * What a set asking for a secret is told on a feature: what every deployed environment says. A feature's secrets
 * are only in its own Cloudflare stores, which the CLI never reads (#643), and the dev file is dev's alone (#159).
 */
const REFUSED = 'Refusing to read the dev secret "probe-signing-key" while seeding feature.';

/**
 * A prepared set that writes down what the run handed it: the origin, and whether a mintable secret arrived.
 * Never the secret itself — its length is the fact, and the value is nobody's business.
 */
const PROBE_SOURCE = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { defineSeed } from "@pithy-sh/core/src/seed/seed";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";

export const originProbe = defineCapability({
  name: "probe",
  requiredBindings: [],
  secretRegistry: defineSecretRegistry({
    "probe-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", devValue: "random" },
  }),
  seeds: [
    defineSeed({
      name: "origin",
      order: 1000,
      environments: ["feature"],
      prepare: async (context) => {
        // A feature's secrets live only in its own stores (#643), so the read is refused, never answered with a
        // value the deployment does not hold.
        let secretLength: number | string | null = null;
        try {
          secretLength = (await context.secret("probe-signing-key"))?.length ?? null;
        } catch (error) {
          secretLength = (error as { payload?: { message?: string } }).payload?.message ?? String(error);
        }
        const contents = JSON.stringify({ env: context.env, origin: context.origin, secretLength });
        return { artifacts: [{ file: "origin-probe.json", contents: \`\${contents}\\n\` }] };
      },
    }),
  ],
});
`;

/** A stand-in for the Cloudflare API: it knows the account's `workers.dev` subdomain, and nothing else. */
function fakeCloudflare(): Promise<{ server: Server; baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(`${req.method} ${url}`);
    req.resume();
    req.on("end", () => {
      if (/\/accounts\/[^/]+\/workers\/subdomain$/.test(url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: { subdomain: "acme" }, success: true, errors: [], messages: [] }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: null, success: false, errors: [{ code: 404, message: "no" }], messages: [] }));
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      done({ server, baseUrl: `http://127.0.0.1:${address.port}/client/v4`, requests });
    });
  });
}

let dir: string;
let app: string;
let config: string;
let cloudflare: Awaited<ReturnType<typeof fakeCloudflare>>;

/** Run the real CLI in the scaffolded project, and give back both streams and the exit code. */
async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    // Never the operator's own. This directory holds live Cloudflare credentials on a real machine.
    PITHY_CONFIG_DIR: config,
    CLOUDFLARE_ACCOUNT_ID: "acct-replay",
    CLOUDFLARE_API_TOKEN: "cfat-fake",
    CLOUDFLARE_BASE_URL: cloudflare.baseUrl,
  };
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], { cwd: app, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** What the probe set was handed on the last run. */
async function probe(): Promise<{ env: string; origin: string | null; secretLength: number | string | null }> {
  return JSON.parse(await readFile(join(app, "logs", "origin-probe.json"), "utf8"));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-e2e-feature-address-"));
  app = join(dir, "app");
  config = join(dir, "config");
  await mkdir(config, { recursive: true });
  cloudflare = await fakeCloudflare();

  await run("bun", [bin, "init", "--name", "replay", "--worker", "board", "--dir", app, "--json"], {
    env: { ...process.env, PITHY_CONFIG_DIR: config },
  });
  const scope = join(app, "node_modules", "@pithy-sh");
  await mkdir(scope, { recursive: true });
  for (const pkg of LINKED) await symlink(join(REPO, "packages", pkg), join(scope, pkg));

  await writeFile(join(app, "apps", "board", "src", "originProbe.ts"), PROBE_SOURCE);
  const path = join(app, "apps", "board", "pithy.config.ts");
  const source = (await readFile(path, "utf8"))
    .replace(
      'import { originFor } from "@pithy-sh/core/src/naming/domains";',
      'import { originFor } from "@pithy-sh/core/src/naming/domains";\nimport { originProbe } from "./src/originProbe";',
    )
    .replace(
      "    // pithy:capabilities (managed region — do not remove this marker)\n",
      "    // pithy:capabilities (managed region — do not remove this marker)\n    originProbe,\n",
    );
  await writeFile(path, source);
  expect(source).toContain("originProbe,");

  // A feature's identity is its branch.
  const git = (...args: string[]) => run("git", ["-C", app, ...GIT_NO_MAINTENANCE, ...args]);
  await git("init", "-q", "-b", "main");
  await git(
    "-c",
    "user.email=test@pithy.invalid",
    "-c",
    "user.name=test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  await git("checkout", "-q", "-b", "feature/643-feature-address");
}, 300_000);

afterAll(async () => {
  cloudflare?.server.close();
  await removeTempDir(dir);
});

describe("a feature deployment's address, with the real binary", () => {
  test("provision --feature stamps the feature's workers.dev origin, and its seed hands it to a prepared set", async () => {
    const result = await cli(["provision", "--feature", "--json"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const generated = parse(await readFile(featureConfigPath(join(app, "apps", "board")), "utf8")) as unknown as {
      env: { feature: { name: string; vars: Record<string, string> } };
    };
    expect(generated.env.feature.name).toBe(SCRIPT);
    // Where `originFor` reads it inside the deployment — auth's base URL, email's links, and nothing typed.
    expect(generated.env.feature.vars.BASE_URL).toBe(FEATURE_ORIGIN);
    expect(generated.env.feature.vars.ENVIRONMENT).toBe("feature");

    // Provisioning seeds a feature, and the prepared set saw the same address.
    expect(await probe()).toEqual({ env: "feature", origin: FEATURE_ORIGIN, secretLength: REFUSED });
  }, 120_000);

  /**
   * **No dev login on a feature (#643).** A magic link is how anybody signs in to a feature deployment, so auth's
   * dev-session set composes into `dev` alone — and the seed, which never needs a feature's secret, never opens
   * the dev secrets file to look for one.
   */
  test("seed --env feature skips auth's dev-session set, and never opens the dev secrets file", async () => {
    const added = await cli(["add", "auth", "--with-prerequisites", "--worker", "board", "--json"]);
    expect(added.code).toBe(0);

    // The dev secrets file exists — `pithy add` minted into it — and is made unreadable. A seed that opens it
    // fails with EACCES; one that does not is untouched by this.
    const secrets = devSecretsFile("replay", { env: { PITHY_CONFIG_DIR: config } });
    await chmod(secrets, 0o000);
    const before = cloudflare.requests.length;
    try {
      const result = await cli(["seed", "--env", "feature", "--yes", "--json"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as {
        env: string;
        workers: { worker: string; sets: { name: string }[]; skippedByEnv: string[] }[];
      };
      const board = report.workers[0];
      expect(board?.sets.map((set) => set.name)).not.toContain("9999_auth_dev-session");
      expect(board?.skippedByEnv).toContain("9999_auth_dev-session");
      expect(await probe()).toEqual({ env: "feature", origin: FEATURE_ORIGIN, secretLength: REFUSED });
    } finally {
      await chmod(secrets, 0o600);
    }
    // The one thing it asked the account: the subdomain. Nothing written anywhere.
    expect(cloudflare.requests.slice(before)).toEqual(["GET /client/v4/accounts/acct-replay/workers/subdomain"]);
  }, 180_000);

  test("--host overrides the derived origin, and the account is not asked", async () => {
    const before = cloudflare.requests.length;
    const result = await cli(["seed", "--env", "feature", "--yes", "--host", "preview.example.com", "--json"]);
    expect(result.code).toBe(0);
    expect((await probe()).origin).toBe("https://preview.example.com");
    expect(cloudflare.requests.slice(before)).toEqual([]);
  }, 120_000);

  test("a host that is not one is refused before anything is written", async () => {
    const result = await cli(["seed", "--env", "feature", "--yes", "--host", "https://preview.example.com/x"]);
    expect(result.code).toBe(1);
    expect(result.stderr + result.stdout).toContain(
      '--host takes a host, like preview.example.com, not "https://preview.example.com/x".',
    );
  }, 120_000);
});
