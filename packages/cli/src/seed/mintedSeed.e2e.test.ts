// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { removeTempDir } from "../test-utils/tempRepo";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "..", "bin.ts");

/**
 * **A prepared set sealing against a secret this run minted, driven by the real binary — #660.**
 *
 * `pithy provision --env <x> --seed` is the whole arrangement in one command: it creates each absent
 * `cf-secrets-store` secret, writes it into the account's store, and then migrates and seeds **in the
 * same process**. The store is write-only from the CLI, so that stretch is the only time the value is
 * reachable at all — a fixture that must seal something at creation time has this run and no other.
 *
 * Everything between the flag and the HTTP request is the shipping code: Cloudflare is stubbed at its own
 * REST seam through `CLOUDFLARE_BASE_URL`, bound to loopback, with an account id and a token that reach
 * nothing real. The prepared set is the adopter's side — a plain capability in the fixture's own
 * `apps/board/pithy.config.ts` — and it writes what it was offered to a file this test then reads, which
 * is the only way to observe a value that must never appear in any output.
 *
 * Project `replay`, Worker `board`, deliberately unequal.
 */

const ACCOUNT_ID = "acc0unt0000000000000000000000000";
const STORE_ID = "store000000000000000000000000000";
const WHEN = "2026-01-01T00:00:00Z";

/** The account this fixture provisions into: a Secrets Store, and the entries written to it. */
interface Account {
  url: string;
  entries: Map<string, string>;
  close: () => Promise<void>;
}

/**
 * A Cloudflare REST stub holding one Secrets Store.
 *
 * Create-if-absent is the semantics under test on the second run, so the entries persist across the two
 * invocations exactly as an account's would.
 */
