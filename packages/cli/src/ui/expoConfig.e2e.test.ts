// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { TEMPLATE_DIR } from "@pithy-sh/ui-react-native/src/templates";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCaptured } from "../test-utils/payloadContract";

/**
 * **A freshly scaffolded Expo app's config loads under Expo's own CLI.**
 *
 * Expo reads `app.config.ts` with its own loader, outside Metro, so a template that typechecks and renders under
 * test can still fail to load there, and `pithy dev` stops every Worker when the app exits. Only running Expo
 * proves it loads.
 *
 * The project's `node_modules` is a link to `@pithy-sh/ui-react-native`'s, which holds Expo and every config plugin
 * the template names. The project itself stays outside any `node_modules`: Expo hands `app.config.ts`'s imports to
 * Node, and Node strips types from no file under one.
 */

const exec = promisify(execFile);

/** The template package, whose `node_modules` holds Expo and the plugins. */
const TEMPLATE_PACKAGE = dirname(TEMPLATE_DIR);

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-expo-config-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pithy init --target both --react-native", () => {
  test("expo config reads the app's app.config.ts and exits 0", async () => {
    const project = join(root, "acme");
    await runCaptured("init", ["--dir", project, "--name", "acme", "--target", "both", "--react-native", "--json"]);
    await symlink(join(TEMPLATE_PACKAGE, "node_modules"), join(project, "node_modules"), "dir");

    const expo = join(TEMPLATE_PACKAGE, "node_modules", ".bin", "expo");
    const { stdout } = await exec(expo, ["config", "--type", "public", "--json"], {
      cwd: join(project, "apps", "app"),
      env: { ...process.env, EXPO_NO_TELEMETRY: "1" },
    });
    const config = JSON.parse(stdout) as { name: string; scheme: string };
    expect(config.name).toBe("app");
    expect(config.scheme).toBeTruthy();
  });
});
