import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterAll, describe, expect, test } from "vitest";
import { loadWorkerConfig } from "./workerConfig";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workerDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-worker-config-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

async function caught(promise: Promise<unknown>): Promise<PithyError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(PithyError);
  return error as PithyError;
}

describe("loadWorkerConfig", () => {
  test("indexes the composed capabilities by name, app included", async () => {
    const dir = await workerDir({
      "pithy.config.ts": `
        export default {
          capabilities: [
            { name: "auth", requiredBindings: [] },
            { name: "wallet", requiredBindings: [] },
          ],
          app: { name: "api", requiredBindings: [] },
        };
      `,
    });
    const { capabilities } = await loadWorkerConfig(join(dir, "pithy.config.ts"));
    expect([...capabilities.keys()].sort()).toEqual(["api", "auth", "wallet"]);
  });

  test("loads TypeScript syntax and extensionless relative imports — what a bare import() cannot", async () => {
    const dir = await workerDir({
      "pithy.config.ts": `
        import { auth } from "./capabilities";
        interface WorkerConfig { capabilities: unknown[] }
        const config: WorkerConfig = { capabilities: [auth] };
        export default config satisfies WorkerConfig;
      `,
      "capabilities.ts": `
        export const auth = { name: "auth", requiredBindings: [] as const };
      `,
    });
    const loaded = await loadWorkerConfig(join(dir, "pithy.config.ts"));
    expect([...loaded.capabilities.keys()]).toEqual(["auth"]);
    expect(loaded.dependencies.some((file) => file.endsWith("capabilities.ts"))).toBe(true);
  });

  test("a worker with no app capability is fine", async () => {
    const dir = await workerDir({ "pithy.config.ts": "export default { capabilities: [] };" });
    const { capabilities } = await loadWorkerConfig(join(dir, "pithy.config.ts"));
    expect(capabilities.size).toBe(0);
  });

  test("a missing config names the file and the command that writes it", async () => {
    const dir = await workerDir({});
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.code).toBe("core/not_found");
    expect(error.payload.message).toContain("pithy.config.ts");
    expect(error.payload.action).toContain("pithy ui add");
  });

  test("a config that throws on import is reported with its cause in detail, not as a stack", async () => {
    const dir = await workerDir({ "pithy.config.ts": 'throw new Error("boom");' });
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.code).toBe("core/internal");
    expect(error.payload.message).toContain("Could not load");
    expect(error.payload.detail).toContain("boom");
  });

  test("a config without a capabilities array is rejected", async () => {
    const dir = await workerDir({ "pithy.config.ts": 'export default { name: "acme" };' });
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.action).toBe("Export default { capabilities, app }.");
  });

  test("a non-capability in the capabilities array is rejected rather than silently skipped", async () => {
    const dir = await workerDir({ "pithy.config.ts": "export default { capabilities: [undefined] };" });
    const error = await caught(loadWorkerConfig(join(dir, "pithy.config.ts")));
    expect(error.payload.message).toContain("isn't a capability");
  });
});
