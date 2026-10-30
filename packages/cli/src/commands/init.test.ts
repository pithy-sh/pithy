// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CfAccount } from "@pithy-sh/cloudflare/src/client/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type CloudflareConfigOptions, cloudflareEnv } from "../cloudflare/config";
import { AGENTS_FILE, CLAUDE_FILE, CLAUDE_POINTER, renderAgentsBlock } from "../project/agentInstructions";
import { latchInputMode } from "../terminal/inputMode";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import {
  askCloudflareAccount,
  askEnvironments,
  askLinter,
  askReactNative,
  askTarget,
  DEFAULT_TARGET,
  type InitPrompt,
  offerShell,
  parseTarget,
  renderCloudflareBlock,
  writeCloudflareBlock,
} from "./init";

/**
 * `pithy init` is the one moment the adopter is holding the token, so it is the one moment the account
 * can be *discovered* rather than asked for. Every case here drives the account listing and the
 * prompts through seams: the defaults reach Cloudflare with whatever token the operator's shell exports,
 * and a test that forgot would list their real accounts.
 */

let dir: string;

function paths(env: Record<string, string> = {}): CloudflareConfigOptions {
  return { env: { PITHY_CONFIG_DIR: dir, ...env }, account: null };
}

/** The prompts, scripted. Anything the script does not answer throws rather than guessing. */
function prompts(script: Partial<InitPrompt>): InitPrompt {
  const unexpected = (what: string) => () => {
    throw new Error(`init asked for ${what}, which this case did not expect`);
  };
  return {
    text: script.text ?? unexpected("text"),
    password: script.password ?? unexpected("a password"),
    select: script.select ?? unexpected("a selection"),
    confirm: script.confirm ?? unexpected("a confirmation"),
    isCancel: script.isCancel ?? ((value: unknown) => typeof value === "symbol"),
  };
}

