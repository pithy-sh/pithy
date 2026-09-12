// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * **D1 enforces foreign keys, and this is where that stops being something somebody remembers.**
 *
 * Three of this kit's migrations told the reader the opposite — *"D1 does not enforce them, so declaring
 * them would be documentation pretending to be a constraint"* — and gave it as the reason every
 * capability omits them (`#569`). The convention is defensible; the reason was false, and a false reason
 * is worse than none because it ends the conversation.
 *
 * What the convention actually trades is a boundary: a constraint from one capability's table to
 * another's binds two release cadences together and breaks the day either moves to its own database.
 * That argument survives this measurement. The platform one does not.
 *
 * **Both directions, because they can fail separately.** A `PRAGMA` reporting `1` is not enforcement,
 * and a refused insert does not prove a cascade runs. The two cases below are the two halves.
 *
 * **If this goes red, read it carefully before editing a migration.** It means one of two things, and
 * they call for opposite responses: D1 changed and the kit's tables are now relying on writers for
 * something they used to get for free, or the pool's configuration drifted and the suite is measuring
 * something other than production. Neither is fixed by deleting the test.
 */

const PARENT = "pithy_fk_probe_parent";
const CHILD = "pithy_fk_probe_child";

async function drop(): Promise<void> {
  await env.DB.prepare(`drop table if exists ${CHILD}`).run();
  await env.DB.prepare(`drop table if exists ${PARENT}`).run();
}

beforeEach(async () => {
  await drop();
  await env.DB.prepare(`create table ${PARENT} (id text primary key)`).run();
  await env.DB.prepare(
    `create table ${CHILD} (id text primary key, parentId text not null references ${PARENT}(id) on delete cascade)`,
  ).run();
  await env.DB.prepare(`insert into ${PARENT} (id) values ('p')`).run();
});

afterEach(drop);

describe("what D1 does with a declared foreign key", () => {
  test("the pragma is on", async () => {
    const { results } = await env.DB.prepare("pragma foreign_keys").all<{ foreign_keys: number }>();
    expect(results[0]?.foreign_keys).toBe(1);
  });

  test("a cascade actually removes the child", async () => {
    await env.DB.prepare(`insert into ${CHILD} (id, parentId) values ('c', 'p')`).run();
    await env.DB.prepare(`delete from ${PARENT} where id = 'p'`).run();
    const { results } = await env.DB.prepare(`select count(*) as n from ${CHILD}`).all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
  });

  test("an orphan is refused rather than written", async () => {
    // The half a cascade does not prove. A database that cascaded but accepted orphans would leave the
    // constraint half-true, which is the worst of the three states to be in.
    await expect(env.DB.prepare(`insert into ${CHILD} (id, parentId) values ('x', 'nobody')`).run()).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  test("and the probe is measuring a real constraint, not an empty table", async () => {
    // Anti-vacuity. A child that never inserted would satisfy the cascade case by having nothing to
    // remove, and the refusal case by refusing everything.
    await env.DB.prepare(`insert into ${CHILD} (id, parentId) values ('c', 'p')`).run();
    const { results } = await env.DB.prepare(`select count(*) as n from ${CHILD}`).all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });
});
