// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { describeCli, globalFlags } from "../contract/describe";
import { main } from "../main";
import { sourceFiles } from "./sourceFiles";

/**
 * **The `pithy` Claude Code plugin, held to what it claims (#719).**
 *
 * The plugin is markdown and JSON, so nothing compiles it and nothing would notice it drifting from the
 * CLI it drives. These are the properties that would drift: the agent team and its defaults, the
 * per-agent model settings and the dispatch that carries them, the version stamped from the CLI, and
 * every `pithy` command the plugin tells an agent to run. `claude plugin validate --strict` holds the
 * manifests' shape in CI; this holds what they mean.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const MARKETPLACE = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
const PLUGINS = join(REPO_ROOT, "agent-plugins", "claude");
const PITHY = join(PLUGINS, "pithy");

const run = promisify(execFile);

/** The team as the README and the issue state it: the agent, its settings key, and its defaults. */
const TEAM = [
  { agent: "server", key: "server", model: "sonnet", effort: "medium" },
  { agent: "client-web", key: "client_web", model: "sonnet", effort: "medium" },
  { agent: "client-mobile", key: "client_mobile", model: "sonnet", effort: "medium" },
  { agent: "runner", key: "runner", model: "haiku", effort: "low" },
] as const;

const SKILLS = ["new-app", "app-design", "report-kit-gap"] as const;

interface UserConfigEntry {
  type: string;
  default?: unknown;
  options?: string[];
}

interface PluginManifest {
  name: string;
  version: string;
  userConfig: Record<string, UserConfigEntry>;
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** A markdown file's YAML frontmatter, as flat `key: value` pairs — all the plugin's frontmatter is. */
function frontmatter(source: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match?.[1]) return {};
  const pairs: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return pairs;
}

/**
 * Claude Code's `${user_config.KEY}` substitution in skill content, as measured against Claude Code 2.1.296:
 * a key the user configured is replaced with its value, and a key they never set is left exactly as written.
 * Its declared `default` is **not** substituted — which is why the skill says to leave such a parameter out,
 * and why each agent's own frontmatter must carry the same default the setting offers.
 */
function substitute(content: string, configured: Record<string, string>): string {
  return content.replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (whole, key: string) => configured[key] ?? whole);
}

/** The dispatch table rows of a skill: `subagent_type`, `model` and `effort`, per row that names a plugin agent. */
function dispatchRows(content: string): { agent: string; model: string; effort: string }[] {
  const rows: { agent: string; model: string; effort: string }[] = [];
  for (const line of content.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""));
    const agent = cells.find((cell) => cell.startsWith("pithy:"));
    if (agent === undefined) continue;
    const at = cells.indexOf(agent);
    rows.push({ agent: agent.slice("pithy:".length), model: cells[at + 1] ?? "", effort: cells[at + 2] ?? "" });
  }
  return rows;
}

const manifest = json<PluginManifest>(join(PITHY, ".claude-plugin", "plugin.json"));
const agentSource = (name: string) => readFileSync(join(PITHY, "agents", `${name}.md`), "utf8");
const skillSource = (name: string) => readFileSync(join(PITHY, "skills", name, "SKILL.md"), "utf8");

