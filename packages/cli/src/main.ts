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
    migrate: () => import("./commands/migrate").then((m) => m.default),
    deploy: () => import("./commands/deploy").then((m) => m.default),
    secrets: () => import("./commands/secrets").then((m) => m.default),
    email: () => import("./commands/email").then((m) => m.default),
    turnstile: () => import("./commands/turnstile").then((m) => m.default),
  },
});
