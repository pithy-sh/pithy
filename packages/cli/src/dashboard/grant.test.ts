// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { type ControlPlaneScope, SEAM_SCOPES } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  decideGrant,
  defaultGrant,
  type GrantableScope,
  grantableScopes,
  readScopeRequest,
  resolveScopeRequest,
} from "./grant";

/** A capability that declares nothing but an admin surface — enough for the derivation to read. */
function capabilityWith(name: string, adminRoutes: AdminRoute[]): Capability {
  return { name, requiredBindings: [], adminRoutes };
}

const support = capabilityWith("support", [
  { method: "GET", path: "/support/tickets", scope: "support:tickets:read", summary: "Page the queue." },
  { method: "GET", path: "/support/tickets/:id", scope: "support:tickets:read", summary: "One ticket in full." },
  { method: "POST", path: "/support/tickets/:id/close", scope: "support:tickets:close", summary: "Close a ticket." },
]);

describe("grantableScopes", () => {
  test("classifies a scope by every route that requires it, not by the first one", () => {
    // The shape `keys:rotate` has: a listing route and a mutating one, behind one scope.
    const lifecycle = capabilityWith("lifecycle", [
      { method: "GET", path: "/l/keys", scope: "l:keys:manage", summary: "List the keys." },
      { method: "POST", path: "/l/keys", scope: "l:keys:manage", summary: "Register a key." },
    ]);

    expect(grantableScopes([lifecycle])).toEqual([
      { scope: "l:keys:manage", read: false, capability: "lifecycle", summary: "List the keys.", routes: 2 },
    ]);
  });

  test("a scope named like a read is not a read when it opens a write", () => {
    const misnamed = capabilityWith("misnamed", [
      { method: "POST", path: "/m/purge", scope: "misnamed:things:read", summary: "Purge everything." },
    ]);

    expect(grantableScopes([misnamed])[0]?.read).toBe(false);
  });

  test("an unscoped route is not grantable and is never offered", () => {
    const seam = capabilityWith("seam", [
      { method: "GET", path: "/cp/ping", scope: null, summary: "Prove connectivity." },
    ]);

    expect(grantableScopes([seam])).toEqual([]);
  });

  test("reports each scope once, in composition order, with what it opens", () => {
    expect(grantableScopes([support])).toEqual([
      { scope: "support:tickets:read", read: true, capability: "support", summary: "Page the queue.", routes: 2 },
      { scope: "support:tickets:close", read: false, capability: "support", summary: "Close a ticket.", routes: 1 },
    ]);
  });

  test("a capability with no admin surface contributes nothing", () => {
    expect(grantableScopes([capabilityWith("quiet", [])])).toEqual([]);
  });
});

describe("defaultGrant", () => {
  test("adds every declared read, so a fresh connection opens to panes that read", () => {
    const audit = capabilityWith("audit", [
      { method: "GET", path: "/audit/events", scope: "audit:events:read", summary: "Page the trail." },
    ]);

    expect(defaultGrant([audit, support])).toEqual([...SEAM_SCOPES, "audit:events:read", "support:tickets:read"]);
  });

  test("never adds a write", () => {
    const added = defaultGrant([support]).filter((scope) => !SEAM_SCOPES.includes(scope));
    expect(added).toEqual(["support:tickets:read"]);
  });

  test("with nothing composed but the seam, it is the seam's own scopes and no more", () => {
    expect(defaultGrant([])).toEqual([...SEAM_SCOPES]);
  });
});

/**
 * The gate.
 *
 * **The invariant: every scope the default grant adds beyond the seam's own opens nothing but `GET`
 * routes.** Stated over whatever the project composes rather than over a list of scope names, because a
 * list is the thing this derivation exists to delete — a capability landing a route must not be able to
 * put a write into a read default by being new.
 *
 * Run against the real composed seam as well as a hostile synthetic set, because the seam is where the
 * trap actually is: `keys:rotate` gates `GET {base}/keys` *and* two `POST`s that register and expire
 * keys. Anything classifying a scope by its listing route, or by the shape of its name, admits it.
 */
