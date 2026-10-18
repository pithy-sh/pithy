// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { reconcileServiceStanzas, type ServiceWorkerNames, serviceScripts } from "./serviceStanzas";

let dir: string;
let appA: ServiceWorkerNames;
let appB: ServiceWorkerNames;

const A_WRANGLER = `{
  // app-a's own note.
  "name": "acme-app-a",
  "env": {
    "staging": { "name": "acme-staging-app-a" },
    "prod": { "name": "acme-prod-app-a" }
  }
}
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-service-stanzas-"));
  appA = { app: "app-a", dir: join(dir, "apps", "app-a"), deployedAs: "acme-app-a" };
  appB = { app: "app-b", dir: join(dir, "apps", "app-b"), deployedAs: "acme-app-b" };
  await mkdir(appA.dir, { recursive: true });
  await mkdir(appB.dir, { recursive: true });
  await writeFile(join(appA.dir, "wrangler.jsonc"), A_WRANGLER);
  // app-b declares prod's name and leaves staging to the scope.
  await writeFile(
    join(appB.dir, "wrangler.jsonc"),
    '{ "name": "acme-app-b", "env": { "staging": {}, "prod": { "name": "acme-prod-app-b" } } }\n',
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function stanzas(): Promise<Record<string, unknown>> {
  return parse(await readFile(join(appA.dir, "wrangler.jsonc"), "utf8")) as unknown as Record<string, unknown>;
}

describe("serviceScripts", () => {
  test("an apps/ target resolves to the script it deploys as, per environment", async () => {
    const scripts = await serviceScripts("acme", [appA, appB]);
    expect(scripts("app-b", "dev")).toBe("acme-app-b");
    expect(scripts("app-b", "prod")).toBe("acme-prod-app-b");
    // Nothing declared for staging: wrangler's own `<script>-<env>`, as provisioning composes it.
    expect(scripts("app-b", "staging")).toBe("acme-app-b-staging");
  });

  test("an apps/ target named by its deploy name resolves the same, as provision has always taken it", async () => {
    const scripts = await serviceScripts("acme", [appA, appB]);
    expect(scripts("acme-app-b", "dev")).toBe("acme-app-b");
    expect(scripts("acme-app-b", "prod")).toBe("acme-prod-app-b");
    expect(scripts("acme-app-b", "staging")).toBe("acme-app-b-staging");
  });

  test("a kit Worker resolves to its host's script in that environment", async () => {
    const scripts = await serviceScripts("acme", [appA]);
    expect(scripts("email", "staging")).toBe("acme-staging-email");
    expect(scripts("secrets", "dev")).toBe("acme-dev-secrets");
  });

  test("anything else is refused, naming the project's Workers", async () => {
    const scripts = await serviceScripts("acme", [appA, appB]);
    const error = (() => {
      try {
        scripts("app-z", "dev");
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.action).toContain("app-a, app-b");
  });
});

describe("reconcileServiceStanzas", () => {
  test("writes each binding into every stanza at that environment's script", async () => {
    const runs = await reconcileServiceStanzas({
      workerDir: appA.dir,
      services: [{ binding: "APP_B", target: "app-b" }],
      scripts: await serviceScripts("acme", [appA, appB]),
    });
    expect(runs.map((run) => [run.env, run.changed])).toEqual([
      ["dev", true],
      ["staging", true],
      ["prod", true],
    ]);
    const config = (await stanzas()) as {
      services: unknown[];
      env: Record<string, { services: unknown[] }>;
    };
    expect(config.services).toEqual([{ binding: "APP_B", service: "acme-app-b" }]);
    expect(config.env.staging?.services).toEqual([{ binding: "APP_B", service: "acme-app-b-staging" }]);
    expect(config.env.prod?.services).toEqual([{ binding: "APP_B", service: "acme-prod-app-b" }]);
    expect(await readFile(join(appA.dir, "wrangler.jsonc"), "utf8")).toContain("// app-a's own note.");
  });

  test("a second run changes nothing and writes nothing", async () => {
    const options = {
      workerDir: appA.dir,
      services: [{ binding: "APP_B", target: "app-b" }],
      scripts: await serviceScripts("acme", [appA, appB]),
    };
    await reconcileServiceStanzas(options);
    const before = await readFile(join(appA.dir, "wrangler.jsonc"), "utf8");
    const runs = await reconcileServiceStanzas(options);
    expect(runs.every((run) => !run.changed)).toBe(true);
    expect(await readFile(join(appA.dir, "wrangler.jsonc"), "utf8")).toBe(before);
  });

  test("a hand-written entry is kept, and only a named removal takes one out", async () => {
    await writeFile(
      join(appA.dir, "wrangler.jsonc"),
      '{ "name": "acme-app-a", "services": [{ "binding": "MINE", "service": "elsewhere" }, { "binding": "APP_B", "service": "acme-app-b" }] }\n',
    );
    const scripts = await serviceScripts("acme", [appA, appB]);
    await reconcileServiceStanzas({ workerDir: appA.dir, services: [], scripts });
    expect(((await stanzas()) as { services: unknown[] }).services).toHaveLength(2);
    await reconcileServiceStanzas({ workerDir: appA.dir, services: [], scripts, remove: ["APP_B"] });
    expect(((await stanzas()) as { services: unknown[] }).services).toEqual([
      { binding: "MINE", service: "elsewhere" },
    ]);
  });

  test("`--env` narrows to one stanza, and a feature's is never written here", async () => {
    const scripts = await serviceScripts("acme", [appA, appB]);
    const services = [{ binding: "APP_B", target: "app-b" }];
    expect(
      (await reconcileServiceStanzas({ workerDir: appA.dir, services, scripts, env: "prod" })).map((run) => run.env),
    ).toEqual(["prod"]);
    expect(await reconcileServiceStanzas({ workerDir: appA.dir, services, scripts, env: "feature" })).toEqual([]);
  });
});