describe("the marketplace", () => {
  const marketplace = json<{
    name: string;
    metadata: { pluginRoot: string };
    plugins: { name: string; source: string }[];
  }>(MARKETPLACE);

  test("is the pithy marketplace, rooted at agent-plugins/claude", () => {
    expect(marketplace.name).toBe("pithy");
    expect(marketplace.metadata.pluginRoot).toBe("./agent-plugins/claude");
  });

  test("lists every plugin directory, and every entry is one", () => {
    const dirs = readdirSync(PLUGINS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(marketplace.plugins.map((plugin) => plugin.source).sort()).toEqual(dirs);
    for (const plugin of marketplace.plugins) {
      expect(json<PluginManifest>(join(PLUGINS, plugin.source, ".claude-plugin", "plugin.json")).name).toBe(
        plugin.name,
      );
    }
  });
});

describe("the pithy plugin's team", () => {
  test("ships exactly the four agents", () => {
    expect(
      readdirSync(join(PITHY, "agents"))
        .map((file) => file.replace(/\.md$/, ""))
        .sort(),
    ).toEqual(TEAM.map((member) => member.agent).sort());
  });

  test.each(TEAM)("$agent declares its documented default model and effort", ({ agent, model, effort }) => {
    const fields = frontmatter(agentSource(agent));
    expect(fields.name).toBe(agent);
    expect(fields.model).toBe(model);
    expect(fields.effort).toBe(effort);
  });

  test.each(TEAM)("$agent's model and effort are settings, defaulting to the same values", ({ key, model, effort }) => {
    expect(manifest.userConfig[`${key}_model`]).toEqual(expect.objectContaining({ type: "string", default: model }));
    expect(manifest.userConfig[`${key}_effort`]).toEqual(expect.objectContaining({ type: "string", default: effort }));
    expect(manifest.userConfig[`${key}_model`]?.options).toContain(model);
    expect(manifest.userConfig[`${key}_effort`]?.options).toContain(effort);
  });

  test("declares no setting beyond the team's", () => {
    expect(Object.keys(manifest.userConfig).sort()).toEqual(
      TEAM.flatMap(({ key }) => [`${key}_effort`, `${key}_model`]).sort(),
    );
  });

  test("the runner holds Bash and Read, and nothing else", () => {
    expect(frontmatter(agentSource("runner")).tools).toBe("Bash, Read");
    expect(agentSource("runner")).toMatch(/summary, never the raw output/i);
  });

  test("every other agent leaves the running to the runner", () => {
    for (const agent of ["server", "client-web", "client-mobile"]) expect(agentSource(agent)).toMatch(/runner agent/);
  });
});

/**
 * The model and effort an agent runs on are the ones the user configured. A plugin cannot substitute a
 * setting into an agent's frontmatter, so the skill that dispatches the agent carries it: each dispatch
 * row names `${user_config.<key>_model}` and `${user_config.<key>_effort}`, and the Agent call's `model`
 * and `effort` outrank the frontmatter. Rendered here the way Claude Code renders the skill, once with
 * values nobody would pick by accident, and once with nothing configured.
 */
describe("the configured model and effort are the ones each agent runs on", () => {
  const configured = Object.fromEntries(
    TEAM.flatMap(({ key }, index) => [
      [`${key}_model`, ["opus", "fable", "opus", "sonnet"][index] as string],
      [`${key}_effort`, ["max", "xhigh", "high", "medium"][index] as string],
    ]),
  );
  const defaults = Object.fromEntries(
    Object.entries(manifest.userConfig).map(([key, entry]) => [key, String(entry.default)]),
  );

  test("new-app dispatches every agent through its own two settings", () => {
    const rows = dispatchRows(skillSource("new-app"));
    expect(rows.map((row) => row.agent).sort()).toEqual(TEAM.map((member) => member.agent).sort());
    for (const { agent, key } of TEAM) {
      expect(rows.find((row) => row.agent === agent)).toEqual({
        agent,
        model: `\${user_config.${key}_model}`,
        effort: `\${user_config.${key}_effort}`,
      });
    }
  });

  test("rendered with configured values, every dispatch carries them", () => {
    const rows = dispatchRows(substitute(skillSource("new-app"), configured));
    for (const { agent, key } of TEAM) {
      expect(rows.find((row) => row.agent === agent)).toEqual({
        agent,
        model: configured[`${key}_model`],
        effort: configured[`${key}_effort`],
      });
    }
  });

  test("a setting left unset stays a placeholder, and the skill says to leave it out of the call", () => {
    const rows = dispatchRows(substitute(skillSource("new-app"), { server_model: "opus" }));
    expect(rows.find((row) => row.agent === "server")).toEqual({
      agent: "server",
      model: "opus",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the unsubstituted placeholder is the fixture.
      effort: "${user_config.server_effort}",
    });
    expect(skillSource("new-app")).toMatch(
      /still reads `\$\{user_config\.…\}` is a setting the user never chose\. Leave that parameter out/,
    );
  });

  test("so an unset setting falls to the agent's frontmatter, which is the same default the setting offers", () => {
    for (const { agent, key } of TEAM) {
      const fields = frontmatter(agentSource(agent));
      expect(fields.model).toBe(defaults[`${key}_model`]);
      expect(fields.effort).toBe(defaults[`${key}_effort`]);
    }
  });

  test("the skill tells the session to pass them as the Agent call's model and effort", () => {
    expect(skillSource("new-app")).toMatch(
      /passing `subagent_type`, `model` and `effort` exactly as this table gives them/,
    );
  });

  test("no skill dispatches an agent without its settings", () => {
    for (const skill of SKILLS) {
      for (const row of dispatchRows(skillSource(skill))) {
        const key = TEAM.find((member) => member.agent === row.agent)?.key;
        expect(key, `${skill} dispatches pithy:${row.agent}, which is not on the team`).toBeDefined();
        expect(row).toEqual({
          agent: row.agent,
          model: `\${user_config.${key}_model}`,
          effort: `\${user_config.${key}_effort}`,
        });
      }
    }
  });
});

describe("the skills", () => {
  test.each(SKILLS)("%s exists, says what it is for, and is documented in the README", (skill) => {
    expect(frontmatter(skillSource(skill)).name).toBe(skill);
    expect(frontmatter(skillSource(skill)).description?.length).toBeGreaterThan(40);
    expect(readFileSync(join(PITHY, "README.md"), "utf8")).toContain(`\`/${skill}\``);
  });

  test("report-kit-gap searches first, files only on a yes, and keeps customer code and secrets out", () => {
    const source = skillSource("report-kit-gap");
    expect(source.indexOf("gh search issues")).toBeLessThan(source.indexOf("gh issue create"));
    expect(source).toContain("gh issue comment");
    expect(source).toMatch(/explicit yes/);
    expect(source).toMatch(/Never include the customer's code, and never a secret/);
    expect(source).toContain("pithy --version");
    expect(source).toContain("pithy doctor --json");
    expect(source).toMatch(/template=bug\.yml/);
    expect(source).toMatch(/template=feature\.yml/);
    expect(source).toMatch(/Works around pithy-sh\/pithy#/);
  });

  test("report-kit-gap's marker is the one the intake workflow labels on", () => {
    const marker = "Filed with the pithy plugin for Claude Code.";
    expect(skillSource("report-kit-gap")).toContain(marker);
    const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "plugin-intake.yml"), "utf8");
    expect(workflow).toContain(`contains(github.event.issue.body, '${marker}')`);
    expect(workflow).toContain('--add-label "from: pithy-plugin" --add-label needs-triage');
  });
});

describe("the README", () => {
  const readme = readFileSync(join(PITHY, "README.md"), "utf8");

  test("installs from #release, and names one source and why not both", () => {
    expect(readme).toContain("/plugin marketplace add pithy-sh/pithy#release");
    expect(readme).toContain("/plugin install pithy@pithy");
    expect(readme).toMatch(/Install from one source/);
    expect(readme).toContain("pithy@synced");
    expect(readme).toMatch(/Not both/);
  });

  test("says how to turn on auto-update and how to update by hand", () => {
    expect(readme).toMatch(/Enable auto-update/);
    expect(readme).toContain("/plugin marketplace update pithy");
  });
});

describe("the version is the CLI's", () => {
  const cli = json<{ version: string }>(join(REPO_ROOT, "packages", "cli", "package.json"));

  test("every plugin carries @pithy-sh/cli's version", () => {
    for (const dir of readdirSync(PLUGINS)) {
      expect(json<PluginManifest>(join(PLUGINS, dir, ".claude-plugin", "plugin.json")).version).toBe(cli.version);
    }
  });

  test("stampVersions --check fails on a drifted plugin, and a stamp repairs it", async () => {
    const copy = await mkdtemp(join(tmpdir(), "pithy-stamp-"));
    try {
      // Just what the stamp reads: the CLI's package.json, and the plugins. No capability package.
      await mkdir(join(copy, "packages", "cli"), { recursive: true });
      await writeFile(join(copy, "packages", "cli", "package.json"), JSON.stringify({ version: "9.9.9" }));
      await cp(PLUGINS, join(copy, "agent-plugins", "claude"), { recursive: true });
      const stamp = (...args: string[]) =>
        run("bun", [join(REPO_ROOT, "scripts", "stampVersions.ts"), "--root", copy, ...args]);

      const refused = await stamp("--check").then(
        () => null,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(refused?.code).toBe(1);
      expect(refused?.stderr).toContain(join("agent-plugins", "claude", "pithy", ".claude-plugin", "plugin.json"));

      await stamp();
      const stamped = JSON.parse(
        await readFile(join(copy, "agent-plugins", "claude", "pithy", ".claude-plugin", "plugin.json"), "utf8"),
      ) as PluginManifest;
      expect(stamped.version).toBe("9.9.9");
      expect(Object.keys(stamped)).toEqual(Object.keys(manifest));
      await stamp("--check");
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * **Every `pithy` command the plugin names is one the CLI has** (#719). An agent told to run a command
 * that does not exist runs it anyway and reports the failure as the user's problem. Read off the same
 * walk `pithy schema --json` publishes, so a renamed or removed command fails here the day it moves. A
 * flag is checked too: a `--flag` written after a command must be one it declares, or a global one.
 */
describe("every pithy command the plugin names is in pithy schema", () => {
  /**
   * Each inline code span, and each line of a shell fence, in a markdown file. Prose is not a command, and
   * neither is a `text` fence: the intake marker reads "the pithy plugin" and is a sentence to paste.
   */
  function codeOf(source: string): string[] {
    const fenced = [...source.matchAll(/```(?:bash|sh|shell|console)\n([\s\S]*?)```/g)].flatMap((match) =>
      (match[1] ?? "").split("\n"),
    );
    const outside = source.replace(/```[\s\S]*?```/g, "");
    const spans = [...outside.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
    return [...fenced, ...spans];
  }

  /** `pithy <words…> [--flags…]` inside one code line, as a word list and a flag list. */
  function mentions(line: string): { words: string[]; flags: string[] }[] {
    const found: { words: string[]; flags: string[] }[] = [];
    for (const match of line.matchAll(/(?:^|[\s(`$])pithy(?![\w-])((?:\s+[^\s|;&)`]+)*)/g)) {
      const tokens = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
      const words: string[] = [];
      for (const token of tokens) {
        if (!/^[a-z][a-z-]*$/.test(token)) break;
        words.push(token);
      }
      const flags = tokens.filter((token) => token.startsWith("--")).map((token) => token.split("=")[0] as string);
      found.push({ words, flags });
    }
    return found;
  }

  test("the reader finds commands and flags in code, and skips the rest", () => {
    expect(mentions("pithy add leaderboard --worker api")).toEqual([
      { words: ["add", "leaderboard"], flags: ["--worker"] },
    ]);
    expect(mentions("run `pithy dev logs` then")).toEqual([{ words: ["dev", "logs"], flags: [] }]);
    expect(mentions("@pithy-sh/auth")).toEqual([]);
    expect(mentions("pithy-sh/pithy#719")).toEqual([]);
  });

  test("every command and flag in every plugin's markdown exists", async () => {
    const { commands } = await describeCli(main);
    const byPath = new Map(commands.map((command) => [command.path, command]));
    const global = new Set(globalFlags().flatMap((flag) => [flag.name, ...flag.aliases]));
    const faults: string[] = [];
    let checked = 0;

    for (const { path: file, text } of sourceFiles(PLUGINS, { keep: (name) => name.endsWith(".md") })) {
      for (const line of codeOf(text)) {
        for (const { words, flags } of mentions(line)) {
          // `pithy` alone, or followed by a flag such as `--version`: the root, which always exists.
          if (words.length === 0) continue;
          // The longest prefix that is a command: `pithy add leaderboard` is `add` with a positional.
          let command: (typeof commands)[number] | undefined;
          for (let length = words.length; length > 0 && command === undefined; length -= 1) {
            command = byPath.get(words.slice(0, length).join(" "));
          }
          const where = `${file.slice(REPO_ROOT.length + 1)}: pithy ${words.join(" ")}`;
          if (command === undefined) {
            faults.push(`${where} is not a command.`);
            continue;
          }
          checked += 1;
          const declared = new Set(
            command.flags.flatMap((flag) => [
              flag.name,
              ...flag.aliases,
              ...(flag.type === "boolean" ? [`--no-${flag.name.slice(2)}`] : []),
            ]),
          );
          for (const flag of flags) {
            if (!declared.has(flag) && !global.has(flag)) faults.push(`${where} has no ${flag}.`);
          }
        }
      }
    }

    expect(faults).toEqual([]);
    // Non-vacuous: the plugin names a good part of the CLI, and a reader that found nothing is broken.
    expect(checked).toBeGreaterThan(20);
  });
});