async function stubCloudflare(): Promise<Account> {
  const entries = new Map<string, string>();
  const ok = (result: unknown): string => {
    const count = Array.isArray(result) ? result.length : 1;
    return JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result,
      result_info: { page: 1, per_page: 1000, count, total_count: count, total_pages: 1 },
    });
  };
  const entry = (name: string, id: number): Record<string, unknown> => ({
    id: `secret-${id}`,
    name,
    comment: "",
    created: WHEN,
    modified: WHEN,
    status: "active",
    store_id: STORE_ID,
    scopes: ["workers"],
  });

  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = request.url ?? "";
      const path = url.split("?")[0] ?? "";
      const query = new URLSearchParams(url.split("?")[1] ?? "");
      const method = request.method ?? "GET";
      response.setHeader("content-type", "application/json");

      // The SDK auto-paginates through `for await`, so page two must be empty or it walks forever.
      if (method === "GET" && Number(query.get("page") ?? "1") > 1) return void response.end(ok([]));
      if (path === `/client/v4/accounts/${ACCOUNT_ID}`) {
        return void response.end(ok({ id: ACCOUNT_ID, name: "stub" }));
      }
      if (path.endsWith("/secrets_store/stores")) {
        return void response.end(ok([{ id: STORE_ID, name: "stub-store", created: WHEN, modified: WHEN }]));
      }
      if (path.includes("/secrets_store/stores/") && path.endsWith("/secrets")) {
        if (method === "GET") {
          return void response.end(ok([...entries.keys()].map((name, index) => entry(name, index))));
        }
        if (method === "POST") {
          const parsed: unknown = body === "" ? [] : JSON.parse(body);
          const written = (Array.isArray(parsed) ? parsed : [parsed]) as { name?: string; value?: string }[];
          for (const one of written) if (one.name !== undefined) entries.set(one.name, one.value ?? "");
          return void response.end(ok(written.map((one, index) => entry(one.name ?? "", index))));
        }
      }
      return void response.end(ok([]));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/client/v4`,
    entries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The adopter's side: a Worker whose capability declares two store secrets — one a random value
 * satisfies, one it does not — and a prepared set that writes down what the run offered it.
 *
 * Plain object literals, with the capability named `secrets` and carrying a registry, which is what makes
 * a Worker's secrets discoverable. No `import` of a kit package: a fixture in `tmpdir()` has no
 * `node_modules`, and what is under test is the run, not module resolution.
 */
const WORKER_CONFIG = `
import { writeFileSync } from "node:fs";
export default {
  capabilities: [
    {
      name: "secrets",
      requiredBindings: [],
      secretRegistry: {
        "connection-key": {
          backend: "cf-secrets-store",
          scope: "environment",
          rotatable: true,
          valueType: "text",
          devValue: "random",
        },
        "connection-partner-token": {
          backend: "cf-secrets-store",
          scope: "environment",
          rotatable: false,
          valueType: "text",
        },
      },
      seeds: [
        {
          name: "records",
          order: 1000,
          environments: ["dev", "staging"],
          prepare: async (context) => {
            writeFileSync(
              process.env.MINT_PROBE_OUT,
              JSON.stringify({
                minted: context.mintedThisRun("connection-key") ?? null,
                unminted: context.mintedThisRun("connection-partner-token") ?? null,
              }),
            );
            return {};
          },
        },
      ],
    },
  ],
};
`;

/** What the prepared set was offered, as it wrote it down. */
interface Offered {
  minted: string | null;
  unminted: string | null;
}

describe("provision --seed offers a prepared set what it just minted", () => {
  const dirs: string[] = [];
  const servers: Account[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  /** A project declaring one environment and one Worker, with the capability above. */
  async function project(): Promise<{ dir: string; probe: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pithy-minted-e2e-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "pithy.config.ts"),
      `export default { name: "replay", cloudflare: { accountId: "${ACCOUNT_ID}" }, environments: ["staging"] };\n`,
    );
    const worker = join(dir, "apps", "board");
    await mkdir(join(worker, "src"), { recursive: true });
    await writeFile(
      join(worker, "wrangler.jsonc"),
      `{ "name": "replay-board", "main": "src/index.ts", "compatibility_date": "2026-06-01" }\n`,
    );
    await writeFile(join(worker, "src", "index.ts"), "export default {};\n");
    await writeFile(join(worker, "pithy.config.ts"), WORKER_CONFIG);
    return { dir, probe: join(dir, "probe.json") };
  }

  /** One real `pithy provision --env staging --seed --json`, and what the set wrote down during it. */
  async function provision(
    target: { dir: string; probe: string },
    account: Account,
  ): Promise<{ stdout: string; stderr: string; offered: Offered }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLOUDFLARE_BASE_URL: account.url,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "stub-token",
      SECRETS_STORE_ID: STORE_ID,
      PITHY_CONFIG_DIR: join(target.dir, ".pithy-config"),
      MINT_PROBE_OUT: target.probe,
      NO_COLOR: "1",
    };
    const { stdout, stderr } = await run("bun", [bin, "provision", "--env", "staging", "--yes", "--seed", "--json"], {
      cwd: target.dir,
      env,
    });
    const offered = JSON.parse(await readFile(target.probe, "utf8")) as Offered;
    return { stdout, stderr, offered };
  }

  test("**the set is handed the minted value, and the re-run hands it nothing**", async () => {
    const target = await project();
    const account = await stubCloudflare();
    servers.push(account);

    const first = await provision(target, account);

    // The value the run created, in the set's hands, in the same process that wrote it to the store.
    expect(typeof first.offered.minted).toBe("string");
    expect(first.offered.minted).not.toBe("");
    // A secret no run mints — the registry declares it and supplies no value — is `undefined` here.
    expect(first.offered.unminted).toBeNull();
    // It really was written: the account holds the entry the Worker will read it from.
    expect([...account.entries.keys()]).toEqual(["replay-staging-connection-key"]);
    expect(account.entries.get("replay-staging-connection-key")).toContain(first.offered.minted as string);

    // **The value reaches no output.** Not the `--json` line an operator pipes to a log, not stderr.
    expect(first.stdout).not.toContain(first.offered.minted as string);
    expect(first.stderr).not.toContain(first.offered.minted as string);
    // What the report does say is that it was minted — a boolean, beside the entry's name.
    expect(JSON.parse(first.stdout.trim())).toMatchObject({
      secretBindings: [
        { secret: "connection-key", entry: "replay-staging-connection-key", bound: true, minted: true },
        { secret: "connection-partner-token", bound: false, minted: false },
      ],
    });

    // **The second run creates nothing, so it offers nothing.** Absence is checked before anything is
    // generated, and the entry is already there — an empty channel, and not an error.
    const second = await provision(target, account);

    expect(second.offered).toEqual({ minted: null, unminted: null });
    expect(JSON.parse(second.stdout.trim())).toMatchObject({
      secretBindings: [{ secret: "connection-key", minted: false }, { secret: "connection-partner-token" }],
    });
    // And the run still succeeded: the set decided what an empty channel meant, and nothing threw.
    expect(account.entries.get("replay-staging-connection-key")).toContain(first.offered.minted as string);
  });
});
