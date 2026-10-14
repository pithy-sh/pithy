// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const SKILLS = ["new-app", "app-design", "deploy", "report-kit-gap"] as const;

interface UserConfigEntry {
  type: string;
  default?: unknown;
  options?: string[];
}

interface PluginManifest {
  name: string;
  version: string;
  dependencies?: string[];
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

/**
 * The dispatch table rows of a skill: `subagent_type`, `model` and `effort`, per row that names an agent of
 * `plugin`. `pithy-games:client-unity` is not a `pithy` row: the prefix is the plugin name and its colon.
 */
function dispatchRows(content: string, plugin = "pithy"): { agent: string; model: string; effort: string }[] {
  const prefix = `${plugin}:`;
  const rows: { agent: string; model: string; effort: string }[] = [];
  for (const line of content.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""));
    const agent = cells.find((cell) => cell.startsWith(prefix));
    if (agent === undefined) continue;
    const at = cells.indexOf(agent);
    rows.push({ agent: agent.slice(prefix.length), model: cells[at + 1] ?? "", effort: cells[at + 2] ?? "" });
  }
  return rows;
}

/** One plugin's files, read by name: its manifest, an agent, a skill, its README. */
function pluginFiles(name: string) {
  const dir = join(PLUGINS, name);
  return {
    dir,
    manifest: json<PluginManifest>(join(dir, ".claude-plugin", "plugin.json")),
    agent: (agent: string) => readFileSync(join(dir, "agents", `${agent}.md`), "utf8"),
    skill: (skill: string) => readFileSync(join(dir, "skills", skill, "SKILL.md"), "utf8"),
    readme: () => readFileSync(join(dir, "README.md"), "utf8"),
  };
}

const { manifest, agent: agentSource, skill: skillSource } = pluginFiles("pithy");

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

/**
 * **`/deploy` takes an app to a named environment on the person's word, and offers the dashboard after (#757).**
 *
 * A deploy comes days into a build, in a session that may never have run `/new-app`, so it is a skill of its own
 * whose description an agent matches. What it may do is held here, because each rule is a sentence an edit could
 * quietly soften: a yes is per environment, a production phrase comes only from the person, exit 5 stops the
 * team, and the dashboard is offered, never connected unasked.
 */