function account(id: string, name: string): CfAccount {
  return { id, name };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-init-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("askCloudflareAccount", () => {
  test("one visible account is used, its own name is the default nickname, and one keypress confirms", async () => {
    const answer = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [account("a1b2c3", "Leed, Inc.")],
      prompt: prompts({
        password: async () => "cfat_token",
        // The nickname is offered, not invented: the default is the account's own name, slugified.
        text: async (options) => options.defaultValue ?? "",
        confirm: async () => true,
      }),
    });

    expect(answer.block).toEqual({ accountName: "leed-inc", accountId: "a1b2c3" });
    // The credentials landed in the file the block names, and nowhere else.
    expect(cloudflareEnv({ ...paths(), account: { accountName: "leed-inc" } })).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "a1b2c3",
      CLOUDFLARE_API_TOKEN: "cfat_token",
    });
    expect(cloudflareEnv(paths())).toEqual({});
    expect(answer.notes.join(" ")).toContain(join(dir, "cloudflare.leed-inc.json"));
    // Never the token, in any note. A token echoed into a terminal is a token in a scrollback.
    expect(answer.notes.join(" ")).not.toContain("cfat_token");
  });

  test("several visible accounts are a picker, and the choice supplies both the id and the name", async () => {
    const answer = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [account("a1", "Acme"), account("b2", "Leed, Inc.")],
      prompt: prompts({
        password: async () => "cfat_token",
        select: async (options) => {
          // Both accounts are on offer, each labeled with the id it will pin.
          expect(options.options).toHaveLength(2);
          expect(options.options.map((choice) => choice.label).join(" ")).toContain("b2");
          return options.options[1]?.value as string;
        },
        text: async (options) => options.defaultValue ?? "",
        confirm: async () => true,
      }),
    });

    expect(answer.block).toEqual({ accountName: "leed-inc", accountId: "b2" });
    expect(cloudflareEnv({ ...paths(), account: { accountName: "leed-inc" } }).CLOUDFLARE_ACCOUNT_ID).toBe("b2");
  });

  test("the account id written is the one read from the chosen account, never one typed twice", async () => {
    const typed: string[] = [];
    const answer = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [account("read-from-the-account", "Acme")],
      prompt: prompts({
        password: async () => "cfat_token",
        text: async (options) => {
          typed.push(options.message);
          return options.defaultValue ?? "";
        },
        confirm: async () => true,
      }),
    });
    expect(answer.block?.accountId).toBe("read-from-the-account");
    // Exactly one free-text question: the nickname. The id was never asked for.
    expect(typed.filter((message) => /account id/i.test(message))).toEqual([]);
  });

  test("a name that slugifies to empty prompts rather than guessing", async () => {
    const asked: string[] = [];
    const answer = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [account("a1", "。、！")],
      prompt: prompts({
        password: async () => "cfat_token",
        text: async (options) => {
          asked.push(options.defaultValue ?? "");
          return "leed";
        },
        confirm: async () => true,
      }),
    });
    // Nothing was offered as a default, because there was nothing defensible to offer.
    expect(asked).toEqual([""]);
    expect(answer.block).toEqual({ accountName: "leed", accountId: "a1" });
  });

  test("a slug is held to the same schema as a typed name, and a refusal re-asks", async () => {
    const offered: string[] = [];
    const answer = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [account("a1", "Acme")],
      prompt: prompts({
        password: async () => "cfat_token",
        text: async (options) => {
          offered.push(options.defaultValue ?? "");
          // A hand-typed traversal is refused exactly as a slugified one would be, then re-asked.
          return offered.length === 1 ? "../../etc/passwd" : "acme";
        },
        confirm: async () => true,
      }),
    });
    expect(answer.block?.accountName).toBe("acme");
    expect(answer.notes.join(" ")).toContain("bare token");
    // Nothing was written under the refused name.
    await expect(readFile(join(dir, "cloudflare.../../etc/passwd.json"), "utf8")).rejects.toThrow();
  });

  test("the pin is written by default and can be declined", async () => {
    const declined = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [account("a1", "Acme")],
      prompt: prompts({
        password: async () => "cfat_token",
        text: async (options) => options.defaultValue ?? "",
        confirm: async (options) => {
          // Offered as the default, so declining is the deliberate act rather than the accidental one.
          expect(options.initialValue).toBe(true);
          return false;
        },
      }),
    });
    expect(declined.block).toEqual({ accountName: "acme" });
    // The credentials are still written; only the pin was declined.
    expect(cloudflareEnv({ ...paths(), account: { accountName: "acme" } }).CLOUDFLARE_ACCOUNT_ID).toBe("a1");
  });

  test("a token that cannot list accounts falls back to asking, and init still completes", async () => {
    const answer = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => {
        throw new Error("Authentication error: this token cannot list accounts");
      },
      prompt: prompts({
        password: async () => "cfut_narrow",
        text: async () => "typed-account-id",
      }),
    });

    // No block: nothing discovered a name, and inventing one would be the guess this design removed.
    expect(answer.block).toBeNull();
    expect(cloudflareEnv(paths())).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "typed-account-id",
      CLOUDFLARE_API_TOKEN: "cfut_narrow",
    });
    expect(answer.notes.join(" ")).toContain(join(dir, "cloudflare.json"));
  });

  test("a token seeing no accounts at all falls back the same way", async () => {
    const answer = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [],
      prompt: prompts({ password: async () => "cfat_token", text: async () => "typed-account-id" }),
    });
    expect(answer.block).toBeNull();
    expect(cloudflareEnv(paths()).CLOUDFLARE_ACCOUNT_ID).toBe("typed-account-id");
  });

  test("non-interactive writes no cloudflare block and asks nothing — CI scaffolds with nobody to ask", async () => {
    const answer = await askCloudflareAccount({
      interactive: false,
      paths: paths(),
      listAccounts: async () => {
        throw new Error("a non-interactive init must not reach Cloudflare");
      },
      prompt: prompts({}),
    });
    expect(answer).toEqual({ block: null, notes: [], prompted: false });
    expect(cloudflareEnv(paths())).toEqual({});
  });

  test("credentials that already resolve for a single-account machine ask nothing, exactly as before", async () => {
    await writeFile(
      join(dir, "cloudflare.json"),
      JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "a1", CLOUDFLARE_API_TOKEN: "tok" }),
    );
    const answer = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [account("a1", "Acme")],
      prompt: prompts({}),
    });
    expect(answer).toEqual({ block: null, notes: [], prompted: false });
  });

  test("credentials that already resolve on a machine with several accounts do ask — that is the case", async () => {
    await writeFile(
      join(dir, "cloudflare.json"),
      JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "a1", CLOUDFLARE_API_TOKEN: "tok" }),
    );
    const answer = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [account("a1", "Acme"), account("b2", "Leed")],
      prompt: prompts({
        select: async (options) => options.options[1]?.value as string,
        text: async (options) => options.defaultValue ?? "",
        confirm: async () => true,
      }),
    });
    expect(answer.block).toEqual({ accountName: "leed", accountId: "b2" });
    // The already-resolving token is reused: nothing asks for a credential the machine already holds.
    expect(cloudflareEnv({ ...paths(), account: { accountName: "leed" } })).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "b2",
      CLOUDFLARE_API_TOKEN: "tok",
    });
  });

  test("two projects on one machine, two accounts, each resolving its own credentials", async () => {
    const first = await askCloudflareAccount({
      interactive: true,
      paths: paths(),
      listAccounts: async () => [account("leed-acct", "Leed, Inc.")],
      prompt: prompts({
        password: async () => "leed-token",
        text: async (options) => options.defaultValue ?? "",
        confirm: async () => true,
      }),
    });
    const second = await askCloudflareAccount({
      interactive: true,
      // A second token, for the other company — the machine now holds two accounts' credentials.
      paths: paths(),
      listAccounts: async () => [account("other-acct", "Other Co")],
      prompt: prompts({
        password: async () => "other-token",
        text: async (options) => options.defaultValue ?? "",
        confirm: async () => true,
      }),
    });

    expect(first.block).toEqual({ accountName: "leed-inc", accountId: "leed-acct" });
    expect(second.block).toEqual({ accountName: "other-co", accountId: "other-acct" });
    expect(cloudflareEnv({ ...paths(), account: first.block })).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "leed-acct",
      CLOUDFLARE_API_TOKEN: "leed-token",
    });
    expect(cloudflareEnv({ ...paths(), account: second.block })).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "other-acct",
      CLOUDFLARE_API_TOKEN: "other-token",
    });
  });
});

