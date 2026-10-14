// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { scaffoldProject } from "../project/scaffold";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms } from "../test-utils/payloadContract";
import { renderReport } from "./contract";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "..", "bin.ts");

/**
 * A Worker with one described route and one that is not — the two cases `pithy contract` must tell
 * apart. Written over the scaffold's own config, so everything else about the project is real.
 */
const CONFIG = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import { z } from "zod";

const Greeting = z.object({ text: z.string().describe("What to say.") }).describe("A greeting.");
const Who = z.object({ name: z.string().describe("Who to greet.") }).describe("Who.");

const app = defineCapability({
  name: "app",
  requiredBindings: [],
  routes: (a) => {
    a.get(
      "/hello/:name",
      describeRoute({ summary: "Say hello.", verification: "public", responses: { 200: Greeting } }),
      validate("param", Who),
      (c) => c.json({ text: \`Hello, \${c.req.valid("param").name}.\` }),
    );
    a.post("/raw", (c) => c.text("raw"));
  },
  sockets: [
    {
      name: "appRoom",
      path: "/rooms/:id/socket",
      summary: "Play in a room.",
      verification: "public",
      params: Who,
      versions: { current: "app.room.v1", previous: null },
      send: [{ name: "state", summary: "The room.", schema: Greeting }],
      receive: [{ name: "ping", summary: "Keep it open.", text: "ping" }],
    },
  ],
});

export default { domains: {}, capabilities: [], app };
`;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-contract-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
  // The config below imports zod itself, as an adopter's does. Linked from this workspace, like the kit.
  const zod = dirname(createRequire(import.meta.url).resolve("zod/package.json"));
  await symlink(await realpath(zod), join(dir, "node_modules", "zod"));
  await writeFile(join(dir, "apps", "api", "pithy.config.ts"), CONFIG);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function pithy(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PITHY_NO_UPDATE_NOTIFIER: "1",
    PITHY_CONFIG_DIR: join(dir, ".config"),
  };
  for (const key of ["PITHY_JSON", "PITHY_NONINTERACTIVE", "CI"]) delete env[key];
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], { cwd: dir, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

describe("pithy contract", () => {
  test("writes the Worker's document beside it: health, the described route in full, the other marked", async () => {
    const { code, stdout } = await pithy(["contract", "--json"]);
    expect(code).toBe(0);
    await expectConforms("contract", [stdout]);
    const payload = JSON.parse(stdout) as { environment: string; workers: Record<string, unknown>[] };
    expect(payload.environment).toBe("prod");
    expect(payload.workers).toEqual([
      {
        worker: "api",
        path: join("apps", "api", "openapi.json"),
        operations: 3,
        undescribed: [{ method: "POST", path: "/raw" }],
        changed: true,
        asyncapi: { path: join("apps", "api", "asyncapi.json"), channels: 1, changed: true },
      },
    ]);
    const sockets = JSON.parse(await readFile(join(dir, "apps", "api", "asyncapi.json"), "utf8")) as {
      asyncapi: string;
      channels: Record<string, { address: string }>;
    };
    expect(sockets.asyncapi).toBe("3.0.0");
    expect(sockets.channels.appRoom?.address).toBe("/rooms/{id}/socket");

    const document = JSON.parse(await readFile(join(dir, "apps", "api", "openapi.json"), "utf8")) as {
      info: { title: string };
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.info.title).toBe("acme api");
    expect(Object.keys(document.paths).sort()).toEqual(["/health", "/hello/{name}", "/raw"]);
    expect(document.paths["/hello/{name}"]?.get?.summary).toBe("Say hello.");
    expect(document.paths["/raw"]?.post?.["x-pithy-undescribed"]).toBe(true);
  }, 60_000);

  test("a second run writes nothing, and --out puts each document under <dir>/<worker>/", async () => {
    const again = JSON.parse((await pithy(["contract", "--json"])).stdout) as { workers: { changed: boolean }[] };
    expect(again.workers.map((worker) => worker.changed)).toEqual([false]);

    const { code } = await pithy(["contract", "--worker", "api", "--out", "contracts", "--json"]);
    expect(code).toBe(0);
    for (const file of ["openapi.json", "asyncapi.json"]) {
      expect(await readFile(join(dir, "contracts", "api", file), "utf8")).toBe(
        await readFile(join(dir, "apps", "api", file), "utf8"),
      );
    }
  }, 60_000);

  test("a Worker that stops serving a socket loses its generated asyncapi.json, never a hand-written one", async () => {
    const config = join(dir, "apps", "api", "pithy.config.ts");
    const withSocket = await readFile(config, "utf8");
    try {
      await writeFile(config, withSocket.replace(/\n {2}sockets: \[[\s\S]*?\n {2}\],\n/, "\n"));
      const { stdout } = await pithy(["contract", "--json"]);
      expect((JSON.parse(stdout) as { workers: { asyncapi: unknown }[] }).workers[0]?.asyncapi).toBeNull();
      await expect(readFile(join(dir, "apps", "api", "asyncapi.json"), "utf8")).rejects.toThrow();

      const mine =
        '{ "asyncapi": "3.0.0", "info": { "title": "Mine", "version": "1", "description": "Hand-written." } }\n';
      await writeFile(join(dir, "apps", "api", "asyncapi.json"), mine);
      await pithy(["contract", "--json"]);
      expect(await readFile(join(dir, "apps", "api", "asyncapi.json"), "utf8")).toBe(mine);
    } finally {
      await writeFile(config, withSocket);
    }
  }, 60_000);

  test("refuses an environment that is not one, before composing anything", async () => {
    const { code, stderr } = await pithy(["contract", "--env", "production", "--json"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("prod");
  }, 60_000);
});

describe("renderReport", () => {
  test("says what was written, and lists the routes still to describe", () => {
    const lines = renderReport({
      worker: "api",
      path: "apps/api/openapi.json",
      operations: 3,
      undescribed: [{ method: "POST", path: "/raw" }],
      changed: true,
      asyncapi: { path: "apps/api/asyncapi.json", channels: 1, changed: false },
    });
    expect(lines[0]).toBe("api: 3 operations. Wrote apps/api/openapi.json.");
    expect(lines[1]).toBe("api: 1 socket. Unchanged: apps/api/asyncapi.json.");
    expect(lines.join("\n")).toContain("POST /raw");
  });

  test("an unchanged document says so, and a fully described Worker is one line", () => {
    expect(
      renderReport({
        worker: "api",
        path: "apps/api/openapi.json",
        operations: 1,
        undescribed: [],
        changed: false,
        asyncapi: null,
      }),
    ).toEqual(["api: 1 operations. Unchanged: apps/api/openapi.json."]);
  });
});
