// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BasedPath } from "./home";

/**
 * The ten AI clients `pithy docs connect` can wire, as one table.
 *
 * **Everything that differs between clients is a column, so the eleventh tool is a row and not a
 * branch.** Ten tools read ten files, in four formats, under five root keys, in places that disagree on
 * every operating system — and the only thing they have in common is the server they are being pointed
 * at. Written as code paths that would be ten `if`s and a shared bug; written as data it is a table a
 * reader can check against a vendor's documentation line by line, which is exactly how it was built.
 *
 * **The `transport` column is the one distinction that is a decision rather than a fact.** Nine of these
 * clients speak streamable HTTP and run the MCP OAuth flow themselves, so they are handed the URL and
 * nothing else; a browser opens on first use and the token never touches Pithy. Claude Desktop's
 * *config file* is stdio-only — its remote connectors are a UI surface, not a file one — so that row,
 * and only that row, is written through `npx -y mcp-remote`, which runs the same flow and caches the
 * token in `~/.mcp-auth`. Recording it here rather than at a call site is the point: a reader can see
 * which clients pay for the shim and why, and a client that gains native support is a one-word edit.
 *
 * **Nothing in this table carries a credential, and no code path reads one.** `https://pithy.sh/mcp`
 * answers an unauthenticated request with an RFC 9728 challenge pointing at its own discovery document,
 * which offers dynamic client registration and PKCE to public clients — so every client here can reach
 * an authorized session from the URL alone. There is no token to write, which is why there is no
 * `@pithy-sh/secrets` involvement and nothing under `.dev.vars`.
 *
 * **The paths were verified against each vendor's current documentation**, not recalled: root keys are
 * spelled as the vendor spells them (`mcp_servers` with an underscore for Codex, `context_servers` for
 * Zed, `extensions` for Goose), and the per-platform bases are the documented ones rather than the
 * plausible ones — Goose and Zed use XDG on macOS, Claude Desktop uses Application Support, and Cline
 * uses one `$HOME`-relative path on all three.
 */

/** The three operating systems a path is declared for. Everything else resolves as `linux` does. */
export type ClientPlatform = "linux" | "darwin" | "win32";

/** One location per platform. Every client declares all three — a missing one is a file nobody writes. */
export type PlatformPaths = Readonly<Record<ClientPlatform, BasedPath>>;

/** The file syntax a client's config is written in. `jsonc` differs from `json` only in tolerating comments. */
export type ClientFormat = "json" | "jsonc" | "toml" | "yaml";

/** How the servers are held under the root key: keyed by name, or a sequence whose items carry their own. */
export type ClientContainer = "map" | "list";

/** Whether the client reaches the server itself, or through the `mcp-remote` stdio bridge. */
export type ClientTransport = "native" | "mcp-remote";

/** Which configuration a write lands in: the repository's, or the operator's own. */
export type Scope = "project" | "user";

/** One client, and everything that makes writing its configuration different from writing anybody else's. */
export interface McpClient {
  /** The `--client` value, and the key `pithy docs status` reports under. */
  readonly id: string;
  /** The tool's own name, for a human-readable line. */
  readonly label: string;
  /** The file syntax. Decides which writer merges the entry. */
  readonly format: ClientFormat;
  /** The top-level key the servers live under. */
  readonly rootKey: string;
  /** Whether that key holds a map of name → server, or a sequence of servers carrying a `name`. */
  readonly container: ClientContainer;
  /** Native, or through `npx -y mcp-remote`. The only column that changes what the entry says. */
  readonly transport: ClientTransport;
  /** The object written under `pithy` — already in the client's own vocabulary. */
  readonly entry: Readonly<Record<string, unknown>>;
  /** The project-scope file, relative to the project root, or `null` for a client with no project scope. */
  readonly project: readonly string[] | null;
  /** The user-scope file, per platform. Every client has one. */
  readonly user: PlatformPaths;
  /** The path whose existence means this tool is installed for this operator. */
  readonly detect: PlatformPaths;
  /**
   * The document written when a project-scope file does not exist yet.
   *
   * Only Continue needs one: a standalone block under `.continue/mcpServers/` is a document in its own
   * right and its schema requires `name`, `version` and `schema` beside the servers. Everywhere else a
   * new file is just the root key, which the writer adds on its own.
   */
  readonly preamble: string | null;
  /** One sentence on anything about this row a reader would otherwise have to take on trust. */
  readonly note: string;
}

/** The documentation server. One URL, stated once. */
export const DOCS_MCP_URL = "https://pithy.sh/mcp";