describe("writeCloudflareBlock", () => {
  const SCAFFOLD = 'const config = {\n  name: "replay",\n};\n\nexport default config;\n';

  test("writes the block into the scaffolded root config, where loadProject will read it", async () => {
    await writeFile(join(dir, "pithy.config.ts"), SCAFFOLD);
    const wrote = await writeCloudflareBlock(dir, { accountName: "leed", accountId: "a1" });
    expect(wrote.declared).toBe(true);
    const source = await readFile(join(dir, "pithy.config.ts"), "utf8");
    expect(source).toContain('accountName: "leed"');
    expect(source).toContain('accountId: "a1"');
    expect(source).toContain('name: "replay"');
  });

  test("a declined pin writes the name alone", async () => {
    await writeFile(join(dir, "pithy.config.ts"), SCAFFOLD);
    await writeCloudflareBlock(dir, { accountName: "leed" });
    const source = await readFile(join(dir, "pithy.config.ts"), "utf8");
    expect(source).toContain('accountName: "leed"');
    expect(source).not.toMatch(/accountId:/);
  });

  test("a config it cannot place the block in says so rather than losing it", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    expect((await writeCloudflareBlock(dir, { accountName: "leed" })).declared).toBe(false);
  });

  test("a name that is not a bare token never reaches the file", async () => {
    await writeFile(join(dir, "pithy.config.ts"), SCAFFOLD);
    await expect(writeCloudflareBlock(dir, { accountName: "../../etc/passwd" })).rejects.toThrow();
  });

  test("the rendered block is what an adopter would paste by hand", () => {
    expect(renderCloudflareBlock({ accountName: "leed", accountId: "a1" })).toContain('accountName: "leed"');
  });
});

/**
 * The environment question. `name` has been asked at `init` and capped since the beginning,
 * because it leads every Cloudflare name a project composes; the environment sits in the middle of the
 * same name, is measured against the same 33-character ceiling, and was asked about nowhere.
 */
