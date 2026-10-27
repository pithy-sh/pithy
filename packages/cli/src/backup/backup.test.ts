// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultBackupDir, folderNames } from "./backup";

/** The names `pithy backup` gives what it writes, when nobody names them (#848). */

describe("defaultBackupDir", () => {
  test("backups/<env>-<timestamp>, to the second, with no colon a filesystem or a shell would trip on", () => {
    expect(defaultBackupDir("prod", new Date("2026-10-27T12:00:00.123Z"))).toBe(
      join("backups", "prod-2026-10-27T12-00-00Z"),
    );
  });
});

describe("folderNames", () => {
  test("the binding, when no other database in scope shares it", () => {
    expect(
      folderNames([
        { binding: "DB", database: "app", target: "a" },
        { binding: "EMAIL_DB", database: "mail", target: "b" },
      ]),
    ).toEqual(["DB", "EMAIL_DB"]);
  });

  test("the binding and the database, when two Workers bind two databases to one binding", () => {
    expect(
      folderNames([
        { binding: "DB", database: "app", target: "a" },
        { binding: "DB", database: "mail", target: "b" },
      ]),
    ).toEqual(["DB-app", "DB-mail"]);
  });

  test("the id too, when those two databases share a name, so no folder is written twice", () => {
    expect(
      folderNames([
        { binding: "DB", database: "app", target: "a" },
        { binding: "DB", database: "app", target: "b" },
        { binding: "COLLAB_DB", database: "collab", target: "c" },
      ]),
    ).toEqual(["DB-app-a", "DB-app-b", "COLLAB_DB"]);
  });
});
