// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkServiceBindings, describeServiceBinding, serviceBindingFix } from "./serviceBindings";

let projectDir: string;

/** One app, its config edited by hand: plain objects, so it loads without the kit installed. */
async function app(name: string, services: [string, string][] = [], capabilities = "[]"): Promise<void> {
  const dir = join(projectDir, "apps", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "wrangler.jsonc"), `{ "name": "acme-${name}" }\n`);
  const bindings = services.map(([binding, target]) => `{ type: "service", name: "${binding}", service: "${target}" }`);
  await writeFile(
    join(dir, "pithy.config.ts"),
    `const app = { name: "x", requiredBindings: [${bindings.join(", ")}] };\nexport default { capabilities: ${capabilities}, app };\n`,
  );
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-doctor-services-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("checkServiceBindings", () => {
  test("every binding reaching a Worker that is there is ok", async () => {
    await app("app-a", [
      ["APP_B", "app-b"],
      ["EMAIL", "email"],
    ]);
    await app("app-b", [], '[{ name: "email", requiredBindings: [] }]');
    expect(await checkServiceBindings({ projectDir })).toEqual({ state: "ok", faults: [] });
  });

  test("a loop in a hand-edited config is reported with the path the bind refusal prints", async () => {
    await app("app-a", [["APP_B", "app-b"]]);
    await app("app-b", [["APP_C", "app-c"]]);
    await app("app-c", [["APP_A", "app-a"]]);
    const check = await checkServiceBindings({ projectDir });
    expect(check.state).toBe("faulty");
    expect(check.faults).toHaveLength(1);
    const [loop] = check.faults;
    expect(loop?.path).toEqual(["app-a", "app-b", "app-c", "app-a"]);
    expect(describeServiceBinding(loop as never)).toBe(
      "app-c -> app-a closes a loop: app-a -> app-b -> app-c -> app-a.",
    );
    expect(serviceBindingFix(loop as never)).toBeNull();
  });

  test("a binding whose target does not exist is reported, and unbinding it is the fix", async () => {
    await app("app-a", [["APP_Z", "app-z"]]);
    const check = await checkServiceBindings({ projectDir });
    expect(check.faults).toEqual([
      { kind: "missing-target", worker: "app-a", binding: "APP_Z", target: "app-z", path: null },
    ]);
    expect(describeServiceBinding(check.faults[0] as never)).toBe(
      "binds APP_Z to app-z, which is no Worker of this project.",
    );
    expect(serviceBindingFix(check.faults[0] as never)).toBe("pithy worker unbind --from app-a --binding APP_Z");
  });

  test("a target named by its deploy name is that Worker, and a loop through it is still a loop", async () => {
    await app("app-a", [["APP_B", "acme-app-b"]]);
    await app("app-b");
    expect(await checkServiceBindings({ projectDir })).toEqual({ state: "ok", faults: [] });
    await app("app-b", [["APP_A", "app-a"]]);
    const check = await checkServiceBindings({ projectDir });
    expect(check.faults.map((fault) => fault.kind)).toEqual(["loop"]);
  });

  test("a kit target whose capability nothing composes any more is reported", async () => {
    await app("app-a", [["EMAIL", "email"]]);
    const check = await checkServiceBindings({ projectDir });
    expect(check.faults).toEqual([
      { kind: "uncomposed", worker: "app-a", binding: "EMAIL", target: "email", path: null },
    ]);
    expect(describeServiceBinding(check.faults[0] as never)).toContain("no Worker composes email");
  });

  test("a project it cannot read is could-not-check, never a fault", async () => {
    const check = await checkServiceBindings({
      projectDir,
      discoverWorkers: async () => {
        throw new Error("unreadable");
      },
    });
    expect(check).toEqual({ state: "could-not-check", faults: [] });
  });
});