describe("askEnvironments", () => {
  test("one keypress takes the default — staging and prod, nothing written", async () => {
    const answer = await askEnvironments({
      interactive: true,
      prompt: prompts({ text: async ({ defaultValue }) => defaultValue ?? "" }),
    });
    expect(answer.environments).toEqual(["staging", "prod"]);
    expect(answer.declared).toBe(false);
  });

  test("offers the default as the placeholder, so the common answer is visible", async () => {
    let offered: string | undefined;
    await askEnvironments({
      interactive: true,
      prompt: prompts({
        text: async ({ defaultValue, placeholder }) => {
          offered = placeholder;
          return defaultValue ?? "";
        },
      }),
    });
    expect(offered).toBe("staging, prod");
  });

  test("takes a custom set, comma-separated, and reports that it was declared", async () => {
    const answer = await askEnvironments({
      interactive: true,
      prompt: prompts({ text: async () => "staging, live" }),
    });
    expect(answer.environments).toEqual(["staging", "live"]);
    expect(answer.declared).toBe(true);
  });

  test("re-asks an illegal set rather than scaffolding a project that cannot deploy", async () => {
    const said: string[] = [];
    const answers = ["dev, prod", "staging, live"];
    const answer = await askEnvironments({
      interactive: true,
      prompt: prompts({ text: async () => answers.shift() ?? "" }),
      note: (line) => said.push(line),
    });
    expect(answer.environments).toEqual(["staging", "live"]);
    expect(said.join(" ")).toContain("dev");
  });

  test("asks nothing without a human, and takes the default — a CI scaffold is unchanged", async () => {
    const answer = await askEnvironments({ interactive: false });
    expect(answer.environments).toEqual(["staging", "prod"]);
    expect(answer.prompted).toBe(false);
    expect(answer.declared).toBe(false);
  });

  test("a canceled prompt keeps the default rather than proceeding on half an answer", async () => {
    const answer = await askEnvironments({
      interactive: true,
      prompt: prompts({ text: async () => Symbol("cancel") }),
    });
    expect(answer.environments).toEqual(["staging", "prod"]);
  });
});

/**
 * The origin point: a listing that could not happen is not a listing that came back empty.
 *
 * Both used to reach `askAccountIdOnly` as `[]`, and the id typed under either became the
 * `CLOUDFLARE_ACCOUNT_ID` every later command asks about — so every confidently-empty listing downstream
 * inherits its confidence from here. The two lines below are written out literally; neither is composed
 * from the module under test.
 */
describe("a listing that could not be made is not an empty listing", () => {
  /** Capture stdout for one call, so the sentence the operator reads can be asserted. */
  async function saying(run: () => Promise<unknown>): Promise<string> {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await run();
    } finally {
      process.stdout.write = original;
    }
    return written.join("");
  }

  test("a token that reached Cloudflare and saw nothing is told to widen the token", async () => {
    const said = await saying(() =>
      askCloudflareAccount({
        interactive: true,
        paths: paths(),
        listAccounts: async () => [],
        prompt: prompts({ password: async () => "cfat_token", text: async () => "typed-id" }),
      }),
    );
    expect(said).toContain("This token sees no Cloudflare account");
    expect(said).not.toContain("could not be reached");
  });

  test("a call that never landed says the account list is unknown, and that nothing verified the id", async () => {
    const said = await saying(() =>
      askCloudflareAccount({
        interactive: true,
        paths: paths(),
        listAccounts: async () => {
          throw new Error("ECONNREFUSED");
        },
        prompt: prompts({ password: async () => "cfat_token", text: async () => "typed-id" }),
      }),
    );
    expect(said).toContain("Cloudflare could not be reached, so the account list is unknown.");
    expect(said).toContain("verified by nothing");
    expect(said).not.toContain("This token sees no Cloudflare account");
  });
});

/** A real scaffold, through the real command, held to the schema `pithy schema init` publishes. */
test("pithy init --json conforms to its published payload", async () => {
  const target = await mkdtemp(join(tmpdir(), "pithy-init-json-"));
  try {
    await expectConforms("init", await runCaptured("init", ["--dir", target, "--name", "acme", "--json"]));
  } finally {
    vi.restoreAllMocks();
    await rm(target, { recursive: true, force: true });
  }
});

