// pithy.config.ts — your project's identity and policy.
//
// This file is project-wide. It deliberately does NOT list capabilities: what a
// Worker is made of is per-Worker, and lives in apps/<name>/pithy.config.ts.
// Only settings that cannot be per-Worker belong here.

const config = {
  // The project name, and the first segment of every name Pithy provisions:
  // <project>-<env>-<thing>, kebab-case, one rule for every namespace — D1, KV,
  // R2, Worker scripts, Workflows, Secrets Store entries, and Cloudflare API
  // tokens. A thing shared across environments puts the literal `global` in the
  // environment slot. Feature resources extend the same shape
  // (<project>-f<issue>-<slug>-<binding>-<kind>).
  //
  // Cloudflare's namespaces are flat and account-wide, so this segment is the
  // only thing keeping two projects in one account from adopting each other's
  // resources — and it is the only key teardown has to find them by. Renaming it
  // does not rename anything already provisioned: it orphans it, silently. Set it
  // once, keep it stable across machines and checkouts, and don't rename it.
  // `pithy doctor` checks that it still matches what your workers declare.
  name: "pithy-app",

  // Every environment this project deploys to, in the order provisioning walks
  // them — least-production first. It is the SECOND segment of every Cloudflare
  // name the project composes (<project>-<env>-<thing>), the set `pithy secrets
  // provision` gives a master key and a manager to, and the set each Worker's
  // `env.<name>` wrangler stanzas are generated from. `dev` is never listed: it
  // is local, it is the top-level wrangler stanza, and it always exists.
  //
  // Absent means ["staging", "prod"], which is what `pithy init` scaffolds
  // unless you told it otherwise. Like `name`, this is effectively permanent:
  // renaming an environment does not rename anything already provisioned under
  // the old name — it orphans it. `pithy doctor` reports a change rather than
  // applying one.
  // environments: ["staging", "prod"],

  // Which Cloudflare account this project belongs to. `pithy init` writes this
  // block when it can discover the account from your token.
  //
  // `accountName` selects the credentials file: <config>/cloudflare.<name>.json
  // rather than <config>/cloudflare.json. One machine, several companies, one
  // file each — without it every project on the machine reads the same file, so
  // switching accounts means editing that file in place and every project
  // silently follows. A bare token: lowercase, digits, single hyphens. It
  // becomes a file name, so nothing else is accepted.
  //
  // `accountId` pins the account those credentials must belong to. Every command
  // that resolves them compares the two and refuses on a mismatch, naming both.
  // The nickname above means whatever each machine says it means; this is what
  // makes the repository the authority. An account id is an identifier, not a
  // secret — wrangler.toml commits them — so it is safe here, including in a
  // public repository. Optional, and it earns its keep the moment more than one
  // person deploys.
  // cloudflare: { accountName: "acme", accountId: "" },

  // Overrides for the predefined Cloudflare API token profiles (`pithy token`).
  // Account-level, so it lives here rather than on a Worker.
  // tokens: { overrides: {} },

  // `pithy seed` policy. `productionEnvironments` names every environment this
  // project treats as production, beyond the built-in production/prod — each one
  // requires the type-to-confirm phrase, not just --yes. A safety rule no single
  // Worker should be able to quietly omit.
  // seed: { includeExamples: false, productionEnvironments: ["live"] },
};

export default config;
