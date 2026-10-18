// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  bindersOf,
  bindsKitWorker,
  bindWorker,
  boundRefusal,
  declaredServices,
  readServiceProject,
  unbindWorker,
} from "./workerBind";

let projectDir: string;

/** One app's `pithy.config.ts`: plain objects, so the fixture loads without the kit installed. */
function configSource(name: string, bindings: string[] = [], capabilities = "[]"): string {
  const list = bindings.length === 0 ? "[]" : `[\n    ${bindings.join(",\n    ")},\n  ]`;
  return `// apps/${name}/pithy.config.ts — the adopter's own words.\nconst app = {\n  name: "${name.replace(/-/g, "")}",\n  requiredBindings: ${list},\n};\n\nexport default { capabilities: ${capabilities}, app };\n`;
}

async function writeApp(name: string, source: string): Promise<void> {
  const dir = join(projectDir, "apps", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "wrangler.jsonc"),
    `{\n  "name": "acme-${name}",\n  "env": {\n    "staging": { "name": "acme-staging-${name}" },\n    "prod": { "name": "acme-prod-${name}" }\n  }\n}\n`,
  );
  await writeFile(join(dir, "pithy.config.ts"), source);
}

async function configOf(name: string): Promise<string> {
  return readFile(join(projectDir, "apps", name, "pithy.config.ts"), "utf8");
}

async function wranglerOf(
  name: string,
): Promise<{ services?: unknown[]; env: Record<string, { services?: unknown[] }> }> {
  return parse(await readFile(join(projectDir, "apps", name, "wrangler.jsonc"), "utf8")) as never;
}

/** The refusal a call throws, as its payload. */
async function refusal(run: Promise<unknown>): Promise<{ message: string; action?: string }> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(PithyError);
  return (error as PithyError).payload;
}

