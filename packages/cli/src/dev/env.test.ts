// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { envStem } from "@pithy-sh/core/src/env/stem";
import { WORKER_ORIGIN_VAR } from "@pithy-sh/core/src/worker/identity";
import { describe, expect, test } from "vitest";
import type { DevConfig } from "../feature/devConfig";
import { execArgs } from "../project/packageManager";
import type { WorkerTarget } from "../project/workers";
import { buildWorkerEnv, childEnvFor, ownOriginFor, startCommand } from "./env";

const config: DevConfig = {
  version: 1,
  branch: "feature/73-cli-commands",
  ports: { index: 0, base: 8787, size: 10 },
  workers: {
    api: { port: 8787, origin: "http://localhost:8787" },
    "media-cli": { port: 8788, origin: "http://localhost:8788" },
  },
};

describe("envStem", () => {
  test("is core's derivation — the CLI writes the var and the runtime reads it, so there is one rule", () => {
    // `<STEM>_ORIGIN` is a contract between this process and code inside the Worker: core's loopback
    // dispatcher looks the address up by the name written here. Kept as a case rather than deleted,
    // because what is being pinned is that this side still agrees with the reader.
    expect(envStem("api")).toBe("API");
    expect(envStem("media-cli")).toBe("MEDIA_CLI");
  });
});

