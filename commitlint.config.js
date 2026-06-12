import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Scope allowlist is hybrid: package short-names auto-derived from the workspace
// manifests (so a new package needs no edit here) plus a fixed non-package set.
// Scopeless commits stay legal for repo-wide changes — scope-enum only constrains
// a scope that is present.
//
// Resolve workspace dirs against this file's own location, not process.cwd():
// commitlint may be invoked from a subdirectory, and a cwd-relative lookup would
// silently collapse the derived scopes to nothing.
const workspaceDirs = ["packages", "tooling", "apps"].map((dir) => join(import.meta.dirname, dir));

const packageScopes = workspaceDirs.flatMap((dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, "package.json"))
    .filter(existsSync)
    .map((manifest) => JSON.parse(readFileSync(manifest, "utf8")).name)
    .filter((name) => typeof name === "string")
    .map((name) => name.replace(/^@pithy-sh\//, ""));
});

const fixedScopes = ["ci", "repo", "deps", "release", "brand", "templates"];

const scopes = [...new Set([...packageScopes, ...fixedScopes])];

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", scopes],
  },
};
