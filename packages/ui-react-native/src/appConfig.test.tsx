// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const dirs: string[] = [];

/**
 * The Expo config the template answers for the app at `projectRoot`, with `src/pithy-config.generated.ts` naming
 * `universalLinkOrigin`.
 */
async function expoConfig(universalLinkOrigin: string | null, projectRoot = "/nowhere/apps/app") {
  vi.doMock("../templates/src/pithy-config.generated.ts", () => ({
    default: { appScheme: "pithyapp", universalLinkOrigin, google: { webClientId: null, iosClientId: null } },
  }));
  const { default: config } = await import("../templates/app.config");
  return config({ projectRoot, staticConfigPath: null, packageJsonPath: null, config: {} });
}

/** An app at `apps/app` whose `ui.worker` is `api`, a Worker its `wrangler.jsonc` names `demo-api`. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pithy-app-config-"));
  dirs.push(root);
  await mkdir(join(root, "apps", "app"), { recursive: true });
  await writeFile(join(root, "apps", "app", "pithy.worker.jsonc"), '{ "ui": { "worker": "api" } }\n');
  await mkdir(join(root, "apps", "api"), { recursive: true });
  await writeFile(join(root, "apps", "api", "wrangler.jsonc"), '{ "name": "demo-api" }\n');
  return join(root, "apps", "app");
}

afterEach(async () => {
  vi.doUnmock("../templates/src/pithy-config.generated.ts");
  vi.resetModules();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the app's universal link", () => {
  test("with none set, the app claims no https host on either platform", async () => {
    const config = await expoConfig(null);
    expect(config.ios?.associatedDomains).toEqual([]);
    expect(config.android?.intentFilters).toEqual([]);
  });

  test("once set, iOS and Android both claim its host", async () => {
    const config = await expoConfig("https://links.example.com");
    expect(config.ios?.associatedDomains).toEqual(["applinks:links.example.com"]);
    expect(config.android?.intentFilters).toEqual([
      expect.objectContaining({ autoVerify: true, data: [{ scheme: "https", host: "links.example.com" }] }),
    ]);
  });
});

describe("the Worker origin the phone builds call in dev", () => {
  test("is the origin pithy dev exports for the app's Worker, from the expo start it runs", async () => {
    vi.stubEnv("DEMO_API_ORIGIN", "http://localhost:9901");
    const config = await expoConfig(null, await project());
    expect(config.extra?.pithyDevOrigin).toBe("http://localhost:9901");
  });

  test("is none under a hand-run expo start, so the app reads origins.dev", async () => {
    vi.stubEnv("DEMO_API_ORIGIN", undefined);
    const config = await expoConfig(null, await project());
    expect(config.extra?.pithyDevOrigin).toBeNull();
  });

  test("is none for an app with no readable ui.worker", async () => {
    vi.stubEnv("API_ORIGIN", "http://localhost:9901");
    const config = await expoConfig(null);
    expect(config.extra?.pithyDevOrigin).toBeNull();
  });
});
