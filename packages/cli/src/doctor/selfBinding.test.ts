// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkSelfBinding, describeSelfBinding } from "./selfBinding";

/**
 * The declaration and the stanza, held against each other (#616).
 *
 * The failure this check exists to name is a 522 at runtime — a Worker calling its own hostname, the
 * subrequest looping back through the edge, and Cloudflare timing it out — which reads to everyone
 * involved as somebody else's outage. It is established from the project's own two files: the root config
 * says the project administers itself, and the stanza it deploys from has no binding to do it with.
 */
describe("checkSelfBinding", () => {
  let dir: string;

  beforeEach(async () => {
    // In-package, not the OS tmpdir: `loadProject` imports the config live, and vitest can only transform
    // TypeScript under the project root.
    dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".smoke-self-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A project with one Worker, whose stanzas are whatever this test hands it. */
  async function project(
    declaration: string,
    stanzas: Record<string, Record<string, unknown>>,
    worker = "board",
  ): Promise<string> {
    const projectDir = join(dir, `p${Math.random().toString(36).slice(2)}`);
    const workerDir = join(projectDir, "apps", worker);
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(projectDir, "pithy.config.ts"), `export default { name: "replay"${declaration} };\n`);
    await writeFile(join(projectDir, "package.json"), '{ "name": "replay" }\n');
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      `${JSON.stringify({ name: `replay-${worker}`, env: stanzas }, null, 2)}\n`,
    );
    return projectDir;
  }

  const bound = { name: "replay-board-staging", services: [{ binding: "SELF", service: "replay-board-staging" }] };
  const unbound = { name: "replay-board-staging" };

  test("names every stanza a self-administering project has left without the binding", async () => {
    const check = await checkSelfBinding(
      await project(", administersItself: true", { staging: unbound, prod: { name: "replay-board-prod" } }),
    );

    expect(check.state).toBe("unbound");
    expect(check.missing).toEqual([
      { worker: "board", env: "staging", boundTo: null, deploysAs: "replay-board-staging" },
      { worker: "board", env: "prod", boundTo: null, deploysAs: "replay-board-prod" },
    ]);
  });

  test("says nothing about a project that stanza by stanza has it", async () => {
    const check = await checkSelfBinding(
      await project(", administersItself: true", {
        staging: bound,
        prod: { name: "replay-board-prod", services: [{ binding: "SELF", service: "replay-board-prod" }] },
      }),
    );

    expect(check).toEqual({ state: "ok", declared: true, missing: [] });
  });

  /** A project that declares nothing is not half-configured; it is a project that wants none of this. */
  test("a project that does not declare it is never asked about a binding", async () => {
    const check = await checkSelfBinding(await project("", { staging: unbound, prod: {} }));

    expect(check).toEqual({ state: "ok", declared: false, missing: [] });
  });

  /**
   * A stanza that is not there at all is `checkEnvironments`' finding, not this one. Two blocks reporting
   * one fault is how a report starts contradicting itself.
   */
  test("an environment with no stanza is left to the check that owns it", async () => {
    const check = await checkSelfBinding(await project(", administersItself: true", { staging: bound }));

    expect(check.missing).toEqual([]);
    expect(check.state).toBe("ok");
  });

  /** A capability's own service bindings are not this one: only the kit's constant answers. */
  test("a services array that binds something else is still unbound", async () => {
    const check = await checkSelfBinding(
      await project(", administersItself: true", {
        staging: { name: "replay-board-staging", services: [{ binding: "WEB", service: "replay-web-staging" }] },
      }),
    );

    expect(check.missing).toEqual([
      { worker: "board", env: "staging", boundTo: null, deploysAs: "replay-board-staging" },
    ]);
  });

  /**
   * **The target, not merely the name.** A binding that names a script this stanza does not deploy as is
   * the fault the writer composes `service` from `stanza.name` to prevent: it provisions clean, reports
   * success, and dispatches into another Worker — or nothing — at runtime. `pithy worker rename` and a
   * hand-edited `env.<name>.name` both produce it, so the reader has to establish it rather than assume
   * the writer was the last thing to touch the file.
   */
  test("a binding naming a script this stanza does not deploy as is not a binding", async () => {
    const check = await checkSelfBinding(
      await project(", administersItself: true", {
        // The name the stanza carried before somebody renamed the worker, left behind in `services`.
        staging: { name: "replay-staging-board", services: [{ binding: "SELF", service: "replay-board-staging" }] },
      }),
    );

    expect(check.state).toBe("unbound");
    expect(check.missing).toEqual([
      { worker: "board", env: "staging", boundTo: "replay-board-staging", deploysAs: "replay-staging-board" },
    ]);
  });

  /** An entry with no target at all binds nothing, however it is named. */
  test("a SELF entry naming no service is unbound", async () => {
    const check = await checkSelfBinding(
      await project(", administersItself: true", {
        staging: { name: "replay-board-staging", services: [{ binding: "SELF" }] },
      }),
    );

    expect(check.state).toBe("unbound");
    expect(check.missing).toEqual([
      { worker: "board", env: "staging", boundTo: null, deploysAs: "replay-board-staging" },
    ]);
  });

  /**
   * A stanza naming no script of its own deploys as wrangler's `<top-level>-<env>`, so that — not the
   * absence of a `name` key — is what the binding has to agree with.
   */
  test("a stanza that names no script is held to wrangler's own fallback", async () => {
    const agrees = await checkSelfBinding(
      await project(", administersItself: true", {
        staging: { services: [{ binding: "SELF", service: "replay-board-staging" }] },
      }),
    );
    expect(agrees).toEqual({ state: "ok", declared: true, missing: [] });

    const disagrees = await checkSelfBinding(
      await project(", administersItself: true", {
        staging: { services: [{ binding: "SELF", service: "replay-board" }] },
      }),
    );
    expect(disagrees.missing).toEqual([
      { worker: "board", env: "staging", boundTo: "replay-board", deploysAs: "replay-board-staging" },
    ]);
  });

  /** A diagnostic has to work in the broken project it exists to diagnose. */
  test("a project whose root config will not load establishes nothing", async () => {
    const projectDir = join(dir, "broken");
    await mkdir(projectDir, { recursive: true });

    expect(await checkSelfBinding(projectDir)).toEqual({ state: "could-not-check", declared: false, missing: [] });
  });

  test("the sentence names the remedy and the reason", () => {
    const sentence = describeSelfBinding({
      worker: "board",
      env: "staging",
      boundTo: null,
      deploysAs: "replay-board-staging",
    });
    expect(sentence).toContain("SELF");
    expect(sentence).toContain("staging");
  });

  /** Two faults, two sentences: an absent binding and a misdirected one want different remedies read. */
  test("a misdirected binding says what it names and what the stanza deploys as", () => {
    const sentence = describeSelfBinding({
      worker: "board",
      env: "staging",
      boundTo: "replay-board-staging",
      deploysAs: "replay-staging-board",
    });

    expect(sentence).toContain("replay-board-staging");
    expect(sentence).toContain("replay-staging-board");
  });
});
