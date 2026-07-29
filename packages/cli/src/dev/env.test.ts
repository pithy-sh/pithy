import { describe, expect, test } from "vitest";
import type { DevConfig } from "../feature/devConfig";
import { execArgs } from "../project/packageManager";
import type { WorkerTarget } from "../project/workers";
import { buildWorkerEnv, envStem, startCommand } from "./env";

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
  test("uppercases and collapses non-alphanumerics", () => {
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

describe("startCommand", () => {
  const launch: (args: string[]) => { command: string; args: string[] } = (args) => execArgs("bun", "wrangler", args);

  test("a wrangler worker runs `wrangler dev --port <port> --inspector-port 0 --persist-to <store>`", () => {
    const worker: WorkerTarget = {
      name: "api",
      dir: "/p/apps/api",
      hasWrangler: true,
      dev: { autostart: true, readySignal: "Ready on https?://" },
    };
    expect(startCommand(worker, 8787, launch, "/p/.wrangler/state")).toEqual({
      command: "bun",
      args: ["x", "wrangler", "dev", "--port", "8787", "--inspector-port", "0", "--persist-to", "/p/.wrangler/state"],
    });
  });

  test("every wrangler worker points at the SAME store, so a shared binding really is shared", () => {
    // Each worker runs in its own apps/<name>/, where wrangler would create a private .wrangler/. Two
    // workers that declare the same binding (how workers share a database) must not end up on two D1s.
    const api: WorkerTarget = { name: "api", dir: "/p/apps/api", hasWrangler: true };
    const collab: WorkerTarget = { name: "collab", dir: "/p/apps/collab", hasWrangler: true };
    const store = "/p/.wrangler/state";

    const persistArgs = (worker: WorkerTarget, port: number) => {
      const { args } = startCommand(worker, port, launch, store);
      return args.slice(args.indexOf("--persist-to"));
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
    expect(startCommand(worker, 5173, launch, "/p/.wrangler/state")).toEqual({ command: "vite", args: ["--host"] });
  });
});