/**
 * The agent instructions: `init` writes the Pithy block into `AGENTS.md` and points `CLAUDE.md`
 * at it — creating each when the target has none, and merging into each when a cloned repository brought
 * its own. `project/agentInstructions.test.ts` holds the merge itself; these hold the command to calling it.
 */
describe("pithy init — agent instructions", () => {
  test("a fresh target gets AGENTS.md with the block and a CLAUDE.md pointing at it, and --json says so", async () => {
    const target = join(dir, "fresh");
    const written = await runCaptured("init", ["--dir", target, "--name", "acme", "--json"]);
    const payload = JSON.parse(written.join("")) as Record<string, unknown>;
    expect(payload.agents).toEqual({ path: AGENTS_FILE, state: "added", reason: null });
    expect(payload.claude).toEqual({ path: CLAUDE_FILE, state: "added", reason: null });
    expect(await readFile(join(target, AGENTS_FILE), "utf8")).toBe(`${renderAgentsBlock()}\n`);
    expect(await readFile(join(target, CLAUDE_FILE), "utf8")).toBe(`${CLAUDE_POINTER}\n`);
  });

  test("a cloned repo's own AGENTS.md and CLAUDE.md keep every byte, and gain the block and the line", async () => {
    const target = join(dir, "cloned");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, AGENTS_FILE), "# Agents\n\nRun the tests.\n");
    await writeFile(join(target, CLAUDE_FILE), "# Rules\n\nNo emoji.\n");
    await runCaptured("init", ["--dir", target, "--name", "acme", "--json"]);
    expect(await readFile(join(target, AGENTS_FILE), "utf8")).toBe(
      `# Agents\n\nRun the tests.\n\n${renderAgentsBlock()}\n`,
    );
    expect(await readFile(join(target, CLAUDE_FILE), "utf8")).toBe(`# Rules\n\nNo emoji.\n\n${CLAUDE_POINTER}\n`);
  });

  test("a person reads one line per file, before Done.", async () => {
    const target = join(dir, "spoken");
    const written = (await runCaptured("init", ["--dir", target, "--name", "acme"])).join("");
    const lines = written.split("\n");
    const done = lines.indexOf("Done.");
    expect(done).toBeGreaterThan(-1);
    expect(lines.indexOf("AGENTS.md: Pithy block added.")).toBeGreaterThan(-1);
    expect(lines.indexOf("AGENTS.md: Pithy block added.")).toBeLessThan(done);
    expect(lines.indexOf("CLAUDE.md: points at AGENTS.md.")).toBeLessThan(done);
    expect(lines.indexOf("CLAUDE.md: points at AGENTS.md.")).toBeGreaterThan(-1);
  });
});

/**
 * The app target. `mobile` is the API alone and is what `init` scaffolded before it asked, so a
 * run that passes no flag is unchanged; `web` and `both` add a React front end to the first Worker.
 */
describe("the app target", () => {
  test("asks which clients call the backend, and takes the answer", async () => {
    const select = vi.fn(async () => "web");
    expect(await askTarget({ interactive: true, prompt: prompts({ select }) })).toEqual({
      value: "web",
      prompted: true,
    });
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Which clients call this backend?" }));
  });

  test("asks nothing without a human, and takes the default the scaffold always had", async () => {
    expect(DEFAULT_TARGET).toBe("mobile");
    expect(await askTarget({ interactive: false, prompt: prompts({}) })).toEqual({ value: "mobile", prompted: false });
  });

  test("a canceled question aborts rather than scaffolding on half an answer", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    await expect(
      askTarget({ interactive: true, prompt: prompts({ select: async () => Symbol("cancel") }) }),
    ).rejects.toThrow("exited");
    exit.mockRestore();
  });

  test("--target takes the three targets and refuses anything else, naming them", () => {
    expect(parseTarget("both")).toBe("both");
    expect(() => parseTarget("desktop")).toThrow('"desktop" is not a target.');
  });

  test("--target web scaffolds the React front end into the first Worker, and --json says what it made", async () => {
    const target = join(dir, "web");
    const written = await runCaptured("init", ["--dir", target, "--name", "acme", "--target", "web", "--json"]);
    const payload = JSON.parse(written.join("")) as {
      target: string;
      frontEnd: { framework: string; created: string[] };
    };
    expect(payload.target).toBe("web");
    expect(payload.frontEnd.framework).toBe("react");
    expect(payload.frontEnd.created).toContain("src/client.tsx");
    expect(await readFile(join(target, "apps", "api", "src", "client.tsx"), "utf8")).not.toBe("");
  });

  test("no flag is the mobile target: no front end, exactly the scaffold init always wrote", async () => {
    const target = join(dir, "api-only");
    const written = await runCaptured("init", ["--dir", target, "--name", "acme", "--json"]);
    const payload = JSON.parse(written.join("")) as { target: string; frontEnd: unknown };
    expect(payload.target).toBe("mobile");
    expect(payload.frontEnd).toBeNull();
    await expect(readFile(join(target, "apps", "api", "src", "client.tsx"), "utf8")).rejects.toThrow();
  });
});

