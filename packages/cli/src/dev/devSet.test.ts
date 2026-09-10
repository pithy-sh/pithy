// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, type PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import type { WorkerTarget } from "../project/workers";
import { dim } from "../terminal/style";
import { type DevSetMember, type DevSetOptions, resolveDevSet, selectDevMembers } from "./devSet";
import type { HostWorker } from "./hostWorkers";

/** `apps/api`, deployed as `acme-api`, autostarting because it says so. */
const api: WorkerTarget = {
  name: "acme-api",
  dir: "/proj/apps/api",
  hasWrangler: true,
  dev: { autostart: true, readySignal: "Ready on https?://" },
};

/** `apps/batch`, carrying no dev block at all — the target shape every test double uses. */
const batch: WorkerTarget = { name: "batch", dir: "/proj/apps/batch", hasWrangler: true };

/** `apps/web`, the opt-out. */
const web: WorkerTarget = {
  name: "web",
  dir: "/proj/apps/web",
  hasWrangler: false,
  dev: { autostart: false, readySignal: "ready in \\d+", command: ["vite", "--host"] },
};

/** The email capability's prebuilt host — registered under the capability name, as discovery does. */
const emailHost = {
  capability: "email",
  spec: { capability: "email" },
  sourceDir: "/proj/apps/api",
  worker: {
    name: "email",
    dir: "/proj/.wrangler/pithy/hosts/email",
    hasWrangler: true,
    dev: { autostart: true, readySignal: "Ready on https?://" },
  },
} as unknown as HostWorker;

function options(overrides: Partial<DevSetOptions> = {}): DevSetOptions {
  return {
    projectDir: "/proj",
    discoverWorkers: async () => [api, batch, web],
    projectName: async () => "acme",
    discoverHostWorkers: async () => ({ hosts: [emailHost], notes: [] }),
    ...overrides,
  };
}

/** The four members the fixture set resolves to, by name — apps in discovery order, then hosts. */
const names = (members: readonly DevSetMember[]): string[] => members.map((m) => m.worker.name);

describe("resolveDevSet", () => {
  test("is the apps/ Workers, then each composed capability's host, marked by kind", async () => {
    const set = await resolveDevSet(options());

    expect(names(set.members)).toEqual(["acme-api", "batch", "web", "email"]);
    expect(set.members.map((m) => m.kind)).toEqual(["app", "app", "app", "host"]);
    expect(set.hosts).toEqual([emailHost]);
    expect(set.hostNames).toEqual(new Set(["email"]));
    expect(set.project).toBe("acme");
  });

  test("autostart is the schema's answer, so a target with no dev block starts", async () => {
    const set = await resolveDevSet(options());

    expect(set.members.map((m) => [m.worker.name, m.autostart])).toEqual([
      ["acme-api", true],
      ["batch", true],
      ["web", false],
      ["email", true],
    ]);
  });

  // A guessed project name differs between checkouts and this one is stamped into a Worker script name,
  // so a project that states none gets no hosts and one line saying why — never hosts under a made-up name.
  test("a project with no name gets no hosts, and says so rather than guessing one", async () => {
    const findHosts = vi.fn();
    const set = await resolveDevSet(options({ projectName: async () => null, discoverHostWorkers: findHosts }));

    expect(findHosts).not.toHaveBeenCalled();
    expect(set.hosts).toEqual([]);
    expect(set.members.every((m) => m.kind === "app")).toBe(true);
    expect(set.notes).toEqual([
      "No project name in pithy.config.ts, so no capability host can be named — none will run.",
      dim('  set: export default { name: "<project>" }'),
    ]);
  });

  // Returned, not printed: `pithy dev` sends these to stderr under `--json` and to stdout otherwise, and
  // `pithy dev --list` sends them to stderr always. Neither decision belongs to the resolver.
  test("hands its notes back rather than emitting them", async () => {
    const set = await resolveDevSet(
      options({
        discoverHostWorkers: async () => ({ hosts: [], notes: ["api: its capabilities could not be read."] }),
      }),
    );

    expect(set.notes).toEqual(["api: its capabilities could not be read."]);
  });

  // The default seam, exercised for real: no `projectName` override, and a directory holding no root
  // config. `requireProjectName` throws, and the answer is `null` rather than a guessed name — a guess
  // differs between checkouts and this one is stamped into a Worker script name.
  test("resolves the project name itself when no seam is given, and answers null for a project without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-dev-set-"));
    try {
      const set = await resolveDevSet({ projectDir: dir, discoverWorkers: async () => [] });

      expect(set.project).toBeNull();
      expect(set.hosts).toEqual([]);
      expect(set.notes[0]).toContain("No project name in pithy.config.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("host discovery is asked about the discovered app Workers, and only those", async () => {
    const findHosts = vi.fn(async () => ({ hosts: [], notes: [] }));
    await resolveDevSet(options({ discoverHostWorkers: findHosts }));

    expect(findHosts).toHaveBeenCalledWith({ projectDir: "/proj", workers: [api, batch, web] });
  });
});