const SERVICE = (name: string, target: string) => `{ type: "service", name: "${name}", service: "${target}" }`;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-worker-bind-"));
  await writeFile(join(projectDir, "pithy.config.ts"), 'export default { name: "acme" };\n');
  await writeApp("app-a", configSource("app-a", ['{ type: "d1", name: "DB" }']));
  await writeApp("app-b", configSource("app-b"));
  await writeApp("app-c", configSource("app-c", [], '[{ name: "email", requiredBindings: [] }]'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("bindWorker", () => {
  test("adds the declaration and leaves every other byte of the file as it was", async () => {
    const before = await configOf("app-a");
    const report = await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    expect(report).toEqual({ from: "app-a", to: "app-b", binding: "APP_B", kind: "app", changed: true });
    expect(await configOf("app-a")).toBe(
      before.replace(
        '{ type: "d1", name: "DB" },\n',
        `{ type: "d1", name: "DB" },\n    ${SERVICE("APP_B", "app-b")},\n`,
      ),
    );
  });

  test("writes the binding into every stanza, at that environment's script", async () => {
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    const wrangler = await wranglerOf("app-a");
    expect(wrangler.services).toEqual([{ binding: "APP_B", service: "acme-app-b" }]);
    expect(wrangler.env.staging?.services).toEqual([{ binding: "APP_B", service: "acme-staging-app-b" }]);
    expect(wrangler.env.prod?.services).toEqual([{ binding: "APP_B", service: "acme-prod-app-b" }]);
  });

  test("a second run changes nothing and reports it", async () => {
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    const config = await configOf("app-a");
    const report = await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    expect(report.changed).toBe(false);
    expect(report.binding).toBe("APP_B");
    expect(await configOf("app-a")).toBe(config);
  });

  test("--binding names it", async () => {
    const report = await bindWorker({ projectDir, from: "app-a", to: "app-b", binding: "BEE" });
    expect(report.binding).toBe("BEE");
    expect(await configOf("app-a")).toContain(SERVICE("BEE", "app-b"));
  });

  test("a name that is not a binding identifier is refused", async () => {
    const { message } = await refusal(bindWorker({ projectDir, from: "app-a", to: "app-b", binding: "app-b" }));
    expect(message).toBe("app-b is not a binding name.");
  });

  test("a name the Worker already binds is refused, saying to what", async () => {
    const { message, action } = await refusal(bindWorker({ projectDir, from: "app-a", to: "app-b", binding: "DB" }));
    expect(message).toBe("app-a already binds DB, to a D1 database.");
    expect(action).toBe("Pass a different --binding.");
  });

  test("SELF is refused: provision writes it for a Worker that administers itself", async () => {
    const { message } = await refusal(bindWorker({ projectDir, from: "app-a", to: "app-b", binding: "SELF" }));
    expect(message).toBe("SELF is the binding pithy provision writes for administersItself (#616).");
  });

  test("a name the app's own Workflow binds is refused", async () => {
    await writeApp(
      "app-a",
      configSource("app-a").replace(
        "requiredBindings: [],",
        'requiredBindings: [],\n  workflows: { rotate: { binding: "KEY_ROTATION", className: "KeyRotation" } },',
      ),
    );
    const { message } = await refusal(bindWorker({ projectDir, from: "app-a", to: "app-b", binding: "KEY_ROTATION" }));
    expect(message).toBe("app-a already binds KEY_ROTATION, to a Workflow.");
  });

  test("a target named by its deploy name binds the Worker by its directory name", async () => {
    const report = await bindWorker({ projectDir, from: "app-a", to: "acme-app-b" });
    expect(report.to).toBe("app-b");
    expect((await wranglerOf("app-a")).env.prod?.services).toEqual([{ binding: "APP_B", service: "acme-prod-app-b" }]);
  });

  test("a second binding to the same target under another name is refused", async () => {
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    const { message } = await refusal(bindWorker({ projectDir, from: "app-a", to: "app-b", binding: "OTHER" }));
    expect(message).toBe("app-a already binds app-b as APP_B.");
  });

  test("a target that is no Worker is refused, naming what is bindable", async () => {
    const { message, action } = await refusal(bindWorker({ projectDir, from: "app-a", to: "app-z" }));
    expect(message).toBe("No Worker named app-z.");
    expect(action).toBe("Bindable: app-b, app-c, email.");
  });

  test("--from naming a kit Worker is refused", async () => {
    const { message } = await refusal(bindWorker({ projectDir, from: "email", to: "app-a" }));
    expect(message).toBe("email is a kit Worker. A binding is held by one of your apps/ Workers.");
  });

  test("a kit Worker nothing composes is refused, with pithy add as the action", async () => {
    const { message, action } = await refusal(bindWorker({ projectDir, from: "app-a", to: "secrets" }));
    expect(message).toBe("No Worker in this project composes secrets, so there is no secrets Worker to bind.");
    expect(action).toBe("Run `pithy add secrets --worker app-a` first.");
  });

  test("a composed kit Worker binds, at its host's script per environment", async () => {
    const report = await bindWorker({ projectDir, from: "app-a", to: "email" });
    expect(report).toEqual({ from: "app-a", to: "email", binding: "EMAIL", kind: "kit", changed: true });
    const wrangler = await wranglerOf("app-a");
    expect(wrangler.env.prod?.services).toEqual([{ binding: "EMAIL", service: "acme-prod-email" }]);
  });

  test("a binding back along an existing one is refused, printing the loop", async () => {
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    const { message } = await refusal(bindWorker({ projectDir, from: "app-b", to: "app-a" }));
    expect(message).toBe("app-b -> app-a would close a loop: app-a -> app-b -> app-a.");
  });

  test("a longer loop prints its whole path", async () => {
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    await bindWorker({ projectDir, from: "app-b", to: "app-c" });
    const { message, action } = await refusal(bindWorker({ projectDir, from: "app-c", to: "app-a" }));
    expect(message).toBe("app-c -> app-a would close a loop: app-a -> app-b -> app-c -> app-a.");
    expect(action).toBe("Remove one binding in that path first.");
  });

  test("a Worker binding itself is refused, pointing at the self binding", async () => {
    const { message, action } = await refusal(bindWorker({ projectDir, from: "app-a", to: "app-a" }));
    expect(message).toBe("A Worker does not bind itself here.");
    expect(action).toContain("administersItself");
  });
});

describe("unbindWorker", () => {
  test("by --to and by --binding each remove the entry, and a second run changes nothing", async () => {
    const before = await configOf("app-a");
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    expect(await unbindWorker({ projectDir, from: "app-a", to: "app-b" })).toEqual({
      from: "app-a",
      to: "app-b",
      binding: "APP_B",
      kind: "app",
      changed: true,
    });
    expect(await configOf("app-a")).toBe(before);
    const wrangler = await wranglerOf("app-a");
    expect(wrangler.services).toEqual([]);
    expect(wrangler.env.prod?.services).toEqual([]);
    expect((await unbindWorker({ projectDir, from: "app-a", to: "app-b" })).changed).toBe(false);

    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    expect((await unbindWorker({ projectDir, from: "app-a", binding: "APP_B" })).changed).toBe(true);
    expect(await configOf("app-a")).toBe(before);
    const again = await unbindWorker({ projectDir, from: "app-a", binding: "APP_B" });
    expect(again).toEqual({ from: "app-a", to: null, binding: "APP_B", kind: null, changed: false });
  });
});

describe("a declaration that names its target by deploy name", () => {
  beforeEach(async () => {
    await writeApp("app-a", configSource("app-a", [SERVICE("BEE", "acme-app-b")]));
  });

  test("is an edge to the Worker's directory name, so remove, deploy and doctor see it", async () => {
    const project = await readServiceProject({ projectDir });
    expect(project.edges).toEqual([{ from: "app-a", binding: "BEE", to: "app-b" }]);
    expect(bindersOf(project, "app-b")).toEqual(["app-a"]);
    expect(bindersOf(project, "acme-app-b")).toEqual(["app-a"]);
  });

  test("closes a loop the same as one by directory name", async () => {
    const { message } = await refusal(bindWorker({ projectDir, from: "app-b", to: "app-a" }));
    expect(message).toBe("app-b -> app-a would close a loop: app-a -> app-b -> app-a.");
  });

  test("is not bound a second time under the directory name", async () => {
    const report = await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    expect(report).toMatchObject({ binding: "BEE", changed: false });
  });
});

describe("unbindWorker by deploy name", () => {
  test("--to given the deploy name removes the binding bind wrote", async () => {
    const before = await configOf("app-a");
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    const report = await unbindWorker({ projectDir, from: "app-a", to: "acme-app-b" });
    expect(report).toEqual({ from: "app-a", to: "app-b", binding: "APP_B", kind: "app", changed: true });
    expect(await configOf("app-a")).toBe(before);
  });
});

describe("readServiceProject, per Worker", () => {
  test("a config that broke keeps the Worker, its literal declarations and the reason", async () => {
    await writeApp("app-a", configSource("app-a", [SERVICE("APP_B", "app-b")]));
    const broken = new Error("syntax");
    const project = await readServiceProject({
      projectDir,
      loadConfig: async (dir, options) => {
        if (dir.endsWith("app-a")) throw broken;
        const { loadWorkerConfig } = await import("./config");
        return loadWorkerConfig(dir, options);
      },
    });
    const appA = project.workers.find((worker) => worker.app === "app-a");
    expect(appA).toMatchObject({ bindings: null, capabilities: [], loadError: broken });
    expect(appA?.services).toEqual([{ binding: "APP_B", target: "app-b" }]);
    expect(bindersOf(project, "app-b")).toEqual(["app-a"]);
  });

  test("no pithy.config.ts at all is a Worker with nothing declared, and no fault", async () => {
    await rm(join(projectDir, "apps", "app-b", "pithy.config.ts"));
    const project = await readServiceProject({ projectDir });
    const appB = project.workers.find((worker) => worker.app === "app-b");
    expect(appB).toEqual({
      app: "app-b",
      dir: join(projectDir, "apps", "app-b"),
      deployedAs: "acme-app-b",
      bindings: [],
      services: [],
      capabilities: [],
    });
  });
});

describe("bindsKitWorker", () => {
  test("is true only once an app binds a kit Worker", async () => {
    expect(await bindsKitWorker({ projectDir })).toBe(false);
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    expect(await bindsKitWorker({ projectDir })).toBe(false);
    await bindWorker({ projectDir, from: "app-a", to: "email" });
    expect(await bindsKitWorker({ projectDir })).toBe(true);
  });

  test("is false, never a throw, for a project it cannot read", async () => {
    const discoverWorkers = async () => {
      throw new Error("unreadable");
    };
    expect(await bindsKitWorker({ projectDir, discoverWorkers })).toBe(false);
  });
});

describe("declaredServices", () => {
  test("lists the app's service bindings, and nothing for a config that will not load", async () => {
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    expect(await declaredServices(join(projectDir, "apps", "app-a"))).toEqual([{ binding: "APP_B", target: "app-b" }]);
    await writeFile(join(projectDir, "apps", "app-b", "pithy.config.ts"), "export default {;\n");
    expect(await declaredServices(join(projectDir, "apps", "app-b"))).toEqual([]);
  });
});

describe("bindersOf", () => {
  test("names every other Worker binding the target, and the refusal names them", async () => {
    await bindWorker({ projectDir, from: "app-a", to: "app-b" });
    await bindWorker({ projectDir, from: "app-c", to: "app-b" });
    const binders = bindersOf(await readServiceProject({ projectDir }), "app-b");
    expect(binders).toEqual(["app-a", "app-c"]);
    expect(boundRefusal("app-b", binders).payload.message).toBe("app-a and app-c bind app-b.");
    expect(boundRefusal("app-b", binders).payload.action).toBe("Run pithy worker unbind for each first.");
    expect(bindersOf(await readServiceProject({ projectDir }), "app-a")).toEqual([]);
  });
});
