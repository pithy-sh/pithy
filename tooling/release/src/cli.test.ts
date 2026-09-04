// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";
import type { ReleaseRecord } from "./records";

/** A repo on disk: `.changeset/` and a couple of packages, which is all any of these commands read. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "pithy-release-cli-"));
  mkdirSync(join(root, ".changeset"), { recursive: true });

  return {
    root,
    changeset(name: string, body: string) {
      writeFileSync(join(root, ".changeset", `${name}.md`), body);
    },
    pkg(dir: string, manifest: Record<string, unknown>) {
      mkdirSync(join(root, "packages", dir), { recursive: true });
      writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(manifest));
    },
    changelog(dir: string, text: string) {
      mkdirSync(join(root, "packages", dir), { recursive: true });
      writeFileSync(join(root, "packages", dir, "CHANGELOG.md"), text);
    },
    /** Stand in for what `changeset version` does to the manifests. */
    version(dir: string, name: string, version: string) {
      writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name, version }));
    },
    records(): ReleaseRecord[] {
      return JSON.parse(readFileSync(join(root, ".release", "records.json"), "utf8")) as ReleaseRecord[];
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const FLAGGED = [
  "---",
  '"@pithy-sh/auth": patch',
  "---",
  "",
  "Refresh-token reuse now revokes the whole family.",
  "",
  "Security: a revoked refresh token stayed valid until its natural expiry.",
].join("\n");

const PLAIN = ["---", '"@pithy-sh/core": minor', "---", "", "A feature that is not a security fix."].join("\n");

describe("release records", () => {
  let fixture: ReturnType<typeof repo>;

  beforeEach(() => {
    fixture = repo();
  });

  afterEach(() => {
    fixture.dispose();
  });

  /** Snapshot, version, build — the release job's ordering, which is the whole point of the dance. */
  async function releaseCycle(env: Record<string, string> = {}) {
    const snapshot = await run(["snapshot"], { root: fixture.root, env });
    fixture.version("auth", "@pithy-sh/auth", "1.4.2");
    fixture.version("core", "@pithy-sh/core", "1.5.0");
    const build = await run(["build"], { root: fixture.root, env });
    return { snapshot, build };
  }

  it("carries a flagged changeset through to a record with its exposure", async () => {
    fixture.changeset("flagged", FLAGGED);
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.1" });
    fixture.pkg("core", { name: "@pithy-sh/core", version: "1.4.1" });

    await releaseCycle();

    const auth = fixture.records().find((record) => record.package === "@pithy-sh/auth");
    expect(auth?.security).toBe(true);
    expect(auth?.exposure).toBe("A revoked refresh token stayed valid until its natural expiry.");
    expect(auth?.note).toBe("Refresh-token reuse now revokes the whole family.");
  });

  it("leaves an unflagged changeset carrying no flag", async () => {
    fixture.changeset("plain", PLAIN);
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.1" });
    fixture.pkg("core", { name: "@pithy-sh/core", version: "1.4.1" });

    await releaseCycle();

    const core = fixture.records().find((record) => record.package === "@pithy-sh/core");
    expect(core?.security).toBe(false);
    expect(core?.exposure).toBeNull();
  });

  it("emits components that rebuild the published version string", async () => {
    fixture.changeset("flagged", FLAGGED);
    fixture.changeset("plain", PLAIN);
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.1" });
    fixture.pkg("core", { name: "@pithy-sh/core", version: "1.4.1" });

    await releaseCycle();

    for (const record of fixture.records()) {
      expect(`${record.major}.${record.minor}.${record.patch}`).toBe(record.version);
    }
  });

  it("refuses to build without a snapshot taken first", async () => {
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.1" });

    const result = await run(["build"], { root: fixture.root, env: {} });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/snapshot/i);
  });

  it("reports a release that changed nothing", async () => {
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.1" });

    await run(["snapshot"], { root: fixture.root, env: {} });
    const build = await run(["build"], { root: fixture.root, env: {} });

    expect(build.code).toBe(0);
    expect(fixture.records()).toEqual([]);
  });
});

describe("post", () => {
  let fixture: ReturnType<typeof repo>;

  beforeEach(() => {
    fixture = repo();
    fixture.changeset("flagged", FLAGGED);
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.1" });
  });

  afterEach(() => {
    fixture.dispose();
  });

  async function build() {
    await run(["snapshot"], { root: fixture.root, env: {} });
    fixture.version("auth", "@pithy-sh/auth", "1.4.2");
    await run(["build"], { root: fixture.root, env: {} });
  }

  // The dashboard is not up. This is the state the pipeline ships in, and it is a pass.
  it("says the dashboard is off and succeeds when nothing is configured", async () => {
    await build();

    const result = await run(["post"], { root: fixture.root, env: {} });

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/off/i);
  });

  it("posts when an endpoint is configured", async () => {
    await build();
    const send = vi.fn(async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;

    const result = await run(["post"], {
      root: fixture.root,
      env: { PITHY_RELEASE_RECORDS_URL: "https://dashboard.pithy.sh/api", PITHY_RELEASE_RECORDS_TOKEN: "t" },
      fetch: send,
    });

    expect(result.code).toBe(0);
    expect(send).toHaveBeenCalledOnce();
  });

  // The one property the release depends on: a dashboard problem is never a release problem.
  it("does not fail the release when the write fails", async () => {
    await build();
    const send = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await run(["post"], {
      root: fixture.root,
      env: { PITHY_RELEASE_RECORDS_URL: "https://dashboard.pithy.sh/api", PITHY_RELEASE_RECORDS_TOKEN: "t" },
      fetch: send,
    });

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/ECONNREFUSED/);
  });
});