/** The React Native offer: made to a mobile or both target, and never taken without a yes. */
/** Which linter runs the kit's lint safeguards. `biome` is what `init` scaffolded before it asked. */
describe("the linter", () => {
  test("offers both linters, and takes the answer", async () => {
    const select = vi.fn(async (options: { options: { value: string }[] }) => {
      expect(options.options.map((option) => option.value)).toEqual(["biome", "oxlint"]);
      return "oxlint";
    });
    expect(await askLinter({ interactive: true, prompt: prompts({ select }) })).toEqual({
      value: "oxlint",
      prompted: true,
    });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Which linter runs the kit's lint rules?" }),
    );
  });

  test("asks nothing without a human, and takes Biome", async () => {
    expect(await askLinter({ interactive: false, prompt: prompts({}) })).toEqual({ value: "biome", prompted: false });
  });

  test("a canceled question aborts rather than scaffolding on half an answer", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    await expect(
      askLinter({ interactive: true, prompt: prompts({ select: async () => Symbol("cancel") }) }),
    ).rejects.toThrow("exited");
    exit.mockRestore();
  });

  test("--lint oxlint writes the Oxlint plugin and its config, and --json says which linter", async () => {
    const target = join(dir, "oxlint");
    const written = await runCaptured("init", ["--dir", target, "--name", "acme", "--lint", "oxlint", "--json"]);
    await expectConforms("init", written);
    expect(JSON.parse(written.join(""))).toMatchObject({ lint: "oxlint" });
    expect(await readFile(join(target, ".oxlintrc.json"), "utf8")).toContain("./plugins/pithy.oxlint.js");
    await expect(readFile(join(target, "plugins", "no-console.grit"), "utf8")).rejects.toThrow();
  });

  test("no flag is Biome, with all six Grit rules", async () => {
    const target = join(dir, "biome");
    const written = await runCaptured("init", ["--dir", target, "--name", "acme", "--json"]);
    expect(JSON.parse(written.join(""))).toMatchObject({ lint: "biome" });
    expect(await readFile(join(target, "plugins", "no-raw-use-effect.grit"), "utf8")).toContain("useEffect");
    await expect(readFile(join(target, ".oxlintrc.json"), "utf8")).rejects.toThrow();
  });

  test("an unknown --lint is refused before anything is scaffolded", async () => {
    const target = join(dir, "eslint");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    await runCaptured("init", ["--dir", target, "--name", "acme", "--lint", "eslint", "--json"]).catch(() => undefined);
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });
});