describe("the deploy skill", () => {
  const skill = () => skillSource("deploy");
  const runner = () => agentSource("runner");

  test("is found by what a person says when they want it", () => {
    const description = frontmatter(skill()).description ?? "";
    for (const words of ["deploy", "staging", "production", "go live", "connect the dashboard"]) {
      expect(description).toContain(words);
    }
  });

  test("checks, plans and asks before anything touches the account", () => {
    const source = skill();
    expect(source.indexOf("pithy doctor --json")).toBeLessThan(source.indexOf("## 3. Ask"));
    expect(source.indexOf("--dry-run --json")).toBeLessThan(source.indexOf("## 3. Ask"));
    expect(source).toMatch(/A yes for staging is not a yes for production/);
  });

  test("provisions, migrates and deploys, in that order", () => {
    const source = skill();
    const at = (command: string) => source.indexOf(command);
    expect(at("pithy provision --env <env> --yes")).toBeGreaterThan(-1);
    expect(at("pithy provision --env <env> --yes")).toBeLessThan(at("pithy migrate --env <env>"));
    expect(at("pithy migrate --env <env>")).toBeLessThan(at("pithy deploy --env <env>"));
  });

  test("passes a production phrase only as the person typed it, and stops on exit 5", () => {
    expect(skill()).toMatch(/Pass what they typed to `--confirm` verbatim, and never write the phrase yourself/);
    expect(skill()).toMatch(/Exit 5 means stop/);
    expect(runner()).toMatch(/Never write a confirmation phrase yourself/);
    expect(runner()).toMatch(/exits 5, `core\/person_required`, is a step only the person may take/);
  });

  test("the runner deploys only on the person's word, and never removes or rolls back", () => {
    expect(runner()).toMatch(/only when the caller says the person approved that environment in this conversation/);
    expect(runner()).toMatch(/Never run `pithy remove` or a rollback/);
  });

  test("offers the dashboard from offers, never as next, and runs the connect itself", () => {
    expect(skill()).toMatch(/`offers` is not `next`/);
    expect(skill()).toContain("pithy dashboard status --env <env> --json");
    expect(skill()).toMatch(/run the command `offers` names yourself, not through the runner/);
    expect(runner()).toMatch(/Never `pithy dashboard connect`/);
  });

  test("new-app points at it, and the README says what it asks first", () => {
    expect(skillSource("new-app")).toContain("`/deploy`");
    const readme = readFileSync(join(PITHY, "README.md"), "utf8");
    expect(readme).toMatch(/## Deploy, and connect the dashboard/);
    expect(readme).toMatch(/A yes to staging is not a yes to production/);
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

/**
 * **The `pithy-games` add-on, held to what it claims (#718).** It depends on `pithy`, reuses its team by
 * name, adds one agent with its own two settings, and pins the generator its Unity client is built with.
 * Every name it reaches across the plugin boundary — `pithy:runner`, `pithy:report-kit-gap` — is checked to
 * land on a file, because nothing else would notice a rename on the other side.
 */
describe("the pithy-games add-on", () => {
  const games = pluginFiles("pithy-games");
  const GAMES_TEAM = [{ agent: "client-unity", key: "client_unity", model: "sonnet", effort: "medium" }] as const;
  const GAMES_SKILLS = ["new-game", "game-design", "playtest"] as const;
  const markdown = sourceFiles(games.dir, { keep: (name) => name.endsWith(".md") });

  /** Every `<plugin>:<name>` a file names, for the two plugins in this marketplace. */
  function qualifiedNames(source: string): { plugin: string; name: string }[] {
    return [...source.matchAll(/(?<![\w-])(pithy|pithy-games):([a-z][a-z0-9-]*)/g)].map((match) => ({
      plugin: match[1] as string,
      name: match[2] as string,
    }));
  }

  /** Where Claude Code finds `<plugin>:<name>`: an agent file, or a skill directory, in that plugin. */
  function resolve(plugin: string, name: string): string | undefined {
    const candidates = [
      join(PLUGINS, plugin, "agents", `${name}.md`),
      join(PLUGINS, plugin, "skills", name, "SKILL.md"),
    ];
    return candidates.find((path) => existsSync(path));
  }

  test("depends on pithy, and every dependency is a plugin in this marketplace", () => {
    expect(games.manifest.name).toBe("pithy-games");
    expect(games.manifest.dependencies).toEqual(["pithy"]);
    const listed = json<{ plugins: { name: string }[] }>(MARKETPLACE).plugins.map((plugin) => plugin.name);
    for (const dependency of games.manifest.dependencies ?? []) expect(listed).toContain(dependency);
  });

  test("ships exactly client-unity, on its documented defaults, which are its settings' defaults", () => {
    expect(readdirSync(join(games.dir, "agents"))).toEqual(["client-unity.md"]);
    expect(Object.keys(games.manifest.userConfig).sort()).toEqual(["client_unity_effort", "client_unity_model"]);
    for (const { agent, key, model, effort } of GAMES_TEAM) {
      const fields = frontmatter(games.agent(agent));
      expect(fields.name).toBe(agent);
      expect(fields.model).toBe(model);
      expect(fields.effort).toBe(effort);
      expect(games.manifest.userConfig[`${key}_model`]).toEqual(expect.objectContaining({ default: model }));
      expect(games.manifest.userConfig[`${key}_effort`]).toEqual(expect.objectContaining({ default: effort }));
      // The same choices the base team offers, so a setting means the same thing in either plugin.
      expect(games.manifest.userConfig[`${key}_model`]?.options).toEqual(manifest.userConfig.server_model?.options);
      expect(games.manifest.userConfig[`${key}_effort`]?.options).toEqual(manifest.userConfig.server_effort?.options);
    }
  });

  test("client-unity leaves the running to pithy:runner and files gaps with pithy's skill", () => {
    const source = games.agent("client-unity");
    expect(source).toMatch(/runner agent, `pithy:runner`/);
    expect(source).toContain("/pithy:report-kit-gap");
    expect(source).toContain("--library unityWebRequest");
    expect(source).toContain("pithy.multiplayer.v1");
    expect(source).toContain("link.xml");
  });

  describe("new-game dispatches every agent through its own two settings", () => {
    const source = games.skill("new-game");
    const configured = {
      ...Object.fromEntries(
        TEAM.flatMap(({ key }) => [
          [`${key}_model`, "opus"],
          [`${key}_effort`, "max"],
        ]),
      ),
      client_unity_model: "fable",
      client_unity_effort: "xhigh",
    } as Record<string, string>;

    /**
     * Settings are per-plugin, measured on Claude Code 2.1.296: a `pithy-games` skill rendering
     * `${user_config.server_model}` got the literal text, while `pithy`'s own skills got the configured value.
     * So the base team is brought in by `pithy:new-app`, inside the plugin that owns its settings, and this
     * skill dispatches only its own agent.
     */
    test("leaves the base team to pithy:new-app, and dispatches only client-unity, by its own keys", () => {
      expect(dispatchRows(source, "pithy")).toEqual([]);
      expect(source).toContain("Invoke the `pithy:new-app` skill");
      expect(dispatchRows(source, "pithy-games")).toEqual(
        GAMES_TEAM.map(({ agent, key }) => ({
          agent,
          model: `\${user_config.${key}_model}`,
          effort: `\${user_config.${key}_effort}`,
        })),
      );
    });

    test("rendered with configured values, the Unity dispatch carries them", () => {
      const rendered = substitute(source, configured);
      for (const { agent, key } of GAMES_TEAM) {
        expect(dispatchRows(rendered, "pithy-games").find((row) => row.agent === agent)).toEqual({
          agent,
          model: configured[`${key}_model`],
          effort: configured[`${key}_effort`],
        });
      }
    });

    test("a setting left unset stays a placeholder, and the skill says to leave it out of the call", () => {
      const rows = dispatchRows(substitute(source, { client_unity_model: "opus" }), "pithy-games");
      expect(rows).toEqual([
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the unsubstituted placeholder is the fixture.
        { agent: "client-unity", model: "opus", effort: "${user_config.client_unity_effort}" },
      ]);
      expect(source).toMatch(/passing `subagent_type`, `model` and `effort` exactly as this table gives them/);
      expect(source).toMatch(
        /still reads `\$\{user_config\.…\}` is a setting the user never chose\. Leave that parameter out/,
      );
    });

    test("no skill dispatches an agent without its settings", () => {
      for (const skill of GAMES_SKILLS) {
        for (const [plugin, team] of [
          ["pithy", TEAM],
          ["pithy-games", GAMES_TEAM],
        ] as const) {
          for (const row of dispatchRows(games.skill(skill), plugin)) {
            const key = (team as readonly { agent: string; key: string }[]).find(
              (member) => member.agent === row.agent,
            )?.key;
            expect(key, `${skill} dispatches ${plugin}:${row.agent}, which is not on the team`).toBeDefined();
            expect(row.model).toBe(`\${user_config.${key}_model}`);
            expect(row.effort).toBe(`\${user_config.${key}_effort}`);
          }
        }
      }
    });
  });

  test("every pithy: and pithy-games: name in the add-on resolves, in the plugin it names", () => {
    const faults: string[] = [];
    let checked = 0;
    for (const { path: file, text } of markdown) {
      for (const { plugin, name } of qualifiedNames(text)) {
        checked += 1;
        if (resolve(plugin, name) === undefined) faults.push(`${file.slice(REPO_ROOT.length + 1)}: ${plugin}:${name}`);
      }
    }
    expect(faults).toEqual([]);
    expect(checked).toBeGreaterThan(10);
  });

  test("every agent a dispatch table names is an agent file, not a skill", () => {
    for (const skill of GAMES_SKILLS) {
      for (const plugin of ["pithy", "pithy-games"]) {
        for (const row of dispatchRows(games.skill(skill), plugin)) {
          expect(existsSync(join(PLUGINS, plugin, "agents", `${row.agent}.md`)), `${plugin}:${row.agent}`).toBe(true);
        }
      }
    }
  });

  test("a skill invokes pithy:report-kit-gap by name, and it is pithy's skill", () => {
    const invoking = GAMES_SKILLS.filter((skill) => games.skill(skill).includes("invoke `pithy:report-kit-gap`"));
    expect(invoking.length).toBeGreaterThan(0);
    expect(resolve("pithy", "report-kit-gap")).toBe(join(PITHY, "skills", "report-kit-gap", "SKILL.md"));
  });

  test("playtest dispatches pithy:runner to run the shipped script, which exists", () => {
    const source = games.skill("playtest");
    expect(source).toMatch(/Dispatch `pithy:runner`/);
    expect(resolve("pithy", "runner")).toBe(join(PITHY, "agents", "runner.md"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin-root variable is what the skill must name.
    expect(source).toContain("node ${CLAUDE_PLUGIN_ROOT}/scripts/playtest.ts");
    expect(existsSync(join(games.dir, "scripts", "playtest.ts"))).toBe(true);
    for (const flag of ["--origin", "--game", "--players", "--moves", "--token"]) expect(source).toContain(flag);
  });

  test.each(GAMES_SKILLS)("%s exists, says what it is for, and is documented in the README", (skill) => {
    expect(frontmatter(games.skill(skill)).name).toBe(skill);
    expect(frontmatter(games.skill(skill)).description?.length).toBeGreaterThan(40);
    expect(games.readme()).toContain(`\`/${skill}\``);
  });

  test("the README installs from #release, and pithy-games brings pithy", () => {
    const readme = games.readme();
    expect(readme).toContain("/plugin marketplace add pithy-sh/pithy#release");
    expect(readme).toContain("/plugin install pithy-games@pithy");
    expect(readme).toMatch(/installs `pithy` with it/);
    expect(readme).toMatch(/Install from one source/);
    expect(readme).toContain("asyncapi.json");
    expect(readme).toContain("client_unity_model");
    expect(readme).toContain("client_unity_effort");
  });

  /**
   * The Unity client's generator is pinned, because `unityWebRequest` is experimental. The pin lives in
   * one exported constant; the agent and the README name it, and no other version of it appears anywhere
   * in the add-on. Imported by computed path: it sits outside this package's `rootDir`.
   */
  test("the pinned generator is the constant, in the agent and the README, and no other version is", async () => {
    const generatorModule = join(games.dir, "scripts", "generator.ts");
    const { UNITY_OPENAPI_GENERATOR } = (await import(generatorModule)) as { UNITY_OPENAPI_GENERATOR: string };
    expect(UNITY_OPENAPI_GENERATOR).toMatch(/^openapitools\/openapi-generator-cli:v\d+\.\d+\.\d+$/);
    for (const source of [games.agent("client-unity"), games.readme()]) {
      expect(source).toContain(UNITY_OPENAPI_GENERATOR);
      expect(source).toContain(
        `${UNITY_OPENAPI_GENERATOR} generate -i apps/<worker>/openapi.json -g csharp --library unityWebRequest --additional-properties=packageName=Pithy.Client -o <unity project>/Assets/Pithy/Client`,
      );
    }
    for (const { text } of markdown) {
      for (const [image] of text.matchAll(/openapitools\/openapi-generator-cli:v[\w.-]+/g)) {
        expect(image).toBe(UNITY_OPENAPI_GENERATOR);
      }
    }
    // And CI's Unity job generates with the same image, so what the guide recommends is what CI proves.
    const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const images = [...ci.matchAll(/openapitools\/openapi-generator-cli:v[\w.-]+/g)].map(([image]) => image);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toBe(UNITY_OPENAPI_GENERATOR);
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

/**
 * **A plugin names only its own settings.** Substitution is per-plugin, so a `${user_config.KEY}` in one
 * plugin's markdown that its own manifest does not declare never fills in — it reaches the Agent call as
 * text, or is left out and silently ignores the user's choice in another plugin. Every plugin, every key.
 */
describe("every user_config key a plugin's markdown names is one its own manifest declares", () => {
  test.each(readdirSync(PLUGINS))("%s", (plugin) => {
    const declared = new Set(
      Object.keys(json<PluginManifest>(join(PLUGINS, plugin, ".claude-plugin", "plugin.json")).userConfig ?? {}),
    );
    const named = sourceFiles(join(PLUGINS, plugin), { keep: (name) => name.endsWith(".md") }).flatMap(({ text }) =>
      [...text.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((match) => match[1] as string),
    );
    expect(named.filter((key) => !declared.has(key))).toEqual([]);
  });
});
