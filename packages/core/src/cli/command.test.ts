// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  answeredBy,
  callerOf,
  cliAtVersion,
  commandAlternatives,
  commandFaults,
  commandFlag,
  commandName,
  commandNameOf,
  commandNameOfPath,
  commandSequence,
  consequencesOf,
  isCommandPath,
  personDecision,
  pithyCommand,
  pithyCommandOf,
  remedy,
  rerunCommand,
  rerunRemedy,
  settledBy,
  viaPackageManager,
  type WorkerDir,
  workerDirOf,
} from "./command";
import { COMMANDS } from "./commandCatalog.generated";
import {
  CONFIRMATIONS,
  DESTRUCTIVE_COMMANDS,
  DESTRUCTIVE_FLAGS,
  EVERY_ENVIRONMENT_ALWAYS,
  EVERY_ENVIRONMENT_WITHOUT_ENV,
  MEANING_ONLY_WITH,
  NOT_DESTRUCTIVE,
  PERSON_ONLY,
  PRODUCTION_CONFIRMS,
  REQUIRED_BESIDE,
  WORKER_NARROWS,
  WORKER_SCOPED,
} from "./commandFacts";

const api = workerDirOf({ dir: "/project/apps/api" });

describe("workerDirOf", () => {
  test("names a Worker by its directory, whatever its deployed name", () => {
    expect(workerDirOf({ dir: "/project/apps/api" })).toBe("api");
    expect(workerDirOf({ dir: "C:\\project\\apps\\web\\" })).toBe("web");
  });

  test("refuses a directory with no name", () => {
    expect(() => workerDirOf({ dir: "/" })).toThrow(/has a name/);
  });
});