describe("selectDevMembers", () => {
  const members = async (): Promise<DevSetMember[]> => (await resolveDevSet(options())).members;

  test("names nothing, selects nothing — the caller decides what that means", async () => {
    expect(selectDevMembers(await members(), [])).toEqual([]);
  });

  test("accepts the deployed name", async () => {
    expect(names(selectDevMembers(await members(), ["acme-api"]))).toEqual(["acme-api"]);
  });

  test("accepts the apps/<dir> basename", async () => {
    expect(names(selectDevMembers(await members(), ["api"]))).toEqual(["acme-api"]);
  });

  test("accepts a capability name for a host", async () => {
    const selected = selectDevMembers(await members(), ["email"]);
    expect(names(selected)).toEqual(["email"]);
    expect(selected[0]?.kind).toBe("host");
  });

  // Literal, deliberately: naming a Worker is the more specific act, so nothing is pulled in beside it.
  test("is literal — naming an app Worker pulls in no capability host", async () => {
    expect(names(selectDevMembers(await members(), ["acme-api"]))).toEqual(["acme-api"]);
  });

  test("selects a Worker that opted out of autostart", async () => {
    expect(names(selectDevMembers(await members(), ["web"]))).toEqual(["web"]);
  });

  // Member order, not flag order: labels, colors, host ports and .dev-state.json all key on it.
  test("comes back in member order, whatever order the flags arrived in", async () => {
    expect(names(selectDevMembers(await members(), ["email", "api"]))).toEqual(["acme-api", "email"]);
  });

  test("naming one Worker twice, once each way, selects it once", async () => {
    expect(names(selectDevMembers(await members(), ["acme-api", "api"]))).toEqual(["acme-api"]);
  });

  /**
   * `discoverHostWorkers` refuses an `apps/` Worker whose *deployed* name is a capability's, but a
   * Worker in `apps/email/` deployed as `acme-email` clears that guard — and then `email` is the
   * host's name and that Worker's directory at once. The deployed name wins, because it is the key
   * `.dev.config.json`, `.dev-state.json` and `<STEM>_ORIGIN` are all written under.
   */
  describe("when one string could mean two members", () => {
    const appEmail: WorkerTarget = { name: "acme-email", dir: "/proj/apps/email", hasWrangler: true };
    const both = async (): Promise<DevSetMember[]> =>
      (await resolveDevSet(options({ discoverWorkers: async () => [appEmail] }))).members;

    test("the deployed name wins over another worker's directory", async () => {
      const selected = selectDevMembers(await both(), ["email"]);

      expect(names(selected)).toEqual(["email"]);
      expect(selected[0]?.kind).toBe("host");
    });

    test("and the other worker is still reachable by its own deployed name", async () => {
      expect(names(selectDevMembers(await both(), ["acme-email"]))).toEqual(["acme-email"]);
    });

    // Only genuinely irreducible ambiguity refuses: two workers deployed under one name, which is a
    // project already broken — `.dev.config.json` keys a port by that name, so they share one entry.
    test("two workers deployed under one name refuse, named by the directories that tell them apart", async () => {
      const one: WorkerTarget = { name: "acme-api", dir: "/proj/apps/api", hasWrangler: true };
      const two: WorkerTarget = { name: "acme-api", dir: "/proj/apps/legacy", hasWrangler: true };
      const members = (await resolveDevSet(options({ discoverWorkers: async () => [one, two] }))).members;

      try {
        selectDevMembers(members, ["acme-api"]);
        expect.unreachable("an irreducible ambiguity must refuse");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const { payload } = error as PithyError;
        expect(payload.message).toBe('"acme-api" names two workers.');
        expect(payload.action).toBe("Rename one of them: /proj/apps/api, /proj/apps/legacy.");
      }
    });
  });

  test("an unknown name refuses, naming the valid set", async () => {
    try {
      selectDevMembers(await members(), ["nope"]);
      expect.unreachable("an unknown name must refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      const { payload } = error as PithyError;
      expect(payload.code).toBe("core/not_found");
      expect(payload.message).toBe('No worker named "nope".');
      expect(payload.action).toBe(
        "Run pithy dev --list to see this project's dev set. Known: acme-api, batch, web, email.",
      );
    }
  });

  // Nothing partial comes back, so nothing half-starts and then dies.
  test("one unknown name among known ones refuses the whole selection", async () => {
    const all = await members();
    expect(() => selectDevMembers(all, ["api", "nope", "web"])).toThrow(NotFoundError);
    expect(() => selectDevMembers(all, ["api", "nope", "web"])).toThrow(/No worker named "nope"/);
  });

  test("an empty set renders its known list as none", () => {
    try {
      selectDevMembers([], ["x"]);
      expect.unreachable("an unknown name must refuse");
    } catch (error) {
      expect((error as PithyError).payload.action).toContain("Known: none.");
    }
  });
});
