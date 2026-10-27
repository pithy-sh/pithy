// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * **The pages state what the routes do (#673).** `plan-and-limits.md` is the page an adopter prices from, and
 * `credential-helper.md` is the one an owner reads when a collaborator goes bad. Each claim here is checked against
 * `routes.ts` itself, so a route that starts calling the binding, or a break-glass that moves, fails this.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");
const ROUTES = read("../http/routes.ts");
const PLAN = read("../../docs/plan-and-limits.md");
const HELPER = read("../../docs/credential-helper.md");

/** The source of one route registration, from its `app.<method>(` to the next one. */
function route(method: string, path: string): string {
  const blocks = ROUTES.split(/\n\s*app\.(?=(?:get|post|delete|put|patch)\()/);
  const block = blocks.find((b) => b.startsWith(`${method}(`) && b.includes(`\`\${base}${path}\`,`));
  if (!block) throw new Error(`routes.ts registers no ${method.toUpperCase()} ${path}.`);
  return block;
}

const callsTheBinding = (block: string) => /\bwithRepo\(|\bbinding\.|\bcreate\(c,/.test(block);

describe("plan-and-limits.md prices what the routes call", () => {
  const d1Only: [string, string][] = [
    ["get", "/repos"],
    ["get", "/organization/repos"],
    ["post", "/repos/:name/grants"],
    ["delete", "/repos/:name/grants/:userId"],
  ];

  test.each(d1Only)("%s %s never reaches the binding", (method, path) => {
    expect(callsTheBinding(route(method, path))).toBe(false);
  });

  test("the page says the list and grant routes never reach Cloudflare", () => {
    expect(PLAN).toMatch(/`GET \/repos` and `GET \/organization\/repos`/);
    expect(PLAN).toMatch(/set or remove a grant read and write D1 only/);
    expect(PLAN).not.toMatch(/Every route here is at least one operation/);
  });

  test("a mint opens the repository, then mints and reads its remote: three calls", () => {
    const mint = route("post", "/repos/:name/credentials");
    expect(mint).toMatch(/withRepo\(/);
    expect(mint).toMatch(/createToken\(/);
    expect(mint).toMatch(/\.info\(\)/);
    expect(PLAN).toMatch(/A mint is three: open, the token, and the repository's remote\./);
  });

  test("revoking every token counts a revoke per recorded token, then a list per page", () => {
    const breakGlass = route("delete", "/repos/:name/credentials");
    expect(breakGlass).toMatch(/unexpiredTokenIds\(/);
    expect(breakGlass).toMatch(/revokeEveryToken\(repo, recorded\)/);
    expect(PLAN).toMatch(
      /Revoking every token is open, then one revoke for each token the kit recorded that has not yet expired, then a list and a revoke for each live token it still shows, repeated until a list shows none live or a round revokes none\./,
    );
    expect(PLAN).toMatch(
      /With every recorded token revoked and nothing else live, that is open, one call per recorded token and one list\./,
    );
    expect(PLAN).not.toMatch(/assumes the list/);
  });
});

describe("credential-helper.md names the break-glass", () => {
  test("DELETE /repos/:name/credentials revokes every token, for the owner only", () => {
    const breakGlass = route("delete", "/repos/:name/credentials");
    expect(breakGlass).toMatch(/requireOwner\(/);
    expect(breakGlass).toMatch(/revokeEveryToken/);
  });

  test("the page sends an owner to it beside both statements of the revocation window", () => {
    const named = HELPER.match(/`DELETE \/artifacts\/repos\/<name>\/credentials`/g) ?? [];
    expect(named.length).toBeGreaterThanOrEqual(2);
    const why = HELPER.split(/^## Why the token is short$/m)[1]?.split(/^## /m)[0] ?? "";
    expect(why).toMatch(/DELETE \/artifacts\/repos\/<name>\/credentials/);
  });
});
