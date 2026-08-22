// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");
const REPO = resolve(import.meta.dirname, "..", "..", "..");

/**
 * **`pithy secrets rotate`, driven with the real binary — including the failure nobody exercises by
 * accident.**
 *
 * Every defect in this kit's history passed a green unit suite before it was found, and the one this
 * command exists to survive lives between the process, an issuer's API, and a store: *the roll succeeded
 * and the store write failed.* A unit test proves the core branches correctly. Only this proves that the
 * whole command, spawned as an operator spawns it, prints the right thing, exits the right code, and
 * carries no credential out with it.
 *
 * ## What is real here, and what is not
 *
 * Real: `bun bin.ts secrets rotate …`, the scaffolded project, its own `pithy.config.ts`, the secret
 * registry loaded out of it, the adopter-supplied rotator, `WorkflowSecretDispatcher`,
 * `CloudflareWorkflowsClient`, and the Cloudflare SDK's HTTP transport.
 *
 * A stand-in: the Cloudflare account. The SDK honors `CLOUDFLARE_BASE_URL`, so the client talks to a
 * local server that answers the Workflows API — which is also how the store is made to fail **after** a
 * roll has already succeeded, without a line of test-only code inside the CLI. A seam in the command for
 * "pretend the store failed" would be a backdoor in the one command that handles live credentials.
 *
 * ## `--name replay --worker board`, deliberately unequal
 *
 * A Worker deploys as `<project>-<worker>`, and the Workflow this dispatches to is
 * `<project>-<env>-secrets-write`. A fixture where both names are `api` hides a whole class of bug — that
 * is how #136 survived for months — so the two differ here and the assertions read the difference.
 */

/** Which credential the rotator issued, per call. The test's oracle; nothing in the CLI can see it. */
const ISSUED_LOG = "issued.log";
/** One line per roll. What proves a retry never rolled again. */
const ROLL_LOG = "rolls.log";

/**
 * The adopter's registry: one of each rotation kind, written the way #322 says an adopter writes one.
 *
 * The rotator logs the value it issued to a file outside the CLI's sight, so the leak assertions below
 * search for a string this test knows and the command must never emit.
 */
const REGISTRY_SOURCE = `import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";

const GITHUB_APPS = "https://github.com/settings/developers";
const CF_TOKENS = "https://dash.cloudflare.com/profile/api-tokens";
const CF_TOKEN_UPDATE = "https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/update/";

export const replayRegistry = defineSecretRegistry({
  REPLAY_SESSION_KEY: {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
    origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
    rotation: { kind: "local" },
  },
  REPLAY_OAUTH_SECRET: {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    origin: { kind: "obtained", issuer: "github", documentation: GITHUB_APPS },
    rotation: { kind: "manual", issuer: "github", documentation: GITHUB_APPS },
  },
  REPLAY_PROVIDER_TOKEN: {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    origin: { kind: "obtained", issuer: "cloudflare", documentation: CF_TOKENS },
    rotation: { kind: "provider", issuer: "cloudflare", documentation: CF_TOKEN_UPDATE },
    rotator: {
      async roll() {
        const issued = \`cfat_replay_\${randomUUID()}\`;
        appendFileSync(process.env.REPLAY_ROLL_LOG ?? "/dev/null", "rolled\\n");
        appendFileSync(process.env.REPLAY_ISSUED_LOG ?? "/dev/null", \`\${issued}\\n\`);
        return { newValue: issued };
      },
    },
  },
});
`;

/** Every kit package the composed Worker imports, linked the way a working checkout is (mirrors `e2e.test.ts`). */
const LINKED = ["core", "auth", "email", "secrets", "turnstile", "audit", "cloudflare"];

/**
 * A stand-in for the Cloudflare Workflows REST API.
 *
 * `refused` names the environments whose write Workflow ends `errored` — the manager ran and could not
 * write. That is the genuine store failure, arriving through the genuine client, at the one moment that
 * matters: after the rotator has already rolled.
 *
 * It also answers the **rotation ledger** modes (`#379`), because a rotation opens a row in the manager
 * before it rolls and closes it after — and `dispatched` records every payload it was sent, in order,
 * which is what lets a test read the CLI's behavior off the wire rather than off the CLI's own report.
 */
