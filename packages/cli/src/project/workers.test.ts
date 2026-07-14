import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { discoverWorkers } from "./workers";

describe("discoverWorkers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-workers-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeWorker(at: string, name: string): Promise<void> {
    await mkdir(at, { recursive: true });
    await writeFile(join(at, "wrangler.jsonc"), JSON.stringify({ name }));
  }

  test("enumerates apps/* workers, named by their wrangler.jsonc, sorted", async () => {
    await writeWorker(join(dir, "apps", "web"), "pithy-web");
    await writeWorker(join(dir, "apps", "api"), "pithy-api");

    const workers = await discoverWorkers(dir);

    expect(workers).toEqual([
      { name: "pithy-api", dir: join(dir, "apps", "api") },
      { name: "pithy-web", dir: join(dir, "apps", "web") },
    ]);
  });

  test("ignores apps/ entries without a wrangler.jsonc", async () => {
    await writeWorker(join(dir, "apps", "api"), "pithy-api");
    await mkdir(join(dir, "apps", "notes"), { recursive: true });

    const workers = await discoverWorkers(dir);

    expect(workers.map((w) => w.name)).toEqual(["pithy-api"]);
  });

  test("falls back to the root worker when there is no apps/ registry", async () => {
    await writeWorker(dir, "pithy-app");

    const workers = await discoverWorkers(dir);

    expect(workers).toEqual([{ name: "pithy-app", dir }]);
  });

  test("returns nothing when neither apps/* nor a root wrangler.jsonc exists", async () => {
    expect(await discoverWorkers(dir)).toEqual([]);
  });
});
