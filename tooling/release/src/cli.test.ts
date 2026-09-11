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

/** The two ingest endpoints, which differ in origin — which is what makes their audiences differ. */
const STAGING_URL = "https://staging.dashboard.pithy.sh/api/releases";
const PROD_URL = "https://dashboard.pithy.sh/api/releases";

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

  /** Both dashboards configured, and no secret between them — what `release.yml` passes the step. */
  const BOTH = {
    PITHY_RELEASE_RECORDS_URL_STAGING: STAGING_URL,
    PITHY_RELEASE_RECORDS_URL_PROD: PROD_URL,
  };

  /** A minter that names the audience it was asked for, standing in for the runner's endpoint. */
  const mintToken = async (audience: string) => `token-for-${audience}`;

  // The dashboard is not up. This is the state the pipeline ships in, and it is a pass.
  it("says the dashboard is off and succeeds when nothing is configured", async () => {
    await build();

    const result = await run(["post"], { root: fixture.root, env: {} });

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/off/i);
  });

  it("posts to both destinations when both are configured", async () => {
    await build();
    const send = vi.fn(async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;

    const result = await run(["post"], { root: fixture.root, env: BOTH, fetch: send, mintToken });

    expect(result.code).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.output).toMatch(/staging, prod/);
  });

  // The release stands — step 5 published long ago and `replay` recovers the record. But a destination
  // that *answered and refused* is not a green step: it exits non-zero under `continue-on-error: true`,
  // so GitHub renders a failed step under a green job instead of one line in a log nobody opens.
  it("exits non-zero when a destination answers and refuses", async () => {
    await build();
    const send = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const result = await run(["post"], { root: fixture.root, env: BOTH, fetch: send, mintToken });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/rejected the records: 500/);
    expect(result.output).toMatch(/replay/);
  });

  // The other half, and the reason the grade exists. Both dashboard origins were unresolvable for the
  // whole of the first pipeline's life, so the strict reading spent every release printing a red step
  // that the reader was supposed to ignore — which is how somebody learns to ignore the next one.
  it("stays green when nothing answered, and still says so", async () => {
    await build();
    const send = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await run(["post"], { root: fixture.root, env: BOTH, fetch: send, mintToken });

    expect(result.code).toBe(0);
    // Quiet is not silent: the same sentence, and an annotation GitHub renders on the run itself.
    expect(result.output).toMatch(/^::warning title=Release reporting::/);
    expect(result.output).toMatch(/ECONNREFUSED/);
    expect(result.output).toMatch(/replay/);
  });

  // A token that never arrived means the request was never made, so the dashboard's state is unknown
  // and nothing about it was learned. That is CI's own credential path — somebody's to fix, and red.
  it("exits non-zero when no token could be minted", async () => {
    await build();
    const send = vi.fn(async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;

    const result = await run(["post"], {
      root: fixture.root,
      env: BOTH,
      fetch: send,
      mintToken: async () => {
        throw new Error("no OIDC token endpoint");
      },
    });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/^::error title=Release reporting::/);
    expect(send).not.toHaveBeenCalled();
  });

  it("annotates a failure so the run list shows it, at the severity it graded", async () => {
    await build();
    const refused = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const result = await run(["post"], { root: fixture.root, env: BOTH, fetch: refused, mintToken });

    expect(result.output).toMatch(/^::error title=Release reporting::/);
  });

  it("writes the outcome to the step summary", async () => {
    await build();
    const summary = join(fixture.root, "summary.md");
    const send = vi.fn(async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;

    await run(["post"], {
      root: fixture.root,
      env: { ...BOTH, GITHUB_STEP_SUMMARY: summary },
      fetch: send,
      mintToken,
    });

    expect(readFileSync(summary, "utf8")).toMatch(/Release reporting: Posted 1 records to staging, prod\./);
  });

  // *Posted to prod, failed to staging* is a different thing from *failed*, and the exit code cannot
  // carry the difference. Collapsing them would lose the production record's own good news.
  it("renders a partial outcome as one, not as a failure", async () => {
    await build();
    const send = vi.fn(async (url: string) =>
      url === STAGING_URL ? Promise.reject(new Error("ECONNREFUSED")) : new Response("{}", { status: 202 }),
    ) as unknown as typeof fetch;

    const result = await run(["post"], { root: fixture.root, env: BOTH, fetch: send, mintToken });

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/Posted 1 records to prod\./);
    expect(result.output).toMatch(/Failed to staging: ECONNREFUSED\./);
  });

  // One blocking fault among several decides the verdict for all of them. The alternative reads as
  // *mostly fine* and is the state where a real refusal hides behind an origin that is merely not up.
  it("goes red when one destination refuses, however the other failed", async () => {
    await build();
    const send = vi.fn(async (url: string) =>
      url === STAGING_URL ? Promise.reject(new Error("ECONNREFUSED")) : new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch;

    const result = await run(["post"], { root: fixture.root, env: BOTH, fetch: send, mintToken });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/^::error title=Release reporting::/);
    expect(result.output).toMatch(/Failed to staging: ECONNREFUSED\./);
    expect(result.output).toMatch(/Failed to prod: rejected the records: 403/);
  });

  // Without this the first exercise of the OIDC path would be a real release. A dry run mints a real
  // token and gets a real answer — and writes no rows, because the versions it built were not published.
  it("posts a zero-record delivery to staging on a dry run", async () => {
    await build();
    const send = vi.fn(async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;

    const result = await run(["post", "--dry-run"], { root: fixture.root, env: BOTH, fetch: send, mintToken });

    expect(result.code).toBe(0);
    const posted = (send as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(posted).toHaveLength(1);
    expect(posted[0]?.[0]).toBe(STAGING_URL);
    expect(JSON.parse(posted[0]?.[1].body as string)).toEqual({ records: [] });
    expect(result.output).toMatch(/Dry run\./);
  });

  it("still fails visibly when the dry run's delivery is refused", async () => {
    await build();
    const send = vi.fn(async () => new Response("bad audience", { status: 401 })) as unknown as typeof fetch;

    const result = await run(["post", "--dry-run"], { root: fixture.root, env: BOTH, fetch: send, mintToken });

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/401/);
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