describe("the React Native offer", () => {
  test("asks a mobile or both target, defaulting to no, and takes the answer", async () => {
    for (const target of ["mobile", "both"] as const) {
      const confirm = vi.fn(async () => true);
      expect(await askReactNative({ target, interactive: true, prompt: prompts({ confirm }) })).toEqual({
        value: true,
        prompted: true,
      });
      expect(confirm).toHaveBeenCalledWith({
        message: "Add a React Native app for iOS, Android and the web?",
        initialValue: false,
      });
    }
  });

  test("never asks a web target, and never asks without a human", async () => {
    expect(await askReactNative({ target: "web", interactive: true, prompt: prompts({}) })).toEqual({
      value: false,
      prompted: false,
    });
    expect(await askReactNative({ target: "mobile", interactive: false, prompt: prompts({}) })).toEqual({
      value: false,
      prompted: false,
    });
  });

  test("a flag decides without a question", async () => {
    expect(await askReactNative({ target: "both", flagged: true, interactive: true, prompt: prompts({}) })).toEqual({
      value: true,
      prompted: false,
    });
    expect(await askReactNative({ target: "mobile", flagged: false, interactive: true, prompt: prompts({}) })).toEqual({
      value: false,
      prompted: false,
    });
  });

  test("asking for the app on a web target is refused", async () => {
    await expect(askReactNative({ target: "web", flagged: true, interactive: false })).rejects.toThrow(
      "The React Native app is for a mobile client, and --target web has none.",
    );
  });

  test("a canceled question aborts", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    await expect(
      askReactNative({
        target: "mobile",
        interactive: true,
        prompt: prompts({ confirm: async () => Symbol("cancel") }),
      }),
    ).rejects.toThrow("exited");
    exit.mockRestore();
  });

  test("--react-native writes an Expo app beside the Worker, every rail none, and --json says what it made", async () => {
    const target = join(dir, "phone");
    const written = await runCaptured("init", ["--dir", target, "--name", "acme", "--react-native", "--json"]);
    const payload = JSON.parse(written.join("")) as {
      target: string;
      frontEnd: unknown;
      reactNative: { app: string; created: string[]; rails: Record<string, string> };
    };
    expect(payload.target).toBe("mobile");
    expect(payload.frontEnd).toBeNull();
    expect(payload.reactNative.app).toBe("app");
    expect(payload.reactNative.created).toContain("app.config.ts");
    expect(payload.reactNative.rails).toEqual({ ios: "none", android: "none", web: "none" });
    expect(await readFile(join(target, "apps", "app", "src", "pithy-config.generated.ts"), "utf8")).toContain(
      "from apps/api's composed config",
    );
    await expectConforms("init", written);
  });

  test("--target both with --app writes the web front end and the Expo app, each in its own directory", async () => {
    const target = join(dir, "both");
    const written = await runCaptured("init", [
      "--dir",
      target,
      "--name",
      "acme",
      "--target",
      "both",
      "--app",
      "phone",
      "--json",
    ]);
    const payload = JSON.parse(written.join("")) as { frontEnd: { framework: string }; reactNative: { app: string } };
    expect(payload.frontEnd.framework).toBe("react");
    expect(payload.reactNative.app).toBe("phone");
    expect(await readFile(join(target, "apps", "phone", "app.config.ts"), "utf8")).toContain('name: "phone"');
  });

  test("--target both --react-native says where each front end went, and the next step once", async () => {
    const target = join(dir, "text");
    const written = await runCaptured("init", [
      "--dir",
      target,
      "--name",
      "acme",
      "--target",
      "both",
      "--react-native",
      "--no-input",
    ]);
    const output = written.join("");
    expect(output).toContain("A React front end is in apps/api/.");
    expect(output).toContain("An Expo app is in apps/app/. It calls api.");
    expect(output.match(/Run pithy setup, then pithy dev\./g)).toHaveLength(1);
  });

  test("no flag and no human adds no app", async () => {
    const target = join(dir, "plain");
    const written = await runCaptured("init", ["--dir", target, "--name", "acme", "--json"]);
    expect((JSON.parse(written.join("")) as { reactNative: unknown }).reactNative).toBeNull();
    await expect(readFile(join(target, "apps", "app", "package.json"), "utf8")).rejects.toThrow();
  });

  /** Run `pithy init` expecting a refusal: the exit code it asked for, and what it wrote to stderr. */
  async function refused(args: string[]): Promise<{ code: unknown; stderr: string }> {
    const stderr: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    let code: unknown;
    const exit = vi.spyOn(process, "exit").mockImplementation((value) => {
      code = value;
      throw new Error("exited");
    });
    try {
      await runCaptured("init", args).catch(() => undefined);
    } finally {
      write.mockRestore();
      exit.mockRestore();
    }
    return { code, stderr: stderr.join("") };
  }

  test("a rail the new backend cannot enable is refused before anything is scaffolded", async () => {
    const target = join(dir, "refused");
    const { code, stderr } = await refused(["--dir", target, "--name", "acme", "--ios-rail", "apple", "--json"]);
    expect(code).toBe(3);
    expect(stderr).toContain("The apple rail needs the payments capability");
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("a rail value no platform takes is refused, listing the valid ones", async () => {
    const target = join(dir, "invalid");
    const { code, stderr } = await refused(["--dir", target, "--name", "acme", "--web-rail", "google", "--json"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Pass --web-rail stripe, lemonSqueezy, paddle or none.");
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("an --app name the app cannot take is refused before anything is scaffolded", async () => {
    for (const [name, app, message] of [
      ["bad-app", "Mobile_App", "App name must be kebab-case"],
      ["same-app", "api", "apps/api is the worker it calls"],
    ] as const) {
      const target = join(dir, name);
      const { code, stderr } = await refused([
        "--dir",
        target,
        "--name",
        "acme",
        "--worker",
        "api",
        "--app",
        app,
        "--json",
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain(message);
      await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
    }
  });

  test("--react-native on a web target is refused before anything is scaffolded", async () => {
    const target = join(dir, "web-app");
    const { code } = await refused(["--dir", target, "--name", "acme", "--target", "web", "--react-native", "--json"]);
    expect(code).toBe(2);
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });
});

/** `pithy init`'s two shell questions: the shortcut, then completion. */
describe("offerShell", () => {
  const TERMINAL = { stdin: { isTTY: true }, stdout: { isTTY: true } };

  /** Answers each question from `answers`, in order, and records what was asked and installed. */
  function offers(answers: (boolean | symbol)[]) {
    const asked: string[] = [];
    const installed: string[] = [];
    return {
      asked,
      installed,
      offers: {
        streams: TERMINAL,
        prompt: {
          confirm: async ({ message }: { message: string }) => {
            asked.push(message);
            return answers.shift() ?? false;
          },
          isCancel: (value: unknown) => typeof value === "symbol",
        },
        installAlias: async (options: { silent: boolean }) => {
          installed.push(`alias silent=${options.silent}`);
        },
        installCompletion: async (options: { silent: boolean }) => {
          installed.push(`completion silent=${options.silent}`);
        },
      },
    };
  }

  afterEach(() => {
    latchInputMode(false);
  });

  test("asks about completion once, after the shortcut, and a yes installs it silently", async () => {
    const run = offers([false, true]);
    expect(await offerShell(false, run.offers)).toBe(true);
    expect(run.asked).toEqual(["Want a shortcut? Type `p.` instead of `pithy`.", "Want tab completion for `pithy`?"]);
    expect(run.installed).toEqual(["completion silent=true"]);
  });

  test("a yes to both installs both, the shortcut first", async () => {
    const run = offers([true, true]);
    await offerShell(false, run.offers);
    expect(run.installed).toEqual(["alias silent=true", "completion silent=true"]);
  });

  test("a no or a cancel installs nothing", async () => {
    const no = offers([false, false]);
    await offerShell(false, no.offers);
    expect(no.installed).toEqual([]);
    const cancel = offers([Symbol("cancel"), Symbol("cancel")]);
    await offerShell(false, cancel.offers);
    expect(cancel.installed).toEqual([]);
  });

  test("never asks under --json", async () => {
    const run = offers([true, true]);
    expect(await offerShell(true, run.offers)).toBe(false);
    expect(run.asked).toEqual([]);
    expect(run.installed).toEqual([]);
  });

  test("never asks under --no-input or PITHY_NONINTERACTIVE=1, which latch the same bit", async () => {
    latchInputMode(true);
    const run = offers([true, true]);
    expect(await offerShell(false, run.offers)).toBe(false);
    expect(run.asked).toEqual([]);
  });

  test("never asks without a terminal on both streams", async () => {
    for (const streams of [
      { stdin: { isTTY: false }, stdout: { isTTY: true } },
      { stdin: { isTTY: true }, stdout: { isTTY: false } },
    ]) {
      const run = offers([true, true]);
      expect(await offerShell(false, { ...run.offers, streams })).toBe(false);
      expect(run.asked).toEqual([]);
    }
  });
});