describe("a read default never grants a write", () => {
  test("across the real seam and a hostile synthetic surface", () => {
    const hostile = capabilityWith("hostile", [
      { method: "GET", path: "/h/things", scope: "hostile:things:read", summary: "List things." },
      { method: "DELETE", path: "/h/things/:id", scope: "hostile:things:read", summary: "Delete a thing." },
      { method: "POST", path: "/h/wipe", scope: "hostile:wipe:read", summary: "Wipe everything." },
      { method: "PATCH", path: "/h/thing", scope: "hostile:thing:write", summary: "Amend a thing." },
    ]);
    const composed: Capability[] = [controlplane(), hostile, support];

    const added = defaultGrant(composed).filter((scope) => !SEAM_SCOPES.includes(scope));
    const routes = composed.flatMap((capability) => capability.adminRoutes ?? []);

    for (const scope of added) {
      const opened = routes.filter((route) => route.scope === scope);
      expect(opened.length, `${scope} is granted by default but no declared route requires it`).toBeGreaterThan(0);
      expect(
        opened.map((route) => route.method),
        `${scope} is in the read default but opens a route that is not a GET`,
      ).toEqual(opened.map(() => "GET"));
    }
    // Not vacuous — a genuine read is found and granted.
    expect(added).toContain("support:tickets:read");
    // And each trap is refused: a read name over a POST, and a read route sharing a scope with a DELETE.
    expect(added).not.toContain("hostile:wipe:read");
    expect(added).not.toContain("hostile:things:read");
  });
});

/** An audit surface: one scope per detail level, which is how the default comes to leave one out. */
const audit = capabilityWith("audit", [
  { method: "GET", path: "/audit/events", scope: "audit:events:read", summary: "Page the trail." },
  { method: "GET", path: "/audit/events/:id", scope: "audit:events:read_detail", summary: "One event, in full." },
]);

