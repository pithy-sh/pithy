// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { operationCount, projectVersion, renderDocument, workerDocument } from "./workerContract";

const Pong = z.object({ pong: z.boolean().describe("Always true.") }).describe("A pong.");

const app = defineCapability({
  name: "app",
  requiredBindings: [],
  routes: (hono) => {
    hono.get("/ping", describeRoute({ summary: "Ping.", verification: "public", responses: { 200: Pong } }), (c) =>
      c.json({ pong: true }),
    );
    hono.put("/ping", (c) => c.text("undescribed"));
  },
});

describe("workerDocument", () => {
  const { document, undescribed } = workerDocument({
    worker: "api",
    project: "acme",
    version: "1.2.3",
    config: { capabilities: [], app },
  });

  test("titles the document by project and Worker, at the project's version", () => {
    expect(document.info).toEqual(expect.objectContaining({ title: "acme api", version: "1.2.3" }));
  });

  test("includes health, the described route, and the undescribed one, marked", () => {
    expect(Object.keys(document.paths)).toEqual(["/health", "/ping"]);
    expect(Object.keys(document.paths["/ping"] ?? {})).toEqual(["get", "put"]);
    expect(document.paths["/ping"]?.put).toEqual(expect.objectContaining({ "x-pithy-undescribed": true }));
    expect(undescribed).toEqual([{ method: "PUT", path: "/ping" }]);
  });

  test("counts one operation per method and path", () => {
    expect(operationCount(document)).toBe(3);
  });

  test("renders as two-space JSON with a trailing newline", () => {
    expect(renderDocument(document)).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });
});

describe("projectVersion", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-contract-version-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("is the project's package.json version", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "acme", version: "2.0.1" }));
    expect(await projectVersion(dir)).toBe("2.0.1");
  });

  test("is 0.0.0 with no package.json, or one with no version", async () => {
    expect(await projectVersion(dir)).toBe("0.0.0");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "acme", private: true }));
    expect(await projectVersion(dir)).toBe("0.0.0");
  });
});