/** The key every client's entry is written under, and the only key `disconnect` removes. */
export const DOCS_MCP_NAME = "pithy";

/**
 * The stdio bridge a client without its own OAuth is pointed through.
 *
 * **Deliberately unpinned, and that is the safer of the two mistakes available.** This is the one entry
 * in the table that makes a client execute a package, so the version it resolves is worth an argument.
 * A floor (`mcp-remote@^0.1.x`) buys almost nothing — `npx` already resolves the newest release, so the
 * old version a floor excludes was never going to be chosen — and it costs something real: Pithy writes
 * this line into a file it never opens again, so the day `mcp-remote` releases a new minor, every
 * adopter Pithy ever configured is frozen on the old one, security fixes included. An exact pin is
 * worse for the same reason, twice over.
 *
 * So the line matches what every vendor documents, and the operator keeps receiving that package's own
 * fixes. What protects them is not a number here: it is that this row exists at all for exactly one
 * client, and only because Claude Desktop's config file cannot speak HTTP.
 */
export const MCP_REMOTE_ARGS: readonly string[] = ["-y", "mcp-remote", DOCS_MCP_URL];

/** `~/.config/<tool>` on both Unixes, `%APPDATA%\<Tool>` on Windows — the shape Zed and Goose share. */
function xdgPaths(unix: readonly string[], windows: readonly string[]): PlatformPaths {
  return {
    linux: { base: "config", segments: unix },
    darwin: { base: "config", segments: unix },
    win32: { base: "appData", segments: windows },
  };
}

/** One `$HOME`-relative path on all three platforms — what a tool that ships a plain dotfile uses. */
function homePaths(segments: readonly string[]): PlatformPaths {
  return {
    linux: { base: "home", segments },
    darwin: { base: "home", segments },
    win32: { base: "home", segments },
  };
}

/**
 * The registry.
 *
 * Ordered as `pithy docs status` prints: the clients most people run first, then the rest alphabetically
 * within their format. The order is presentation only — every consumer looks a row up by `id`.
 */