describe("readScopeRequest", () => {
  test("`all` asks for everything, and carries no names of its own", () => {
    expect(readScopeRequest(["all"])).toEqual({ all: true, scopes: [] });
  });

  test("named scopes are passed through in the order they were typed", () => {
    expect(readScopeRequest(["support:tickets:read", "keys:rotate"])).toEqual({
      all: false,
      scopes: ["support:tickets:read", "keys:rotate"],
    });
  });

  test("no --scope at all asks for nothing — the caller decides what absent means", () => {
    expect(readScopeRequest([])).toEqual({ all: false, scopes: [] });
  });

  test("`all` beside another scope is refused, naming both", () => {
    const error = ((): unknown => {
      try {
        readScopeRequest(["all", "manifest:read"]);
      } catch (thrown) {
        return thrown;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(PithyError);
    const message = (error as PithyError).payload.message;
    expect(message).toContain("--scope all");
    expect(message).toContain("--scope manifest:read");
  });

  test("the refusal does not depend on which was typed first, and names every one", () => {
    const error = ((): PithyError => {
      try {
        readScopeRequest(["manifest:read", "support:tickets:read", "all"]);
      } catch (thrown) {
        return thrown as PithyError;
      }
      throw new Error("readScopeRequest accepted `all` beside two named scopes");
    })();

    expect(error.payload.message).toContain("--scope manifest:read --scope support:tickets:read");
  });

  test("`all` twice is still `all` — it names one thing, however often", () => {
    expect(readScopeRequest(["all", "all"])).toEqual({ all: true, scopes: [] });
  });
});

describe("resolveScopeRequest", () => {
  test("a named grant is exactly what was named — `all` existing widens nothing", () => {
    const grantable = grantableScopes([controlplane(), audit, support]);

    expect(resolveScopeRequest({ all: false, scopes: ["support:tickets:read"] }, grantable)).toEqual([
      "support:tickets:read",
    ]);
  });

  test("an empty selection stays empty, rather than collapsing into a default", () => {
    expect(resolveScopeRequest({ all: false, scopes: [] }, grantableScopes([controlplane()]))).toEqual([]);
  });

  test("`all` over nothing grantable is refused, not stored as a grant of nothing", () => {
    const error = ((): PithyError => {
      try {
        resolveScopeRequest({ all: true, scopes: [] }, []);
      } catch (thrown) {
        return thrown as PithyError;
      }
      throw new Error("resolveScopeRequest resolved `all` to an empty grant");
    })();

    expect(error.payload.message).toContain("--scope all");
    expect(error.payload.action).toBeTruthy();
  });
});

/**
 * The gate.
 *
 * **The invariant: `--scope all` is every scope the prompt would render, and nothing else.** Stated
 * against frozen literals rather than against a list recomputed from the resolver, so a resolver that
 * went back to a hardcoded set — or that started filtering — fails here instead of agreeing with itself.
 *
 * The real seam is composed, not a synthetic stand-in, because the seam is what carries `keys:rotate`:
 * a resolution derived from the read default, or from anything else that classifies, would drop it.
 */
describe("--scope all resolves to the list the prompt renders", () => {
  /** The whole surface of `[controlplane(), audit, support]`, in composition order. Written out. */
  const EVERY_SCOPE = [
    "manifest:read",
    "keys:rotate",
    "audit:events:read",
    "audit:events:read_detail",
    "support:tickets:read",
    "support:tickets:close",
  ];

  test("every scope the composed Worker declares, the seam's own included", () => {
    const composed: Capability[] = [controlplane(), audit, support];

    expect(resolveScopeRequest(readScopeRequest(["all"]), grantableScopes(composed))).toEqual(EVERY_SCOPE);
  });

  test("and it is the prompt's own list — the same values, in the same order", () => {
    const composed: Capability[] = [controlplane(), audit, support];
    const rendered = grantableScopes(composed);

    expect(resolveScopeRequest({ all: true, scopes: [] }, rendered)).toEqual(rendered.map((entry) => entry.scope));
  });

  test("a capability added to the fixture is granted, with nothing in the resolver to change", () => {
    const newly = capabilityWith("newly", [
      { method: "GET", path: "/newly/things", scope: "newly:things:read", summary: "List the new things." },
      { method: "POST", path: "/newly/things", scope: "newly:things:write", summary: "Make one." },
    ]);
    const composed: Capability[] = [controlplane(), audit, support, newly];

    expect(resolveScopeRequest(readScopeRequest(["all"]), grantableScopes(composed))).toEqual([
      "manifest:read",
      "keys:rotate",
      "audit:events:read",
      "audit:events:read_detail",
      "support:tickets:read",
      "support:tickets:close",
      "newly:things:read",
      "newly:things:write",
    ]);
  });

  test("an unscoped route is no more grantable here than at the prompt — ping is absent", () => {
    expect(resolveScopeRequest(readScopeRequest(["all"]), grantableScopes([controlplane()]))).toEqual([
      "manifest:read",
      "keys:rotate",
    ]);
  });

  test("`all` does not become the default, and does not move what the prompt preselects", () => {
    const composed: Capability[] = [controlplane(), audit, support];

    // The preselection, unchanged: every read, plus the seam's pair. Written out, not derived.
    expect(defaultGrant(composed)).toEqual([
      "manifest:read",
      "keys:rotate",
      "audit:events:read",
      "audit:events:read_detail",
      "support:tickets:read",
    ]);
    // And `all` is strictly more than that — it is why it has to be asked for.
    expect(resolveScopeRequest(readScopeRequest(["all"]), grantableScopes(composed))).toContain(
      "support:tickets:close",
    );
  });
});

/**
 * The decision itself, which is the thing `connect` was trusting a source scan to hold.
 *
 * **Every branch that decides a grant runs here, with the prompt as a seam.** The old gate counted
 * substrings in `dashboard.ts` and could not reach either line that matters: dropping `request.all`
 * from the narrowed test disconnected `--scope all` from the command entirely — stored the *default*
 * grant while the operator asked for everything, silently, exit 0, even under `--json` — and the suite
 * stayed green. So did changing what the prompt is preselected with.
 *
 * The preselection is asserted against a frozen literal rather than against `defaultGrant(composed)`
 * recomputed here: a test that derives the expected value from the same function the code calls agrees
 * with a plant that changes both.
 */
describe("decideGrant", () => {
  const composed: Capability[] = [controlplane(), audit, support];

  /** A prompt that must not be reached. Reaching it is the defect, so it says so rather than returning. */
  const unasked = (): Promise<ControlPlaneScope[]> => {
    throw new Error("the prompt was reached");
  };

  /** A prompt that answers, and records what it was handed. */
  function asked(answer: ControlPlaneScope[]): {
    prompt: (grantable: readonly GrantableScope[], preselected: ControlPlaneScope[]) => Promise<ControlPlaneScope[]>;
    seen: { offered: ControlPlaneScope[]; preselected: ControlPlaneScope[] }[];
  } {
    const seen: { offered: ControlPlaneScope[]; preselected: ControlPlaneScope[] }[] = [];
    return {
      seen,
      prompt: async (grantable, preselected) => {
        seen.push({ offered: grantable.map((entry) => entry.scope), preselected });
        return answer;
      },
    };
  }

  test("`--scope all` grants every composed scope, and never asks", async () => {
    const granted = await decideGrant({
      request: readScopeRequest(["all"]),
      composed,
      interactive: true,
      update: false,
      prompt: unasked,
    });

    expect(granted).toEqual([
      "manifest:read",
      "keys:rotate",
      "audit:events:read",
      "audit:events:read_detail",
      "support:tickets:read",
      "support:tickets:close",
    ]);
  });

  test("`--scope all` on an update grants the same, rather than leaving the grant alone", async () => {
    const granted = await decideGrant({
      request: readScopeRequest(["all"]),
      composed,
      interactive: false,
      update: true,
      prompt: unasked,
    });

    expect(granted).toContain("support:tickets:close");
  });

  test("a named grant is exactly what was named", async () => {
    const granted = await decideGrant({
      request: readScopeRequest(["support:tickets:read"]),
      composed,
      interactive: true,
      update: false,
      prompt: unasked,
    });

    expect(granted).toEqual(["support:tickets:read"]);
  });

  test("no --scope, at a terminal, on a create: it asks, preselected to the default grant", async () => {
    const { prompt, seen } = asked(["manifest:read"]);

    const granted = await decideGrant({
      request: readScopeRequest([]),
      composed,
      interactive: true,
      update: false,
      prompt,
    });

    expect(granted).toEqual(["manifest:read"]);
    // Every read, plus the seam's pair — written out, so widening the preselection fails here.
    expect(seen[0]?.preselected).toEqual([
      "manifest:read",
      "keys:rotate",
      "audit:events:read",
      "audit:events:read_detail",
      "support:tickets:read",
    ]);
    // And the list it offered is the whole surface, which is what `all` resolves to.
    expect(seen[0]?.offered).toEqual([
      "manifest:read",
      "keys:rotate",
      "audit:events:read",
      "audit:events:read_detail",
      "support:tickets:read",
      "support:tickets:close",
    ]);
  });

  test("an empty answer at the prompt stays empty, rather than collapsing into the default", async () => {
    const { prompt } = asked([]);

    expect(
      await decideGrant({ request: readScopeRequest([]), composed, interactive: true, update: false, prompt }),
    ).toEqual([]);
  });

  test("no --scope on an update leaves the grant alone, and never asks", async () => {
    expect(
      await decideGrant({ request: readScopeRequest([]), composed, interactive: true, update: true, prompt: unasked }),
    ).toBeUndefined();
  });

  test("no --scope with no terminal leaves the grant alone, and never asks", async () => {
    expect(
      await decideGrant({
        request: readScopeRequest([]),
        composed,
        interactive: false,
        update: false,
        prompt: unasked,
      }),
    ).toBeUndefined();
  });
});
