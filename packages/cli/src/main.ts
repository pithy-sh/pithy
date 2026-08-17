// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import type { CommandEntry } from "./help/groups";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/**
 * Every command the CLI has, the group it prints under, and how to load it. One list, not two.
 *
 * **The group is a required field, so a command cannot be added without deciding where it belongs.**
 * The root help screen groups its commands (§4.3), and the obvious way to spell that — a table of names
 * per group beside this one — is a second list of the same set. Two lists drift, and this drift is the
 * bad kind: a command added here and forgotten there would not fail, it would *vanish* from the one
 * screen whose whole job is to say what the CLI can do. `satisfies` makes the omission a compile error
 * and `HelpGroup` makes a typo one, which is why there is no gate for it and no catch-all group.
 *
 * **Written in the order the help screen prints**, so this file reads top-to-bottom like the output.
 * Dispatch is keyed by name and does not care; the order is here for whoever is reading.
 *
 * Subcommands load lazily — cold start stays fast as the set grows, and `load` stays a thunk so nothing
 * is imported until a name is walked into or the help screen resolves every description.
 */
const COMMANDS = {
  // Project — what the project is, and what it composes.
  init: { group: "Project", load: () => import("./commands/init").then((m) => m.default) },
  add: { group: "Project", load: () => import("./commands/add").then((m) => m.default) },
  remove: { group: "Project", load: () => import("./commands/remove").then((m) => m.default) },
  worker: { group: "Project", load: () => import("./commands/worker").then((m) => m.default) },
  ui: { group: "Project", load: () => import("./commands/ui").then((m) => m.default) },
  upgrade: { group: "Project", load: () => import("./commands/upgrade").then((m) => m.default) },

  // Develop — the local loop.
  dev: { group: "Develop", load: () => import("./commands/dev").then((m) => m.default) },
  migrate: { group: "Develop", load: () => import("./commands/migrate").then((m) => m.default) },
  seed: { group: "Develop", load: () => import("./commands/seed").then((m) => m.default) },
  feature: { group: "Develop", load: () => import("./commands/feature").then((m) => m.default) },

  // Operate — the deployed thing: its resources, its credentials, and who may manage it.
  provision: { group: "Operate", load: () => import("./commands/provision").then((m) => m.default) },
  deploy: { group: "Operate", load: () => import("./commands/deploy").then((m) => m.default) },
  env: { group: "Operate", load: () => import("./commands/env").then((m) => m.default) },
  token: { group: "Operate", load: () => import("./commands/token").then((m) => m.default) },
  dashboard: { group: "Operate", load: () => import("./commands/dashboard").then((m) => m.default) },

  // Capabilities — one command per capability that provisions infrastructure of its own.
  secrets: { group: "Capabilities", load: () => import("./commands/secrets").then((m) => m.default) },
  email: { group: "Capabilities", load: () => import("./commands/email").then((m) => m.default) },
  media: { group: "Capabilities", load: () => import("./commands/media").then((m) => m.default) },
  payments: { group: "Capabilities", load: () => import("./commands/payments").then((m) => m.default) },
  storage: { group: "Capabilities", load: () => import("./commands/storage").then((m) => m.default) },
  support: { group: "Capabilities", load: () => import("./commands/support").then((m) => m.default) },
  testers: { group: "Capabilities", load: () => import("./commands/testers").then((m) => m.default) },
  turnstile: { group: "Capabilities", load: () => import("./commands/turnstile").then((m) => m.default) },
  vector: { group: "Capabilities", load: () => import("./commands/vector").then((m) => m.default) },

  // Toolchain — the tool rather than the project.
  doctor: { group: "Toolchain", load: () => import("./commands/doctor").then((m) => m.default) },
  alias: { group: "Toolchain", load: () => import("./commands/alias").then((m) => m.default) },
} as const satisfies Record<string, CommandEntry>;

/** The registry, for the help screen. Every name, its group, and its loader. */
export const COMMAND_REGISTRY: Readonly<Record<string, CommandEntry>> = COMMANDS;

/** The root command. `subCommands` is projected from {@link COMMANDS} — citty sees the thunks it always did. */
export const main = defineCommand({
  meta: { name: "pithy", version, description: "A backend kit for Cloudflare Workers." },
  subCommands: Object.fromEntries(Object.entries(COMMANDS).map(([name, entry]) => [name, entry.load])),
});
