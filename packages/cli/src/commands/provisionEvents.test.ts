// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { publishedEvents } from "../contract/commandContract";
import { scaffoldProject } from "../project/scaffold";
import type { ProvisionedResource } from "../provision/environment";
import { withErrorReporting } from "../terminal/output";
import { recorder } from "../test-utils/cloudflareRecorder";
import { linkKitPackages } from "../test-utils/linkKit";
import { commandAt, contractAt } from "../test-utils/payloadContract";
import { removeTempDir } from "../test-utils/tempRepo";
import { provisionProgress } from "./provision";

/**
 * **`pithy provision --json --events`: the run, said as it goes (#697).** A record per step on stdout, and
 * nothing a person reads — not the plan the confirmation is hung off, not the step lines. The real command, in
 * a scaffolded project, against an account that refuses its first write: the stream up to the failure is
 * what is asserted, and the error line goes to stderr as every `--json` refusal does. One case lets that write
 * through, so the run reaches its end and the document closes the stream.
 */

const cloudflare = vi.hoisted(() => ({ current: undefined as unknown as { clients: () => Promise<unknown> } }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: () => cloudflare.current.clients(),
}));

// The remote migrate is its own command with its own tests; here it only has to finish, so a run reaches its end.
const migrated = vi.hoisted(() => ({ runs: [] as string[] }));
vi.mock("../migrations/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../migrations/run")>()),
  migrateProject: async ({ env }: { env: string }) => {
    migrated.runs.push(env);
    return [];
  },
}));

/**
 * The recorder's account, except that it creates a D1 when asked: the one write this project's run makes
 * before it migrates. Every other call goes to the recorder, which still refuses any other write.
 */
function creatingAccount(account: ReturnType<typeof recorder>): { clients: () => Promise<unknown> } {
  return {
    clients: async () => {
      const real = (await account.clients()) as Record<string, () => Record<string, unknown>>;
      return new Proxy(real, {
        get: (target, name) => {
          if (name !== "d1Provisioner") return Reflect.get(target, name);
          return () =>
            new Proxy(target.d1Provisioner?.() ?? {}, {
              get: (manager, method) =>
                method === "createDatabase"
                  ? async (database: string) => {
                      account.calls.push("d1Provisioner.createDatabase");
                      return { uuid: "d1-1", name: database };
                    }
                  : Reflect.get(manager, method),
            });
        },
      });
    },
  };
}

/** The app capability: one database, one migration, bound as `DB`. */
const APP_CONFIG = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const app = defineCapability({
  name: "app",
  requiredBindings: [{ type: "d1", name: "DB" }],
  databases: {
    app: {
      binding: "DB",
      tables: {},
      migrations: {
        "0001_things": {
          up: async (db) => {
            await db.schema.createTable("things").addColumn("id", "integer").execute();
          },
          down: async (db) => {
            await db.schema.dropTable("things").execute();
          },
        },
      },
      migrationOrder: 1000,
    },
  },
});

export default { capabilities: [], app };
`;

let dir: string;
let account: ReturnType<typeof recorder>;

beforeEach(async () => {
  account = recorder();
  cloudflare.current = account;
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
  dir = await mkdtemp(join(tmpdir(), "pithy-provision-events-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  await writeFile(join(dir, "apps", "api", "pithy.config.ts"), APP_CONFIG);
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
  await removeTempDir(dir);
});

/** Run the real command with `rawArgs`, catching the exit a refusal ends in, and hand back both streams. */
async function provision(rawArgs: string[]): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exited");
  }) as never);
  await runCommand(await commandAt("provision"), { rawArgs }).catch(() => undefined);
  return { stdout: out.join(""), stderr: err.join("") };
}

describe("pithy provision --json --events", () => {
  test("every line on stdout is a progress record, and the plan a person reads is not among them", async () => {
    const { stdout } = await provision(["--env", "staging", "--yes", "--json", "--events"]);

    const lines = stdout.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const events = publishedEvents(await contractAt("provision"));
    for (const line of lines) {
      const record: unknown = JSON.parse(line);
      expect(line).toBe(JSON.stringify(record));
      expect(events?.safeParse(record).error?.issues).toBeUndefined();
    }
    expect(JSON.parse(lines[0] as string)).toEqual({
      command: "provision",
      schemaVersion: 1,
      event: "start",
      what: "acme-staging-db",
      binding: "DB",
      kind: "d1",
    });
    expect(stdout).not.toContain("▸");
  });

  /**
   * **The stream is closed by the document (#697).** A run that reaches its end writes a record per step and
   * then the `--json` document as the last line: compact, carrying `schemaVersion`, and the one line with no
   * `event` — which is how a reader knows the stream is over.
   */
  test("a run that succeeds ends the stream with the result document", async () => {
    cloudflare.current = creatingAccount(account);
    const { stdout, stderr } = await provision(["--env", "staging", "--yes", "--json", "--events"]);

    expect(stderr).toBe("");
    expect(migrated.runs).toEqual(["staging"]);
    const lines = stdout.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    const records = lines.map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(line).toBe(JSON.stringify(record));
      return record;
    });
    const progress = records.slice(0, -1);
    const events = publishedEvents(await contractAt("provision"));
    for (const record of progress) {
      expect(record).toHaveProperty("event");
      expect(events?.safeParse(record).error?.issues).toBeUndefined();
    }
    expect(progress.map((record) => record.event)).toContain("settled");
    expect(progress).toContainEqual(
      expect.objectContaining({
        event: "settled",
        resource: { kind: "d1", binding: "DB", name: "acme-staging-db", id: "d1-1", created: true },
      }),
    );

    const result = records.at(-1) as Record<string, unknown>;
    expect(result).not.toHaveProperty("event");
    expect(result).toMatchObject({ command: "provision", schemaVersion: 1, env: "staging" });
    expect(result.resources).toEqual([
      { kind: "d1", binding: "DB", name: "acme-staging-db", id: "d1-1", created: true },
    ]);
    expect(account.writes).toEqual([]);
  });

  test("without --events the same run writes nothing to stdout before it fails", async () => {
    const { stdout } = await provision(["--env", "staging", "--yes", "--json"]);
    expect(stdout).toBe("");
  });
});

describe("provisionProgress under --events", () => {
  test("a resource starts with its binding and kind, and settles with its row", async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    const resource: ProvisionedResource = {
      kind: "d1",
      binding: "DB",
      name: "acme-staging-db",
      id: "d1-1",
      created: true,
    };
    await withErrorReporting(true, async () => {
      const progress = provisionProgress({ json: true, events: true });
      progress?.({ phase: "start", name: "acme-staging-db", binding: "DB", kind: "d1" });
      progress?.({ phase: "settled", resource });
    });
    expect(written.map((line) => JSON.parse(line) as unknown)).toEqual([
      { command: "provision", event: "start", what: "acme-staging-db", binding: "DB", kind: "d1" },
      { command: "provision", event: "settled", line: "acme-staging-db: created.", resource },
    ]);
  });
});