export const MCP_CLIENTS: readonly McpClient[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    format: "json",
    rootKey: "mcpServers",
    container: "map",
    transport: "native",
    // `type` is required whenever `url` is present: an entry without it is read as a stdio server.
    entry: { type: "http", url: DOCS_MCP_URL },
    project: [".mcp.json"],
    user: homePaths([".claude.json"]),
    detect: homePaths([".claude.json"]),
    preamble: null,
    note: "User scope shares `~/.claude.json` with Claude Code's own session state, so only the `mcpServers` key is touched.",
  },
  {
    id: "cursor",
    label: "Cursor",
    format: "json",
    rootKey: "mcpServers",
    container: "map",
    transport: "native",
    entry: { url: DOCS_MCP_URL },
    project: [".cursor", "mcp.json"],
    user: homePaths([".cursor", "mcp.json"]),
    detect: homePaths([".cursor"]),
    preamble: null,
    note: "A remote entry is the URL alone; `type` is documented for stdio servers only.",
  },
  {
    id: "vscode",
    label: "Visual Studio Code",
    format: "jsonc",
    // Not `mcpServers`. VS Code's own format keys its servers under `servers`, beside `inputs`.
    rootKey: "servers",
    container: "map",
    transport: "native",
    entry: { type: "http", url: DOCS_MCP_URL },
    project: [".vscode", "mcp.json"],
    user: {
      linux: { base: "config", segments: ["Code", "User", "mcp.json"] },
      darwin: { base: "appSupport", segments: ["Code", "User", "mcp.json"] },
      win32: { base: "appData", segments: ["Code", "User", "mcp.json"] },
    },
    detect: homePaths([".vscode", "extensions"]),
    preamble: null,
    note: "VS Code tries HTTP first and falls back to SSE on its own; the entry names neither.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    format: "json",
    rootKey: "mcpServers",
    container: "map",
    transport: "native",
    // `httpUrl`, not `url`: a bare `url` selects the SSE transport rather than streamable HTTP.
    entry: { httpUrl: DOCS_MCP_URL },
    project: [".gemini", "settings.json"],
    user: homePaths([".gemini", "settings.json"]),
    detect: homePaths([".gemini"]),
    preamble: null,
    note: "`httpUrl` selects streamable HTTP; a bare `url` would select SSE.",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    format: "json",
    rootKey: "mcpServers",
    container: "map",
    // The one row that pays for the bridge — see the module docblock.
    transport: "mcp-remote",
    entry: { command: "npx", args: MCP_REMOTE_ARGS },
    project: null,
    user: {
      linux: { base: "config", segments: ["Claude", "claude_desktop_config.json"] },
      darwin: { base: "appSupport", segments: ["Claude", "claude_desktop_config.json"] },
      win32: { base: "appData", segments: ["Claude", "claude_desktop_config.json"] },
    },
    detect: {
      linux: { base: "config", segments: ["Claude"] },
      darwin: { base: "appSupport", segments: ["Claude"] },
      win32: { base: "appData", segments: ["Claude"] },
    },
    preamble: null,
    note: "The config file takes stdio servers only, so this row goes through `mcp-remote`. Quit and reopen the app for it to load.",
  },
  {
    id: "cline",
    label: "Cline",
    format: "json",
    rootKey: "mcpServers",
    container: "map",
    transport: "native",
    entry: { type: "streamableHttp", url: DOCS_MCP_URL, disabled: false, autoApprove: [] },
    project: null,
    user: homePaths([".cline", "data", "settings", "cline_mcp_settings.json"]),
    detect: homePaths([".cline"]),
    preamble: null,
    note: "One `$HOME`-relative path on every platform, and `disabled`/`autoApprove` are part of the shape Cline validates.",
  },
  {
    id: "zed",
    label: "Zed",
    format: "jsonc",
    rootKey: "context_servers",
    container: "map",
    transport: "native",
    entry: { url: DOCS_MCP_URL },
    project: [".zed", "settings.json"],
    user: xdgPaths(["zed", "settings.json"], ["Zed", "settings.json"]),
    detect: xdgPaths(["zed"], ["Zed"]),
    preamble: null,
    note: "Zed prompts for the standard MCP OAuth flow when a remote server carries no Authorization header.",
  },
  {
    id: "codex",
    label: "Codex CLI",
    format: "toml",
    // Snake case, and `[mcp_servers.pithy]` is the table this writes.
    rootKey: "mcp_servers",
    container: "map",
    transport: "native",
    entry: { url: DOCS_MCP_URL },
    project: [".codex", "config.toml"],
    user: homePaths([".codex", "config.toml"]),
    detect: homePaths([".codex"]),
    preamble: null,
    note: "A project-scope `.codex/config.toml` is read for trusted projects only.",
  },
  {
    id: "goose",
    label: "Goose",
    format: "yaml",
    // Goose calls an MCP server an extension, and its config has no other server key.
    rootKey: "extensions",
    container: "map",
    transport: "native",
    entry: {
      type: "streamable_http",
      name: DOCS_MCP_NAME,
      enabled: true,
      // `uri`, not `url` — Goose spells it differently from everybody else.
      uri: DOCS_MCP_URL,
      timeout: 300,
    },
    project: null,
    user: xdgPaths(["goose", "config.yaml"], ["Block", "goose", "config", "config.yaml"]),
    detect: xdgPaths(["goose"], ["Block", "goose"]),
    preamble: null,
    note: "XDG on macOS as well as Linux, and Windows adds a `Block` vendor segment.",
  },
  {
    id: "continue",
    label: "Continue",
    format: "yaml",
    rootKey: "mcpServers",
    // The only sequence in the table: Continue's servers carry their own `name` rather than being keyed by it.
    container: "list",
    transport: "native",
    entry: { name: DOCS_MCP_NAME, type: "streamable-http", url: DOCS_MCP_URL },
    project: [".continue", "mcpServers", "pithy.yaml"],
    user: homePaths([".continue", "config.yaml"]),
    detect: homePaths([".continue"]),
    // A standalone block file is a document, and its schema requires these three keys beside the servers.
    preamble: "name: pithy\nversion: 0.0.1\nschema: v1\n",
    note: "Project scope is a standalone block file Pithy creates; user scope merges into the existing `config.yaml`.",
  },
];

/** A client by its `--client` id, or `undefined` when nothing answers to that name. */
export function clientById(id: string): McpClient | undefined {
  return MCP_CLIENTS.find((client) => client.id === id);
}

/**
 * The scopes a client can be written in — both, unless it has no project configuration.
 *
 * The return type is a non-empty list rather than an array, because every caller wants the first scope as
 * a fallback and there is no such thing as a client with nowhere to write. Saying so in the type spares
 * each of them a branch that could never be taken.
 */
export function scopesOf(client: McpClient): readonly [Scope, ...Scope[]] {
  return client.project === null ? ["user"] : ["project", "user"];
}