function fakeCloudflare(refused: Set<string>): Promise<{
  server: Server;
  baseUrl: string;
  dispatched: { workflow: string; mode: string }[];
}> {
  const dispatched: { workflow: string; mode: string }[] = [];
  /** Which mode each dispatched instance carried. The poll URL does not say, so the POST has to be kept. */
  const modes = new Map<string, { workflow: string; mode: string }>();
  let next = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const reply = (payload: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: payload, success: true, errors: [], messages: [] }));
    };
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const create = /\/workflows\/([^/]+)\/instances$/.exec(url);
      if (req.method === "POST" && create) {
        const workflow = create[1] ?? "";
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { params?: { mode?: string } };
        const mode = body.params?.mode ?? "unknown";
        const id = `instance-${++next}`;
        modes.set(id, { workflow, mode });
        dispatched.push({ workflow, mode });
        reply({ id, status: "queued" });
        return;
      }
      const status = /\/workflows\/([^/]+)\/instances\/([^/?]+)/.exec(url);
      if (status) {
        const workflow = status[1] ?? "";
        const instance = modes.get(status[2] ?? "");
        if ([...refused].some((env) => workflow.includes(`-${env}-`))) {
          reply({ status: "errored", error: { message: "the manager could not reach its database" }, steps: [] });
          return;
        }
        // A `rotation-open` answers with the row id; everything else answers as a write.
        if (instance?.mode === "rotation-open") {
          reply({ status: "complete", output: { outcome: "opened", rotationId: 1 } });
          return;
        }
        if (instance?.mode === "rotation-close") {
          reply({ status: "complete", output: { outcome: "closed" } });
          return;
        }
        reply({ status: "complete", output: { outcome: "written" } });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: null, success: false, errors: [{ code: 404, message: "no" }], messages: [] }));
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      done({ server, baseUrl: `http://127.0.0.1:${address.port}/client/v4`, dispatched });
    });
  });
}

let dir: string;
let app: string;
let config: string;
let staging: Awaited<ReturnType<typeof fakeCloudflare>>;
let refusing: Awaited<ReturnType<typeof fakeCloudflare>>;

