// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** The root command. Subcommands load lazily — cold start stays fast as the set grows. */
export const main = defineCommand({
  meta: { name: "pithy", version, description: "A backend kit for Cloudflare Workers." },
  subCommands: {
    init: () => import("./commands/init").then((m) => m.default),
    add: () => import("./commands/add").then((m) => m.default),
    remove: () => import("./commands/remove").then((m) => m.default),
    worker: () => import("./commands/worker").then((m) => m.default),
    ui: () => import("./commands/ui").then((m) => m.default),
    dev: () => import("./commands/dev").then((m) => m.default),
    migrate: () => import("./commands/migrate").then((m) => m.default),
    seed: () => import("./commands/seed").then((m) => m.default),
    feature: () => import("./commands/feature").then((m) => m.default),
    env: () => import("./commands/env").then((m) => m.default),
    deploy: () => import("./commands/deploy").then((m) => m.default),
    upgrade: () => import("./commands/upgrade").then((m) => m.default),
    token: () => import("./commands/token").then((m) => m.default),
    dashboard: () => import("./commands/dashboard").then((m) => m.default),
    secrets: () => import("./commands/secrets").then((m) => m.default),
    email: () => import("./commands/email").then((m) => m.default),
    media: () => import("./commands/media").then((m) => m.default),
    payments: () => import("./commands/payments").then((m) => m.default),
    support: () => import("./commands/support").then((m) => m.default),
    storage: () => import("./commands/storage").then((m) => m.default),
    testers: () => import("./commands/testers").then((m) => m.default),
    vector: () => import("./commands/vector").then((m) => m.default),
    turnstile: () => import("./commands/turnstile").then((m) => m.default),
    alias: () => import("./commands/alias").then((m) => m.default),
    doctor: () => import("./commands/doctor").then((m) => m.default),
    adopt: () => import("./commands/adopt").then((m) => m.default),
  },
});
