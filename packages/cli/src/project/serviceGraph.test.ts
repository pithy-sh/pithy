// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  bindingKindPhrase,
  closesLoop,
  defaultServiceBinding,
  dependencyOrder,
  loopSentence,
  renderPath,
  type ServiceEdge,
  serviceLoops,
} from "./serviceGraph";

/** `from -> to`, under the default binding name. */
function edge(from: string, to: string): ServiceEdge {
  return { from, to, binding: defaultServiceBinding(to) };
}

describe("defaultServiceBinding", () => {
  test("is the target in upper snake case", () => {
    expect(defaultServiceBinding("app-b")).toBe("APP_B");
    expect(defaultServiceBinding("email")).toBe("EMAIL");
    expect(defaultServiceBinding("admin-api-2")).toBe("ADMIN_API_2");
  });
});

describe("closesLoop", () => {
  test("a new edge back along an existing one closes a two-Worker loop, printed from the target", () => {
    expect(closesLoop([edge("app-a", "app-b")], "app-b", "app-a")).toEqual(["app-a", "app-b", "app-a"]);
  });

  test("a longer loop prints its whole path", () => {
    const edges = [edge("app-a", "app-b"), edge("app-b", "app-c")];
    expect(closesLoop(edges, "app-c", "app-a")).toEqual(["app-a", "app-b", "app-c", "app-a"]);
  });

  test("an edge that closes nothing is null", () => {
    const edges = [edge("app-a", "app-b"), edge("app-b", "app-c")];
    expect(closesLoop(edges, "app-a", "app-c")).toBeNull();
    expect(closesLoop(edges, "app-d", "app-a")).toBeNull();
  });

  test("a self edge already declared is ignored, because the self binding is #616's", () => {
    expect(closesLoop([edge("app-a", "app-a")], "app-b", "app-a")).toBeNull();
  });
});

describe("serviceLoops", () => {
  test("no loops is empty", () => {
    expect(serviceLoops([edge("app-a", "app-b"), edge("app-b", "email")])).toEqual([]);
  });

  test("each loop once, starting from its smallest name, closed on itself", () => {
    const loops = serviceLoops([edge("app-b", "app-a"), edge("app-a", "app-b"), edge("app-c", "app-d")]);
    expect(loops).toEqual([["app-a", "app-b", "app-a"]]);
  });

  test("a three-Worker loop prints the full path", () => {
    const loops = serviceLoops([edge("app-a", "app-b"), edge("app-b", "app-c"), edge("app-c", "app-a")]);
    expect(loops).toEqual([["app-a", "app-b", "app-c", "app-a"]]);
  });

  test("self edges are not loops here", () => {
    expect(serviceLoops([edge("app-a", "app-a")])).toEqual([]);
  });
});

describe("renderPath and loopSentence", () => {
  test("the arrow rendering both the command and doctor print", () => {
    expect(renderPath(["app-a", "app-b", "app-a"])).toBe("app-a -> app-b -> app-a");
    expect(loopSentence("app-b", "app-a", ["app-a", "app-b", "app-a"])).toBe(
      "app-b -> app-a closes a loop: app-a -> app-b -> app-a.",
    );
  });
});

describe("dependencyOrder", () => {
  test("a binding's target comes before the Worker that binds it", () => {
    const order = dependencyOrder(["app-a", "app-b", "app-c"], [edge("app-a", "app-c"), edge("app-c", "app-b")]);
    expect(order).toEqual(["app-b", "app-c", "app-a"]);
  });

  test("Workers with no bindings keep their order", () => {
    expect(dependencyOrder(["b", "a", "c"], [])).toEqual(["b", "a", "c"]);
  });

  test("a loop does not lose a Worker", () => {
    const order = dependencyOrder(["app-a", "app-b"], [edge("app-a", "app-b"), edge("app-b", "app-a")]);
    expect([...order].sort()).toEqual(["app-a", "app-b"]);
  });

  test("an edge to something outside the set is ignored", () => {
    expect(dependencyOrder(["app-a"], [edge("app-a", "email")])).toEqual(["app-a"]);
  });
});

describe("bindingKindPhrase", () => {
  test("names the resource a binding already holds", () => {
    expect(bindingKindPhrase({ type: "d1", name: "DB" })).toBe("a D1 database");
    expect(bindingKindPhrase({ type: "kv", name: "CACHE" })).toBe("a KV namespace");
    expect(bindingKindPhrase({ type: "service", name: "APP_C", service: "app-c" })).toBe("app-c");
  });
});