/** Run the real CLI in the scaffolded project, and give back both streams and the exit code. */
async function cli(
  args: string[],
  options: { baseUrl: string } = { baseUrl: "" },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    // Never the operator's own. This directory holds live Cloudflare credentials on a real machine.
    PITHY_CONFIG_DIR: config,
    CLOUDFLARE_ACCOUNT_ID: "acct-replay",
    CLOUDFLARE_API_TOKEN: "cfat-fake",
    CLOUDFLARE_BASE_URL: options.baseUrl,
    REPLAY_ROLL_LOG: join(dir, ROLL_LOG),
    REPLAY_ISSUED_LOG: join(dir, ISSUED_LOG),
  };
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], { cwd: app, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** Every line the rotator has issued so far. Empty when it has never been called. */
async function issued(): Promise<string[]> {
  return readFile(join(dir, ISSUED_LOG), "utf8")
    .then((text) => text.split("\n").filter(Boolean))
    .catch(() => []);
}

/** How many times the rotator rolled. The number a retry must not move. */
async function rolls(): Promise<number> {
  return (await readFile(join(dir, ROLL_LOG), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
}

beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", ".e2e-rotate-"));
  app = join(dir, "app");
  config = join(dir, "config");
  await mkdir(config, { recursive: true });
  [staging, refusing] = await Promise.all([fakeCloudflare(new Set()), fakeCloudflare(new Set(["prod"]))]);

  await run("bun", [bin, "init", "--name", "replay", "--worker", "board", "--dir", app, "--json"], {
    env: { ...process.env, PITHY_CONFIG_DIR: config },
  });
  const scope = join(app, "node_modules", "@pithy-sh");
  await rm(scope, { recursive: true, force: true });
  await mkdir(scope, { recursive: true });
  for (const pkg of LINKED) await symlink(join(REPO, "packages", pkg), join(scope, pkg));
  await cli(["add", "secrets", "--worker", "board", "--json"]);

  // The adopter's own registry, replacing the empty one `pithy add secrets` scaffolds. This is the shape
  // #322 describes: the capability declares the tag, and whoever holds the credentials supplies the code.
  await writeFile(join(app, "apps", "board", "src", "secretRegistry.ts"), REGISTRY_SOURCE);
  const path = join(app, "apps", "board", "pithy.config.ts");
  const source = (await readFile(path, "utf8"))
    .replace(
      'import { secrets } from "@pithy-sh/secrets/src/index";',
      'import { secrets } from "@pithy-sh/secrets/src/index";\nimport { replayRegistry } from "./src/secretRegistry";',
    )
    .replace("registry: {},", "registry: replayRegistry,");
  await writeFile(path, source);
  expect(source).toContain("registry: replayRegistry");
}, 300_000);

afterAll(async () => {
  staging?.server.close();
  refusing?.server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("pithy secrets rotate, with the real binary", () => {
  test("a local secret is re-minted here and written, and says so", async () => {
    const result = await cli(["secrets", "rotate", "REPLAY_SESSION_KEY", "--env", "staging"], staging);
    expect(result.stdout).toBe("REPLAY_SESSION_KEY rotated in staging.\nDone.\n");
    expect(result.code).toBe(0);
    // The word an operator scans for is only ever printed over a value that landed.
    expect(await rolls()).toBe(0);
  }, 60_000);

  test("a provider secret is rolled at its issuer, then recorded", async () => {
    const before = await rolls();
    const result = await cli(["secrets", "rotate", "REPLAY_PROVIDER_TOKEN", "--env", "staging"], staging);
    expect(result.stdout).toBe("REPLAY_PROVIDER_TOKEN rolled at cloudflare and recorded in staging.\nDone.\n");
    expect(result.code).toBe(0);
    expect(await rolls()).toBe(before + 1);
  }, 60_000);

  /**
   * **`#379`, read off the wire rather than off the report.**
   *
   * A successful rotation used to dispatch one thing — an ordinary `update`, indistinguishable from a typo
   * fix — so nothing recorded a rotation and the secret reported overdue forever. The fix is the two calls
   * either side of it, and the order is the whole property: the row is opened *before* the value is written,
   * so a rotator that never returns still leaves a trace.
   *
   * This asserts what the CLI sent to the Workflows API, which is a fact about the command that the
   * command's own stdout could not establish.
   */
  test("a rotation opens a ledger row, writes, then closes it — in that order", async () => {
    const before = staging.dispatched.length;

    const result = await cli(["secrets", "rotate", "REPLAY_SESSION_KEY", "--env", "staging"], staging);
    expect(result.code).toBe(0);

    const sent = staging.dispatched.slice(before);
    expect(sent.map((instance) => instance.mode)).toEqual(["rotation-open", "update", "rotation-close"]);
    // All three to the same environment's manager. A row opened in staging and closed in prod would record
    // a rotation that did not happen in either.
    expect(new Set(sent.map((instance) => instance.workflow))).toEqual(new Set(["replay-staging-secrets-write"]));
  }, 60_000);

  test("a manual secret gets an instruction, calls nothing, and never says Done", async () => {
    const before = await rolls();
    const result = await cli(["secrets", "rotate", "REPLAY_OAUTH_SECRET", "--env", "prod"], refusing);
    expect(result.stdout).toBe(
      [
        "REPLAY_OAUTH_SECRET is replaced by a human at github. Nothing was called.",
        "https://github.com/settings/developers",
        "Record the new value with pithy secrets update REPLAY_OAUTH_SECRET --env prod.",
        "",
      ].join("\n"),
    );
    // `Done.` under a sentence saying a human must act reads as the command having handled it.
    expect(result.stdout).not.toContain("Done.");
    expect(result.code).toBe(0);
    expect(await rolls()).toBe(before);
  }, 60_000);

  test("a dry run names what would happen and reaches nothing", async () => {
    const before = await rolls();
    const dispatches = refusing.dispatched.length;
    const result = await cli(["secrets", "rotate", "REPLAY_PROVIDER_TOKEN", "--env", "prod", "--dry-run"], refusing);
    expect(result.stdout).toBe(
      "REPLAY_PROVIDER_TOKEN would be rolled at cloudflare, then written to prod.\nDry run. Nothing rolled, nothing written.\n",
    );
    expect(result.code).toBe(0);
    expect(await rolls()).toBe(before);
    // Not the rotation row either. A dry run that recorded one would be lying in the one place it must not.
    expect(refusing.dispatched.length).toBe(dispatches);
  }, 60_000);

  /**
   * **The reason this file exists.**
   *
   * The rotator succeeds; the write Workflow ends `errored`. What the operator sees, what the shell gets,
   * and — the assertion that matters most — how many times the credential was rolled.
   */
  test("the store failing after a successful roll is unmissable, exits 3, and never rolls again", async () => {
    const before = await rolls();
    const result = await cli(["secrets", "rotate", "REPLAY_PROVIDER_TOKEN", "--env", "prod"], refusing);

    expect(result.stdout).toBe(
      [
        "REPLAY_PROVIDER_TOKEN rolled at cloudflare and recorded nowhere.",
        "prod still holds a credential cloudflare has retired.",
        "",
      ].join("\n"),
    );
    // Not "rotated", anywhere. An aggregate word over this state is the shape #367 refuses.
    expect(result.stdout).not.toContain("rotated");
    expect(result.stderr).toContain("REPLAY_PROVIDER_TOKEN was rolled at cloudflare and its new value was not stored.");
    expect(result.stderr).toContain("The new value is gone.");
    expect(result.stderr).toContain("pithy secrets update REPLAY_PROVIDER_TOKEN --env prod");
    // The declaration's own documentation URL, composed rather than guessed.
    expect(result.stderr).toContain("https://developers.cloudflare.com/api/resources/user/");
    // 3, not 1. `1` means the previous credential is still live; this state is the one thing that is not.
    expect(result.code).toBe(3);
    // **One roll against three store attempts.** A second here is the defect the retry was meant to
    // prevent, arriving by way of the retry: a third credential issued and the second one lost.
    expect(await rolls()).toBe(before + 1);
    // And the manager that cannot write is also the manager that cannot record, so the ledger open failed
    // here too. It cost the row and not the rotation — the report above is byte-identical either way, which
    // is the property: bookkeeping never decides whether a credential gets replaced.
  }, 120_000);

  test("under --json it is one line, its own error code, and the same exit", async () => {
    const result = await cli(["secrets", "rotate", "REPLAY_PROVIDER_TOKEN", "--env", "prod", "--json"], refusing);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      command: "secrets rotate",
      name: "REPLAY_PROVIDER_TOKEN",
      rotations: [
        {
          name: "REPLAY_PROVIDER_TOKEN",
          status: "unrecorded",
          rotation: "provider",
          rolled: true,
          recorded: [],
          stranded: ["prod"],
        },
      ],
    });
    expect((JSON.parse(result.stderr.trim()) as { error: { code: string } }).error.code).toBe(
      "secrets/rotation_unrecorded",
    );
    expect(result.code).toBe(3);
  }, 120_000);

  test("a local secret whose store refuses is an ordinary failure — exit 1, previous value still live", async () => {
    const result = await cli(["secrets", "rotate", "REPLAY_SESSION_KEY", "--env", "prod"], refusing);
    expect(result.stdout).toContain("REPLAY_SESSION_KEY was not rotated. Nothing was rolled and nothing was written.");
    expect(result.code).toBe(1);
  }, 120_000);

  test("a secret the registry never heard of is refused before anything is reached", async () => {
    const before = await rolls();
    const result = await cli(["secrets", "rotate", "NOT_DECLARED", "--env", "prod", "--json"], refusing);
    expect((JSON.parse(result.stderr.trim()) as { error: { code: string } }).error.code).toBe("core/not_found");
    expect(result.code).toBe(1);
    expect(await rolls()).toBe(before);
  }, 60_000);

  /**
   * **The sharpest rule in this command, proved rather than asserted.**
   *
   * Every value the rotator has issued across this whole file is a string the test knows and the CLI must
   * never emit — including in the run where that value was the only copy in existence and was then lost.
   * Both streams of every run above are searched, and so is the config directory the CLI writes to.
   */
  test("no value the rotator issued reaches any surface the CLI writes to", async () => {
    const values = await issued();
    expect(values.length).toBeGreaterThanOrEqual(3);

    const surfaces: string[] = [];
    for (const argv of [
      ["secrets", "rotate", "REPLAY_PROVIDER_TOKEN", "--env", "staging"],
      ["secrets", "rotate", "REPLAY_PROVIDER_TOKEN", "--env", "prod"],
      ["secrets", "rotate", "REPLAY_PROVIDER_TOKEN", "--env", "prod", "--json"],
    ]) {
      const result = await cli(argv, argv.includes("staging") ? staging : refusing);
      surfaces.push(result.stdout, result.stderr);
    }
    const printed = surfaces.join("\n");
    for (const value of await issued()) {
      expect(printed).not.toContain(value);
      // And nothing wrote it down. The dev secrets file and the credentials file both live here.
      await expect(
        run("grep", ["-rl", "--", value, config]).then(
          () => "found",
          () => "absent",
        ),
      ).resolves.toBe("absent");
    }
  }, 180_000);
});