describe("replay", () => {
  let fixture: ReturnType<typeof repo>;

  beforeEach(() => {
    fixture = repo();
  });

  afterEach(() => {
    fixture.dispose();
  });

  const CHANGELOG = [
    "# @pithy-sh/auth",
    "",
    "## 1.4.2",
    "",
    "### Patch Changes",
    "",
    "- [#471](url) [`abc`](url) Thanks [@kingmesal](url)! - Refresh-token reuse now revokes the whole family.",
    "",
    "  Security: a revoked refresh token stayed valid until its natural expiry.",
    "",
    "## 1.4.1",
    "",
    "### Patch Changes",
    "",
    "- An older fix, from before the convention.",
  ].join("\n");

  const dates = async (tag: string) =>
    tag === "@pithy-sh/auth@1.4.2" ? "2026-08-14T09:12:00.000Z" : "2026-07-01T00:00:00.000Z";

  it("rebuilds a record from the changelog, exposure and all", async () => {
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.2" });
    fixture.changelog("auth", CHANGELOG);

    const result = await run(["replay"], { root: fixture.root, env: {}, tagDate: dates });

    expect(result.code).toBe(0);
    const records = fixture.records();
    const latest = records.find((record) => record.version === "1.4.2");
    expect(latest?.security).toBe(true);
    expect(latest?.exposure).toBe("A revoked refresh token stayed valid until its natural expiry.");
    expect(latest?.published).toBe("2026-08-14T09:12:00.000Z");
  });

  // #92: do not backfill. A release cut before the convention carries no flag — and the record says
  // "not flagged", which the dashboard must render as *unknown*, never as *safe*.
  it("leaves a release predating the convention with no flag rather than a safe one", async () => {
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.2" });
    fixture.changelog("auth", CHANGELOG);

    await run(["replay"], { root: fixture.root, env: {}, tagDate: dates });

    const older = fixture.records().find((record) => record.version === "1.4.1");
    expect(older?.security).toBe(false);
    expect(older?.exposure).toBeNull();
  });

  // The recovery property: whatever the live write would have sent, replay reproduces.
  it("reproduces the record the live path would have posted", async () => {
    fixture.changeset("flagged", FLAGGED);
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.1" });
    await run(["snapshot"], { root: fixture.root, env: {} });
    fixture.version("auth", "@pithy-sh/auth", "1.4.2");
    await run(["build"], { root: fixture.root, env: {} });
    const live = fixture.records().find((record) => record.version === "1.4.2");

    fixture.changelog("auth", CHANGELOG);
    await run(["replay"], { root: fixture.root, env: {}, tagDate: dates });
    const replayed = fixture.records().find((record) => record.version === "1.4.2");

    expect(replayed).toEqual({ ...live, published: replayed?.published });
    expect(replayed?.note).toBe(live?.note);
    expect(replayed?.exposure).toBe(live?.exposure);
    expect(replayed?.security).toBe(live?.security);
  });

  it("narrows to one package when asked", async () => {
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.2" });
    fixture.changelog("auth", CHANGELOG);
    fixture.pkg("core", { name: "@pithy-sh/core", version: "1.0.0" });
    fixture.changelog("core", "# @pithy-sh/core\n\n## 1.0.0\n\n### Minor Changes\n\n- A note.\n");

    await run(["replay", "--package", "@pithy-sh/core"], { root: fixture.root, env: {}, tagDate: dates });

    expect(fixture.records().map((record) => record.package)).toEqual(["@pithy-sh/core"]);
  });

  // A CHANGELOG says what shipped, never when. Guessing a date would put a wrong one in a store that
  // is keyed on package and version, where the replay could never correct it.
  it("skips a release whose tag cannot date it, and says which", async () => {
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.2" });
    fixture.changelog("auth", CHANGELOG);

    const result = await run(["replay"], { root: fixture.root, env: {}, tagDate: async () => null });

    expect(result.code).toBe(0);
    expect(fixture.records()).toEqual([]);
    expect(result.output).toMatch(/@pithy-sh\/auth@1\.4\.2/);
  });

  // `VERSION_HEADING` accepts headings `splitVersion` refuses — `## 01.2.3`, say. Unhandled, one
  // hand-edited changelog took down the whole recovery command with a raw stack.
  it("skips a version it cannot read, and says which, rather than throwing", async () => {
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.2" });
    fixture.changelog(
      "auth",
      ["# @pithy-sh/auth", "", "## 01.2.3", "", "### Patch Changes", "", "- A note."].join("\n"),
    );

    const result = await run(["replay"], { root: fixture.root, env: {}, tagDate: dates });

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/01\.2\.3/);
    expect(fixture.records()).toEqual([]);
  });

  it("skips a package that has no changelog yet", async () => {
    fixture.pkg("auth", { name: "@pithy-sh/auth", version: "1.4.2" });

    const result = await run(["replay"], { root: fixture.root, env: {}, tagDate: dates });

    expect(result.code).toBe(0);
    expect(fixture.records()).toEqual([]);
  });
});

describe("run", () => {
  it("refuses a command it does not have", async () => {
    const result = await run(["frobnicate"], { root: process.cwd(), env: {} });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/frobnicate/);
  });

  it("names its commands when given none", async () => {
    const result = await run([], { root: process.cwd(), env: {} });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/snapshot/);
    expect(result.output).toMatch(/replay/);
  });
});