describe("pithyCommand", () => {
  test("spells arguments, then flags in the order the line writes them", () => {
    expect(pithyCommand("doctor")).toBe("pithy doctor");
    expect(pithyCommand("email provision", { flags: { "--worker": api } })).toBe("pithy email provision --worker api");
    expect(pithyCommand("secrets update", { args: ["SIGNING_KEY"], flags: { "--env": "staging" } })).toBe(
      "pithy secrets update SIGNING_KEY --env staging",
    );
    expect(pithyCommand("provision", { flags: { "--env": "staging", "--yes": true } })).toBe(
      "pithy provision --env staging --yes",
    );
  });

  test("repeats a repeatable flag, and quotes a value a shell would split", () => {
    expect(pithyCommandOf("add", { args: ["payments"], flags: { "--worker": api, "--set": ["a=b", "c=d e"] } })).toBe(
      "pithy add payments --worker api --set a=b --set 'c=d e'",
    );
  });

  test("names the environment a per-environment command would otherwise default", () => {
    expect(() => pithyCommandOf("vector provision", { flags: { "--worker": api } })).toThrow(/acts on dev/);
    expect(() => pithyCommandOf("migrate")).toThrow(/acts on dev/);
    expect(pithyCommand("migrate", { flags: { "--env": "dev" } })).toBe("pithy migrate --env dev");
    // An --env that decides nothing until another flag asks it to.
    expect(pithyCommand("upgrade")).toBe("pithy upgrade");
    expect(() => pithyCommandOf("upgrade", { flags: { "--migrate": true } })).toThrow(/acts on dev/);
  });

  test("names the Worker a command acting on one is refused without", () => {
    expect(() => pithyCommandOf("email provision")).toThrow(/names none/);
    expect(pithyCommandOf("add", { flags: { "--list": true } })).toBe("pithy add --list");
  });

  test("refuses what does not exist", () => {
    expect(() => pithyCommandOf("frobnicate")).toThrow(/not a command/);
    expect(() => pithyCommandOf("secrets")).toThrow(/a group/);
    expect(() => pithyCommandOf("worker list", { flags: { "--env": "staging" } })).toThrow(/has no --env/);
  });

  test("refuses a credential written into a line", () => {
    expect(() =>
      pithyCommandOf("media provision", { flags: { "--worker": api, "--r2-secret-access-key": "s3cret" } }),
    ).toThrow(/carries a credential/);
  });

  // A choice from a fixed set is the program's to spell, so it is checked. A placeholder is a fault of spelling,
  // which the gate reads (`commandFaults` with `spelled`); a value handed to the builder is a caller's.
  test("refuses a value outside a fixed set, and leaves a placeholder to the gate that reads spellings", () => {
    expect(() =>
      pithyCommandOf("secrets rm", { args: ["KEY"], flags: { "--env": "dev", "--backend": "disk" } }),
    ).toThrow(/takes d1, cf-secrets-store, not disk/);
    expect(commandFaults("email provision", { flags: { "--worker": "<name>" } }, { spelled: true }).join(" ")).toMatch(
      /nobody can run/,
    );
    expect(commandFaults("worker add", { args: [""] }, { spelled: true }).join(" ")).toMatch(/nobody can run/);
    expect(commandFaults("email provision", { flags: { "--worker": "<name>" } })).toEqual([]);
  });

  test("refuses a missing argument, and a rule over several flags", () => {
    expect(() => pithyCommandOf("worker add")).toThrow(/needs its name argument/);
    expect(() => pithyCommandOf("provision", { flags: { "--yes": true } })).toThrow(/exactly one of --env, --feature/);
    expect(() => pithyCommandOf("deploy", { flags: { "--force": true } })).toThrow(/--force` needs --env/);
  });

  test("refuses a provision for an environment without the --yes it is refused for", () => {
    expect(() => pithyCommand("provision", { flags: { "--env": "staging" } })).toThrow(/without --yes/);
    expect(pithyCommand("provision", { flags: { "--env": "staging", "--dry-run": true } })).toBe(
      "pithy provision --env staging --dry-run",
    );
  });

  // Whether `provision --env <x>` is a person's decision turns on the value, so a builder that takes a value names
  // none: the line is `remedy`'s, which decides by it. Refused for every value, so no environment is a surprise.
  test("names no --env on a command a production run makes a person's decision, whatever its value", () => {
    for (const env of ["staging", "prod", "live"]) {
      expect(() => pithyCommandOf("provision", { flags: { "--env": env, "--yes": true } })).toThrow(
        /an environment it read through remedy/,
      );
    }
    expect(pithyCommandOf("provision", { flags: { "--feature": true } })).toBe("pithy provision --feature");
  });

  test("refuses every command and flag that destroys something, and every confirmation", () => {
    expect(() => pithyCommandOf("feature destroy")).toThrow(/person's decision/);
    expect(() => pithyCommandOf("migrate", { flags: { "--env": "dev", "--rollback": true, "--group": "g" } })).toThrow(
      /person's decision/,
    );
    expect(() =>
      pithyCommandOf("vector reset", { flags: { "--env": "dev", "--worker": api, "--confirm-reset": "yes" } }),
    ).toThrow(/only a person gives/);
  });
});

/**
 * **A value a caller supplied is quoted, never read as a placeholder (#711).** `pithy add email --set 'fromName=Acme
 * <hi@acme.io>'` is a valid run, and the builder that named it again read `<hi@acme.io>` as a placeholder and turned it
 * into `core/internal`. A value handed to a builder is data: it is shell-quoted as it is.
 */
describe("a value a caller supplied", () => {
  test("is quoted as it is, whatever it holds", () => {
    expect(
      pithyCommandOf("add", {
        args: ["email"],
        flags: { "--worker": api, "--set": ["fromName=Acme <hi@acme.io>", "subject=$(id)"] },
      }),
    ).toBe("pithy add email --worker api --set 'fromName=Acme <hi@acme.io>' --set 'subject=$(id)'");
    expect(pithyCommand("secrets update", { args: ["<x>"] })).toBe("pithy secrets update '<x>'");
    expect(pithyCommandOf("worker add", { args: [""] })).toBe("pithy worker add ''");
    expect(pithyCommandOf("worker add", { args: ["  "] })).toBe("pithy worker add '  '");
    expect(pithyCommand("secrets update", { args: ["it's"] })).toBe(`pithy secrets update 'it'\\''s'`);
  });

  test("in a remedy, a decision, and a run again", () => {
    expect(remedy("secrets update", { args: ["<name>"] }).fix).toBe("pithy secrets update '<name>'");
    expect(personDecision("secrets rm", { args: ["<name>"] })).toMatch(/^`pithy secrets rm '<name>'` deletes/);
    expect(
      rerunCommand(callerOf("add", { set: ["fromName=Acme <hi@acme.io>"], worker: "<w>" }), { args: ["email"] }),
    ).toBe("pithy add email --worker '<w>' --set 'fromName=Acme <hi@acme.io>'");
    const given = { "routing-zone": " ", "inbound-address": "Acme <in@acme.io>", "app-worker": "api" };
    expect(rerunRemedy(callerOf("email provision", given), { flags: { "--worker": api } }).fix).toBe(
      "pithy email provision --routing-zone ' ' --inbound-address 'Acme <in@acme.io>' --app-worker api --worker api",
    );
  });

  // A run again is the caller's own command: its parser has had its say, and the line hands back what it was given.
  test("in a run again, even outside a fixed set", () => {
    expect(rerunCommand(callerOf("email test", { to: "a@b.co", template: "nope" }))).toBe(
      "pithy email test --to a@b.co --template nope",
    );
  });
});

describe("personDecision", () => {
  test("names the command, what it does, and that a person decides, with no confirmation phrase", () => {
    expect(personDecision("feature destroy", {})).toBe(
      "`pithy feature destroy` deletes the feature's worktree, its branch and every resource it provisioned. That is a person's decision, not a fix.",
    );
    expect(personDecision("vector reset", { flags: { "--worker": api, "--env": "staging" } })).toBe(
      "`pithy vector reset --worker api --env staging` with its --confirm-reset phrase, which only a person gives, deletes every vector in the index. That is a person's decision, not a fix.",
    );
    expect(remedy("provision", { flags: { "--env": "prod", "--yes": true } }).say((command) => command)).toBe(
      "`pithy provision --env prod --yes` with its --confirm phrase, which only a person gives, runs against prod, a production environment. That is a person's decision, not a fix.",
    );
  });

  test("asks no confirmation of an environment the command trusts", () => {
    expect(personDecision("vector reset", { flags: { "--worker": api, "--env": "dev" } })).toBe(
      "`pithy vector reset --worker api --env dev` deletes every vector in the index. That is a person's decision, not a fix.",
    );
  });

  test("names no confirmation a production run of the command does not ask for", () => {
    const said = (path: string) => remedy(path, { flags: { "--worker": api, "--env": "prod" } }).say((one) => one);
    expect(said("vector provision")).toBe(
      "`pithy vector provision --worker api --env prod` runs against prod, a production environment. That is a person's decision, not a fix.",
    );
    expect(said("testers provision")).not.toMatch(/--confirm/);
  });

  test("still refuses what does not run, and what destroys nothing", () => {
    expect(() => personDecision("vector reset", { flags: { "--worker": api } })).toThrow(/acts on dev/);
    // @ts-expect-error -- `doctor` destroys nothing
    expect(() => personDecision("doctor", {})).toThrow(/destroys nothing/);
    expect(() => personDecision("seed", { flags: { "--env": "dev" } })).toThrow(/destroys nothing/);
    expect(personDecision("seed", { flags: { "--env": "dev", "--redo": true } })).toMatch(
      /deletes the data a seed wrote/,
    );
  });
});

describe("remedy", () => {
  test("a command a remedy may name is the fix, and the sentence wraps it", () => {
    const one = remedy("provision", { flags: { "--env": "staging", "--yes": true } });
    expect(one.fix).toBe("pithy provision --env staging --yes");
    expect(one.say((command) => `Run ${command}.`)).toBe("Run pithy provision --env staging --yes.");
  });

  test("a person's decision has no fix, and says so in place of the sentence", () => {
    const one = remedy(
      "provision",
      { flags: { "--env": "live", "--yes": true } },
      { productionEnvironments: ["live"] },
    );
    expect(one.fix).toBeUndefined();
    expect(one.say((command) => `Run ${command}.`)).toMatch(
      /^`pithy provision --env live --yes` with its --confirm .* not a fix\.$/,
    );
  });

  test("a command that does not run is refused either way", () => {
    expect(() => remedy("feature destroy", { flags: { "--nope": "x" } })).toThrow(/has no --nope/);
    expect(() => remedy("vector provision", {})).toThrow(/acts on dev/);
  });
});

describe("rerunCommand", () => {
  test("carries every flag the run was given, and the Worker it resolved", () => {
    const given = {
      "routing-zone": "example.com",
      "inbound-address": "in@example.com",
      "app-worker": "api",
      json: true,
    };
    expect(rerunCommand(callerOf("email provision", given), { flags: { "--worker": api } })).toBe(
      "pithy email provision --json --routing-zone example.com --inbound-address in@example.com --app-worker api --worker api",
    );
  });

  test("carries a defaulted --env, which names the environment, but not another default", () => {
    expect(rerunCommand(callerOf("email test", { to: "a@b.co", template: "welcome", json: false }))).toBe(
      "pithy email test --to a@b.co",
    );
    expect(rerunCommand(callerOf("migrate", { env: "dev" }))).toBe("pithy migrate --env dev");
  });

  // `pithy upgrade` migrates nothing without --migrate, so its default --env changes nothing until --migrate asks.
  test("carries a defaulted --env only where the command reads it", () => {
    expect(rerunCommand(callerOf("upgrade", { env: "dev", migrate: false }))).toBe("pithy upgrade");
    expect(rerunCommand(callerOf("upgrade", { env: "dev", migrate: true }))).toBe("pithy upgrade --env dev --migrate");
    expect(rerunCommand(callerOf("upgrade", { env: "staging" }))).toBe("pithy upgrade --env staging");
  });

  test("carries every value of a repeatable flag, and never a confirmation", () => {
    expect(rerunCommand(callerOf("add", { set: ["a=b", "c=d"], worker: "api" }), { args: ["payments"] })).toBe(
      "pithy add payments --worker api --set a=b --set c=d",
    );
    // @ts-expect-error -- a command that destroys something is never a rerun's
    expect(() => rerunCommand(callerOf("vector reset", { env: "dev", worker: "api", "confirm-reset": "yes" }))).toThrow(
      /rerunRemedy/,
    );
  });
});

describe("rerunRemedy", () => {
  test("names the run in code, as a fix", () => {
    const rerun = rerunRemedy(callerOf("email provision", { json: true }), { flags: { "--worker": api } });
    expect(rerun.fix).toBe("pithy email provision --json --worker api");
    expect(rerun.say((line) => `run ${line} again`)).toBe("run `pithy email provision --json --worker api` again");
  });

  // A key in an action line reaches logs and scrollback; the line names the flag and leaves the value.
  test("never repeats a credential, and says which to pass again", () => {
    const given = { "r2-access-key-id": "AKIA", "r2-secret-access-key": "s3cret" };
    const line = rerunRemedy(callerOf("media provision", given), { flags: { "--worker": api } }).say((one) => one);
    expect(line).toBe(
      "`pithy media provision --worker api` with the --r2-access-key-id and --r2-secret-access-key this run was given",
    );
    expect(line).not.toContain("s3cret");
  });

  // `pithy testers provision --env prod` provisions, then names itself to run again: a production run, which is a
  // person's decision, said as one rather than thrown after the work is done.
  test("a production run again is a person's decision, with no fix", () => {
    const rerun = rerunRemedy(callerOf("testers provision", { env: "prod", json: true }), {
      flags: { "--worker": api },
    });
    expect(rerun.fix).toBeUndefined();
    expect(rerun.say((line) => `run ${line} again`)).toBe(
      "`pithy testers provision --json --env prod --worker api` runs against prod, a production environment. That is a person's decision, not a fix.",
    );
  });

  test("a project's own production environment is one too", () => {
    const rerun = rerunRemedy(callerOf("testers provision", { env: "live" }), {
      flags: { "--worker": api },
      productionEnvironments: ["live"],
    });
    expect(rerun.fix).toBeUndefined();
  });
});

/**
 * **A builder used at run time never throws on a production consequence (#711).** The environment is data a run
 * reads — a deployed Worker's `ENVIRONMENT`, a caller's `--env` — so a builder that refused a production one turned
 * a run that worked into `core/internal`. Each entry point that takes an environment at run time is run here with
 * every production name, against every command a production run makes a person's decision.
 */
describe("a builder used at run time never throws on a production consequence", () => {
  const productionPaths = Object.keys(PRODUCTION_CONFIRMS);
  // A command with no `--env` — `secrets provision`, which runs against every environment — is given none.
  const flagsFor = (path: string, env: string) => ({
    ...(commandFlag(path, "--env") === undefined ? {} : { "--env": env }),
    ...(commandFlag(path, "--yes") === undefined ? {} : { "--yes": true as const }),
    ...(commandFlag(path, "--worker") === undefined ? {} : { "--worker": api }),
  });

  for (const env of ["prod", "production"]) {
    for (const path of productionPaths) {
      test(`remedy, at run time, for ${path} --env ${env}`, () => {
        const one = remedy(path, { flags: flagsFor(path, env) }, { runtime: true });
        expect(one.fix).toBeUndefined();
        expect(one.say((command) => command)).toContain("a person's decision");
      });

      test(`rerunRemedy, for ${path} --env ${env}`, () => {
        const worker = commandFlag(path, "--worker") === undefined ? {} : { flags: { "--worker": api } };
        const one = rerunRemedy(callerOf(path as keyof typeof PRODUCTION_CONFIRMS, { env, yes: true }), worker);
        expect(one.fix).toBeUndefined();
        expect(one.say((command) => command)).toContain("a person's decision");
      });

      // A production run alone is a decision only by its value, so `personDecision` takes none, for any value.
      test(`personDecision refuses ${path} --env ${env}, which destroys nothing, as it refuses staging`, () => {
        for (const one of [env, "staging"]) {
          expect(() => personDecision(path as never, { flags: flagsFor(path, one) }, { runtime: true })).toThrow(
            /destroys nothing/,
          );
        }
      });
    }
  }

  // A runtime command carries no --env: the environment is data, and a line that names one goes through `remedy`,
  // which says a production one as a person's decision. Refused for every value, so no environment is a surprise.
  test("pithyCommandOf at run time takes no --env, whatever its value", () => {
    for (const env of ["staging", "prod"]) {
      expect(() =>
        // @ts-expect-error -- a runtime command names no environment
        pithyCommandOf("dashboard connect", { flags: { "--env": env } }, { runtime: true }),
      ).toThrow(/an environment it read through remedy/);
    }
  });

  // `rerunCommand` hands back a `Command`, which cannot be a person's decision, so it takes no command a production
  // run makes one of. The run again of one of those is `rerunRemedy`'s.
  test("rerunCommand takes no command whose production run is a person's decision", () => {
    const caller = callerOf("testers provision", { env: "staging" });
    // @ts-expect-error -- testers provision is in PRODUCTION_CONFIRMS
    expect(() => rerunCommand(caller, { flags: { "--worker": api } })).toThrow(/rerunRemedy/);
  });
});

describe("the words around a command", () => {
  test("alternatives and sequences, each in code", () => {
    expect(commandAlternatives(["pithy a", "pithy b", "pithy c"])).toBe("`pithy a`, `pithy b` or `pithy c`");
    expect(commandSequence(["pithy a", "pithy b"])).toBe("`pithy a` and `pithy b`");
    expect(commandName("add")).toBe("pithy add");
    expect(commandNameOf("vector provision")).toBe("pithy vector provision");
    expect(commandNameOf("secrets")).toBe("pithy secrets");
    expect(() => commandNameOf("rating provision")).toThrow(/not a command/);
  });

  // A parser's path, word by word: empty is the root, which is the CLI itself rather than a command.
  test("a path as the parser walked it, the root named as the CLI", () => {
    expect(commandNameOfPath([])).toBe("pithy");
    expect(commandNameOfPath(["token", "mint"])).toBe("pithy token mint");
    expect(commandNameOfPath(["token"])).toBe("pithy token");
    expect(() => commandNameOfPath(["frobnicate"])).toThrow(/not a command/);
  });
});

// A release of the CLI is not a command: the line says which, and the gate reads nothing interpolated after
// `pithy` as anything but a command.
describe("cliAtVersion", () => {
  test("names the CLI at a version", () => {
    expect(cliAtVersion("0.9.5")).toBe("pithy 0.9.5");
  });
});

describe("viaPackageManager", () => {
  // The project's own installed CLI, never a global `pithy`, through each manager's "run a local bin".
  test("runs a built command through each package manager's own exec", () => {
    const upgrade = pithyCommand("upgrade");
    expect(viaPackageManager("bun", upgrade)).toBe("bun x pithy upgrade");
    expect(viaPackageManager("pnpm", upgrade)).toBe("pnpm exec pithy upgrade");
    expect(viaPackageManager("yarn", upgrade)).toBe("yarn pithy upgrade");
    expect(viaPackageManager("npm", upgrade)).toBe("npx pithy upgrade");
  });

  test("carries the command's flags as built", () => {
    expect(viaPackageManager("bun", pithyCommand("upgrade", { flags: { "--worker": api } }))).toBe(
      "bun x pithy upgrade --worker api",
    );
  });
});

describe("the facts hold against the catalog", () => {
  const paths = Object.keys(COMMANDS);
  const flagsOf = (path: string) => Object.keys((COMMANDS as Record<string, { flags: object }>)[path]?.flags ?? {});

  test("every command a fact names exists", () => {
    const named = [
      ...WORKER_SCOPED,
      ...WORKER_NARROWS,
      ...PERSON_ONLY,
      ...Object.keys(DESTRUCTIVE_COMMANDS),
      ...Object.keys(NOT_DESTRUCTIVE),
      ...Object.keys(PRODUCTION_CONFIRMS),
      ...CONFIRMATIONS.map((one) => one.path),
      ...REQUIRED_BESIDE.map((one) => one.path),
      ...Object.keys(MEANING_ONLY_WITH),
    ];
    expect(named.filter((path) => !isCommandPath(path))).toEqual([]);
    for (const [path, flag] of Object.entries(MEANING_ONLY_WITH)) expect(flagsOf(path)).toContain(flag);
  });

  test("every command that takes --worker is classified, once", () => {
    const classified = [...WORKER_SCOPED, ...WORKER_NARROWS, ...PERSON_ONLY];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(paths.filter((path) => flagsOf(path).includes("--worker")).sort());
  });

  /**
   * **Every command that reads as destructive is decided (#711).** Its last word, or a flag it declares, says it
   * deletes something; it is in {@link DESTRUCTIVE_COMMANDS}, or {@link NOT_DESTRUCTIVE} says why not, or every flag
   * that makes it destructive is in {@link DESTRUCTIVE_FLAGS}. So a new `deprovision` cannot arrive as a remedy.
   */
  test("every command that reads as destructive is classified", () => {
    const verbs = /\b(?:deprovision|destroy|disconnect|prune|remove|reset|revoke|revoke-key|rm|close|delete)$/;
    const flagged = /^--(?:destroy-retained|drop|rollback|redo|confirm-[a-z-]+)$/;
    const unclassified = paths.filter((path) => {
      if (Object.hasOwn(DESTRUCTIVE_COMMANDS, path) || Object.hasOwn(NOT_DESTRUCTIVE, path)) return false;
      const flags = flagsOf(path).filter((flag) => flagged.test(flag) && !flag.startsWith("--confirm"));
      if (flags.some((flag) => !Object.hasOwn(DESTRUCTIVE_FLAGS, flag))) return true;
      return verbs.test(path);
    });
    expect(unclassified).toEqual([]);
  });

  test("every destructive command and flag is refused as a remedy", () => {
    for (const path of Object.keys(DESTRUCTIVE_COMMANDS)) {
      expect(commandFaults(path, { args: ["x"], flags: { "--env": "dev", "--worker": api } }).join(" ")).toMatch(
        /person's decision/,
      );
    }
    for (const path of paths) {
      for (const flag of flagsOf(path).filter((one) => Object.hasOwn(DESTRUCTIVE_FLAGS, one))) {
        expect(commandFaults(path, { flags: { [flag]: "x" } }).join(" ")).toMatch(/person's decision/);
      }
    }
  });

  test("every confirmation a command asks for is a flag it declares", () => {
    for (const one of CONFIRMATIONS) expect(flagsOf(one.path)).toContain(one.flag);
    for (const [path, flag] of Object.entries(PRODUCTION_CONFIRMS)) {
      if (flag !== null) expect(flagsOf(path)).toContain(flag);
    }
  });

  test("the compiler refuses what the builder refuses, for a literal path", () => {
    // @ts-expect-error No such command.
    expect(() => pithyCommand("frobnicate")).toThrow();
    // @ts-expect-error It acts on one Worker, and names none.
    expect(() => pithyCommand("email provision")).toThrow();
    // @ts-expect-error `--env` would default to dev.
    expect(() => pithyCommand("vector provision", { flags: { "--worker": api } })).toThrow();
    // @ts-expect-error It destroys something.
    expect(() => pithyCommand("feature destroy")).toThrow();
    // @ts-expect-error `secrets provision` takes no --env.
    expect(() => pithyCommand("secrets provision", { flags: { "--env": "dev" } })).toThrow();
    // @ts-expect-error `--worker` takes a WorkerDir, never a deployed name.
    expect(() => pithyCommand("ui sync", { flags: { "--worker": "acme-api" } })).not.toThrow();
    // @ts-expect-error `--rollback` destroys what a group applied.
    expect(() => pithyCommand("migrate", { flags: { "--env": "dev", "--rollback": true, "--group": "g" } })).toThrow();
    // @ts-expect-error `--client` takes one of its fixed set.
    expect(() => pithyCommand("docs connect", { flags: { "--client": "emacs" } })).toThrow(/not emacs/);
    const read: string = "prod";
    // @ts-expect-error A production run's --env is a quiet literal, or the line is remedy's.
    expect(() => pithyCommand("provision", { flags: { "--env": read, "--yes": true } })).toThrow(/production/);
    expect(pithyCommand("seed", { flags: { "--env": "dev" } })).toBe("pithy seed --env dev");
  });

  test("a WorkerDir is only what workerDirOf makes", () => {
    const dir: WorkerDir = workerDirOf({ dir: "/p/apps/web" });
    // @ts-expect-error A deployed name is a string, and a string is not a WorkerDir.
    const wrong: WorkerDir = "acme-web";
    expect([dir, wrong]).toEqual(["web", "acme-web"]);
  });
});

/**
 * **One caller context, the only input a rerun is built from (#711).** Every run again a line names was rebuilt at
 * its own site from the flags that site happened to hold, and each review round found one more that dropped what
 * the caller gave: `--json`, `--worker`, `--dry-run`, a `--set`, an option the Worker's config already answers. So
 * a rerun builder takes a {@link Caller}, which only {@link callerOf} makes, from a run's own parsed arguments.
 */
describe("the caller's own run", () => {
  test("carries the run's --set values, by key, and every flag", () => {
    const caller = callerOf("add", { capability: "payments", json: true, worker: "api" }, { set: ["a=b", "c=d"] });
    expect(caller.set).toEqual({ a: "b", c: "d" });
    expect(rerunCommand(caller, { args: ["payments"] })).toBe(
      "pithy add payments --worker api --set a=b --set c=d --json",
    );
  });

  test("reads --set from the parsed arguments when the run passes no raw list", () => {
    expect(callerOf("add", { set: ["k=v"] }).set).toEqual({ k: "v" });
    expect(callerOf("add", { set: "k=v" }).set).toEqual({ k: "v" });
  });

  test("settles what the run answered, and remembers what the config answers", () => {
    const caller = answeredBy(settledBy(callerOf("add", {}, { set: ["a=b"] }), { c: "d" }), ["billingSubject"]);
    expect(caller.set).toEqual({ a: "b", c: "d" });
    expect([...caller.answered]).toEqual(["billingSubject"]);
  });

  test("a rerun builder takes nothing but a caller", () => {
    // @ts-expect-error -- loose flags are not a caller
    expect(() => rerunCommand("email provision", { json: true })).toThrow();
    // @ts-expect-error -- nor here
    expect(() => rerunRemedy("email provision", { json: true })).toThrow();
  });
});

/**
 * **A command that acts on every environment when `--env` is left off touches production (#711).** `pithy testers
 * provision` with no `--env` provisions every declared environment, production included, so the bare command is a
 * person's decision exactly as `--env prod` is. It was offered as the runnable fix for one undeclinable binding.
 */
describe("a command that acts on every environment without --env", () => {
  test("is a production consequence", () => {
    expect(consequencesOf("testers provision", { flags: { "--worker": api } })).toEqual([
      "runs against every environment, production included",
    ]);
    expect(consequencesOf("testers provision", { flags: { "--worker": api, "--env": "staging" } })).toEqual([]);
  });

  test("is said as a person's decision, with no fix", () => {
    const one = remedy("testers provision", { flags: { "--worker": api } });
    expect(one.fix).toBeUndefined();
    expect(one.say((line) => line)).toBe(
      "`pithy testers provision --worker api` runs against every environment, production included. That is a person's decision, not a fix.",
    );
    const again = rerunRemedy(callerOf("testers provision", { json: true }), { flags: { "--worker": api } });
    expect(again.fix).toBeUndefined();
  });

  test("every such command declares --env with no default", () => {
    for (const path of EVERY_ENVIRONMENT_WITHOUT_ENV) {
      expect(commandFlag(path, "--env")).toBeDefined();
      expect(commandFlag(path, "--env")?.default).toBeUndefined();
      expect(Object.keys(PRODUCTION_CONFIRMS)).toContain(path);
    }
  });
});

/**
 * **A command with no `--env` that acts on every environment on every run touches production (#711).** `pithy secrets
 * provision` deploys each declared environment's manager and mints its store entries, production included, and has no
 * flag to narrow it. It was offered as the runnable fix for one staging binding, one database and one setting.
 */
describe("a command that acts on every environment always", () => {
  test("is a production consequence", () => {
    expect(consequencesOf("secrets provision")).toEqual(["runs against every environment, production included"]);
  });

  test("is said as a person's decision, with no fix", () => {
    const one = remedy("secrets provision");
    expect(one.fix).toBeUndefined();
    expect(one.say((line) => line)).toBe(
      "`pithy secrets provision` runs against every environment, production included. That is a person's decision, not a fix.",
    );
  });

  test("is refused as a command, at compile time and at run time", () => {
    // @ts-expect-error -- a line never builds it as a command; remedy says it as a person's decision.
    expect(() => pithyCommand("secrets provision")).toThrow(/a person's decision/);
    expect(() => pithyCommandOf("secrets provision")).toThrow(/a person's decision/);
  });

  test("every such command declares no --env, and is a production path", () => {
    for (const path of EVERY_ENVIRONMENT_ALWAYS) {
      expect(commandFlag(path, "--env")).toBeUndefined();
      expect(Object.keys(PRODUCTION_CONFIRMS)).toContain(path);
    }
  });
});
