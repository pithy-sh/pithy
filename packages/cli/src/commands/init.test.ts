// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CfAccount } from "@pithy-sh/cloudflare/src/client/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type CloudflareConfigOptions, cloudflareEnv } from "../cloudflare/config";
import {
  askCloudflareAccount,
  askEnvironments,
  type InitPrompt,
  renderCloudflareBlock,
  writeCloudflareBlock,
} from "./init";

/**
 * `pithy init` is the one moment the adopter is holding the token, so it is the one moment the account
 * can be *discovered* rather than asked for (#206). Every case here drives the account listing and the
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
          // Both accounts are on offer, each labelled with the id it will pin.
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
 * The environment question (#241). `name` has been asked at `init` and capped since the beginning,
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

  test("a cancelled prompt keeps the default rather than proceeding on half an answer", async () => {
    const answer = await askEnvironments({
      interactive: true,
      prompt: prompts({ text: async () => Symbol("cancel") }),
    });
    expect(answer.environments).toEqual(["staging", "prod"]);
  });
});
