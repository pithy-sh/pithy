// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { negotiateSubprotocol } from "./subprotocol";

const FIRST = { current: "pithy.game.v1", previous: null };
const SECOND = { current: "pithy.game.v2", previous: "pithy.game.v1" };

describe("negotiateSubprotocol", () => {
  test("picks the current version when it is offered, whatever else is", () => {
    expect(negotiateSubprotocol("pithy.game.v1", FIRST)).toBe("pithy.game.v1");
    expect(negotiateSubprotocol("other, pithy.game.v2 , pithy.game.v1", SECOND)).toBe("pithy.game.v2");
  });

  test("serves the previous version to a client that offers only that", () => {
    expect(negotiateSubprotocol("pithy.game.v1", SECOND)).toBe("pithy.game.v1");
  });

  test("an unversioned client is the previous version of the first versioned protocol", () => {
    expect(negotiateSubprotocol(undefined, FIRST)).toBeNull();
    expect(negotiateSubprotocol("", FIRST)).toBeNull();
    expect(negotiateSubprotocol(" , ", FIRST)).toBeNull();
  });

  test("once two versions exist, an unversioned client is two behind, and refused", () => {
    expect(() => negotiateSubprotocol(undefined, SECOND)).toThrow(PithyError);
  });

  test("a client offering only versions this Worker does not serve is refused, naming what it does", () => {
    try {
      negotiateSubprotocol("pithy.game.v9", FIRST);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const payload = (error as PithyError).payload;
      expect(payload.code).toBe("validation/invalid_input");
      expect(payload.status).toBe(400);
      expect(payload.message).toBe(
        "This socket speaks pithy.game.v1, or no subprotocol. The client offered pithy.game.v9.",
      );
    }
  });
});