describe("buildWorkerEnv", () => {
  test("injects <STEM>_PORT and <STEM>_ORIGIN for every worker, over the base env", () => {
    const env = buildWorkerEnv(config, { PATH: "/usr/bin" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.API_PORT).toBe("8787");
    expect(env.API_ORIGIN).toBe("http://localhost:8787");
    expect(env.MEDIA_CLI_PORT).toBe("8788");
    expect(env.MEDIA_CLI_ORIGIN).toBe("http://localhost:8788");
  });
});

describe("ownOriginFor and childEnvFor", () => {
  const hosts = new Set(["email"]);

  test("an app worker is its own origin; a capability host is not", () => {
    // One function, so a host cannot be exempt from the argv carrier and not from the environment one.
    // Its `BASE_URL` is the *app's* origin, written into its generated config by the CLI already.
    expect(ownOriginFor("api", "http://localhost:8807", hosts)).toBe("http://localhost:8807");
    expect(ownOriginFor("email", "http://localhost:8808", hosts)).toBeNull();
  });

  test("the child that owns an origin carries it; the one that does not is untouched", () => {
    const shared = { PATH: "/usr/bin", API_ORIGIN: "http://localhost:8807" };
    expect(childEnvFor(shared, "http://localhost:8807")).toEqual({
      PATH: "/usr/bin",
      API_ORIGIN: "http://localhost:8807",
      [WORKER_ORIGIN_VAR]: "http://localhost:8807",
    });
    // Identity, not a copy: a host gets exactly the shared table and nothing added.
    expect(childEnvFor(shared, null)).toBe(shared);
  });

  test("it is per child, which is why it cannot live in the shared table", () => {
    // `buildWorkerEnv` is built once for every child, because `<STEM>_ORIGIN` is the same table of
    // other people's addresses for everybody. "Where do I answer" is the one fact that differs.
    const shared = buildWorkerEnv(config, { PATH: "/usr/bin" });
    const api = childEnvFor(shared, "http://localhost:8807");
    const web = childEnvFor(shared, "http://localhost:8808");
    expect(api[WORKER_ORIGIN_VAR]).toBe("http://localhost:8807");
    expect(web[WORKER_ORIGIN_VAR]).toBe("http://localhost:8808");
    expect(shared[WORKER_ORIGIN_VAR]).toBeUndefined();
  });
});

describe("startCommand", () => {
  const launch: (args: string[]) => { command: string; args: string[] } = (args) => execArgs("bun", "wrangler", args);

  test("a wrangler worker runs `wrangler dev --port <port> --inspector-port 0 --persist-to <store>`", () => {
    const worker: WorkerTarget = {
      name: "api",
      dir: "/p/apps/api",
      hasWrangler: true,
      dev: { autostart: true, readySignal: "Ready on https?://" },
    };
    expect(startCommand(worker, 8787, "http://localhost:8787", launch, "/p/.wrangler/state", {})).toEqual({
      command: "bun",
      args: [
        "x",
        "wrangler",
        "dev",
        "--port",
        "8787",
        "--inspector-port",
        "0",
        "--persist-to",
        "/p/.wrangler/state",
        "--var",
        "BASE_URL:http://localhost:8787",
      ],
    });
  });

  describe("telling a Worker its own origin", () => {
    const api: WorkerTarget = { name: "api", dir: "/p/apps/api", hasWrangler: true };

    test("hands the Worker the origin this checkout was allocated, as BASE_URL", () => {
      // The value a Worker cannot work out for itself. `Host` is caller-controlled, so a Worker that
      // derived its own origin from a request would take it from whoever called; and a port is
      // allocated per checkout, so it cannot be written down either. `pithy dev` is the only party
      // that knows, and this is where it says so (#462).
      const { args } = startCommand(api, 8807, "http://localhost:8807", launch, "/p/state", {});
      expect(args.slice(-2)).toEqual(["--var", "BASE_URL:http://localhost:8807"]);
    });

    test("two checkouts are told two different origins", () => {
      // The property the defect did not have. `apps/board/wrangler.jsonc` stated one dev origin, so
      // every checkout on a machine claimed to answer at the first one's port — and a test that named
      // 8787 agreed with that literal and passed. Two allocations, asserted to differ, cannot.
      const first = startCommand(api, 8787, "http://localhost:8787", launch, "/p/state", {});
      const second = startCommand(api, 8807, "http://localhost:8807", launch, "/p/state", {});

      expect(first.args).toContain("BASE_URL:http://localhost:8787");
      expect(second.args).toContain("BASE_URL:http://localhost:8807");
      expect(first.args).not.toEqual(second.args);
    });

    test("the origin travels verbatim, never rebuilt from the port", () => {
      // `.dev.config.json` pins the origin beside the port, and the two are not the same fact: an
      // origin recomposed as `http://localhost:${port}` would be a second producer of a value the
      // config already holds, and would quietly disagree the day one of them is not localhost.
      const { args } = startCommand(api, 8787, "https://api.localhost.test:8787", launch, "/p/state", {});
      expect(args).toContain("BASE_URL:https://api.localhost.test:8787");
    });

    test("a capability host is handed none — its BASE_URL is the app's, and is already written", () => {
      // A host holds no public route: a verification link it mails has to arrive back at the app, so
      // `materializeHostConfigs` writes the *app's* origin into the host's generated config. A `--var`
      // here would override that with the host's own address and point every callback at the mailer.
      const email: WorkerTarget = { name: "email", dir: "/p/.wrangler/pithy/hosts/email", hasWrangler: true };
      const { args } = startCommand(email, 8797, null, launch, "/p/state", {});
      expect(args.filter((arg) => arg.startsWith("BASE_URL:"))).toEqual([]);
      expect(args).not.toContain("--var");
    });

    test("a custom dev command is untouched — it inherits the real environment already", () => {
      const web: WorkerTarget = {
        name: "web",
        dir: "/p/apps/web",
        hasWrangler: false,
        dev: { autostart: true, readySignal: "ready", command: ["vite", "--host"] },
      };
      expect(startCommand(web, 5173, "http://localhost:5173", launch, "/p/state", {})).toEqual({
        command: "vite",
        args: ["--host"],
      });
    });
  });

  describe("forwarding CI into the Worker", () => {
    const api: WorkerTarget = { name: "api", dir: "/p/apps/api", hasWrangler: true };

    test("a wrangler worker gets CI as a var, because the host env does not cross into workerd", () => {
      // `process.env` inside a Worker is that script's own vars and nothing else, so a capability that
      // refuses to register under CI cannot otherwise see the `CI=true` the runner set out here.
      const { args } = startCommand(api, 8787, "http://localhost:8787", launch, "/p/state", { CI: "true" });
      expect(args.slice(-2)).toEqual(["--var", "CI:true"]);
    });

    test("the value travels verbatim — any non-blank one is CI at both ends", () => {
      expect(startCommand(api, 8787, "http://localhost:8787", launch, "/p/state", { CI: "1" }).args.slice(-2)).toEqual([
        "--var",
        "CI:1",
      ]);
      expect(
        startCommand(api, 8787, "http://localhost:8787", launch, "/p/state", { CI: "buildkite" }).args.slice(-2),
      ).toEqual(["--var", "CI:buildkite"]);
    });

    test("off CI nothing is forwarded — an ordinary run's Worker env is unchanged", () => {
      // Asserted as "no CI var" rather than "no --var at all": every wrangler worker now carries its
      // own `BASE_URL` (#462), so the absence of the whole flag stopped being the question.
      const ciVars = (env: NodeJS.ProcessEnv) =>
        startCommand(api, 8787, "http://localhost:8787", launch, "/p/state", env).args.filter((arg) =>
          arg.startsWith("CI:"),
        );
      expect(ciVars({})).toEqual([]);
      expect(ciVars({ CI: "" })).toEqual([]);
      expect(ciVars({ CI: "  " })).toEqual([]);
    });

    test("a dev.command worker gets no --var — it inherits the real environment already", () => {
      const web: WorkerTarget = {
        name: "web",
        dir: "/p/apps/web",
        hasWrangler: false,
        dev: { autostart: true, readySignal: "ready", command: ["vite", "--host"] },
      };
      expect(startCommand(web, 5173, "http://localhost:5173", launch, "/p/state", { CI: "true" })).toEqual({
        command: "vite",
        args: ["--host"],
      });
    });
  });

  describe("forwarding a capability host's address into the Worker", () => {
    const api: WorkerTarget = { name: "api", dir: "/p/apps/api", hasWrangler: true };

    /**
     * `buildWorkerEnv` publishes `<STEM>_ORIGIN` into the child *process*, and a wrangler process is
     * not workerd. Inside the Worker `process.env` is that script's own vars and nothing else, so an
     * app Worker looking up `EMAIL_ORIGIN` — the address core's loopback dispatcher posts a Workflow
     * dispatch to — would find nothing. One `--var` per host is what carries it across.
     */
    test("a wrangler worker gets each host's origin and port as vars", () => {
      const { args } = startCommand(api, 8787, "http://localhost:8787", launch, "/p/state", {}, { email: 8797 });
      expect(args.slice(-4)).toEqual(["--var", "EMAIL_ORIGIN:http://localhost:8797", "--var", "EMAIL_PORT:8797"]);
    });

    test("a project with no capability host forwards nothing", () => {
      // A host var, specifically. The worker's own `BASE_URL` is not one — see #462.
      const args = startCommand(api, 8787, "http://localhost:8787", launch, "/p/state", {}, {}).args;
      expect(args.filter((arg) => arg.includes("_ORIGIN:") || arg.includes("_PORT:"))).toEqual([]);
    });

    test("a host does not forward its own address to itself", () => {
      // `EMAIL_ORIGIN` names a dispatch target, and a host posting to itself answers itself forever.
      // Its own `BASE_URL` is the opposite fact and is present — the two are held apart in #462.
      const email: WorkerTarget = { name: "email", dir: "/p/.wrangler/pithy/hosts/email", hasWrangler: true };
      const args = startCommand(email, 8797, null, launch, "/p/state", {}, { email: 8797 }).args;
      expect(args.filter((arg) => arg.startsWith("EMAIL_"))).toEqual([]);
    });

    test("a dev.command worker gets none — it already inherits the real environment", () => {
      const web: WorkerTarget = {
        name: "web",
        dir: "/p/apps/web",
        hasWrangler: false,
        dev: { autostart: true, readySignal: "ready", command: ["vite", "--host"] },
      };
      expect(startCommand(web, 5173, "http://localhost:5173", launch, "/p/state", {}, { email: 8797 }).args).toEqual([
        "--host",
      ]);
    });
  });

  test("every wrangler worker points at the SAME store, so a shared binding really is shared", () => {
    // Each worker runs in its own apps/<name>/, where wrangler would create a private .wrangler/. Two
    // workers that declare the same binding (how workers share a database) must not end up on two D1s.
    const api: WorkerTarget = { name: "api", dir: "/p/apps/api", hasWrangler: true };
    const collab: WorkerTarget = { name: "collab", dir: "/p/apps/collab", hasWrangler: true };
    const store = "/p/.wrangler/state";

    const persistArgs = (worker: WorkerTarget, port: number) => {
      const { args } = startCommand(worker, port, `http://localhost:${port}`, launch, store, {});
      // The flag and its value, not the tail: the worker's own `BASE_URL` follows it now (#462), and
      // reading to the end would make this case about that instead of about the store.
      const at = args.indexOf("--persist-to");
      return args.slice(at, at + 2);
    };

    expect(persistArgs(api, 8787)).toEqual(["--persist-to", store]);
    expect(persistArgs(collab, 8788)).toEqual(["--persist-to", store]);
  });

  test("a dev.command worker runs that command verbatim — no --port or --persist-to appended", () => {
    const worker: WorkerTarget = {
      name: "web",
      dir: "/p/apps/web",
      hasWrangler: false,
      dev: { autostart: true, readySignal: "ready in", command: ["vite", "--host"] },
    };
    expect(startCommand(worker, 5173, "http://localhost:5173", launch, "/p/.wrangler/state", {})).toEqual({
      command: "vite",
      args: ["--host"],
    });
  });

  test("{port} in a dev.command is replaced with the pinned port", () => {
    // spawn runs with no shell, so `$WEB_PORT` on an argv would be a literal. The token is how a dev
    // server that takes its port as a flag gets the port pithy assigned it.
    const worker: WorkerTarget = {
      name: "web",
      dir: "/p/apps/web",
      hasWrangler: true,
      dev: {
        autostart: true,
        readySignal: "ready in \\d+",
        command: ["bun", "x", "vite", "dev", "--strictPort", "--port", "{port}"],
      },
    };
    expect(startCommand(worker, 8790, "http://localhost:8790", launch, "/p/.wrangler/state", {})).toEqual({
      command: "bun",
      args: ["x", "vite", "dev", "--strictPort", "--port", "8790"],
    });
  });

  test("every occurrence substitutes, including one embedded in a larger argument", () => {
    const worker: WorkerTarget = {
      name: "web",
      dir: "/p/apps/web",
      hasWrangler: false,
      dev: {
        autostart: true,
        readySignal: "ready",
        command: ["serve", "--port={port}", "--origin=http://localhost:{port}/{port}"],
      },
    };
    expect(startCommand(worker, 5200, "http://localhost:5200", launch, "/p/.wrangler/state", {})).toEqual({
      command: "serve",
      args: ["--port=5200", "--origin=http://localhost:5200/5200"],
    });
  });

  test("the wrangler branch is untouched by the token — it never appears in a wrangler argv", () => {
    const worker: WorkerTarget = { name: "api", dir: "/p/apps/api", hasWrangler: true };
    const { args } = startCommand(worker, 8787, "http://localhost:8787", launch, "/p/.wrangler/state", {});
    expect(args).not.toContain("{port}");
    expect(args).toEqual([
      "x",
      "wrangler",
      "dev",
      "--port",
      "8787",
      "--inspector-port",
      "0",
      "--persist-to",
      "/p/.wrangler/state",
      "--var",
      "BASE_URL:http://localhost:8787",
    ]);
  });
});
