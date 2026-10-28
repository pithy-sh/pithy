// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AdminOperation } from "../controlPlane/discovery/adminRoute";
import { inputOf } from "../controlPlane/discovery/routeInput";
import { controlPlaneToolName } from "../controlPlane/discovery/toolName";
import { ValidationError } from "../error/pithyError";
import { type RouteSpec, routeSpecOf, type ToolEffect } from "../http/routeSpec";
import type { RouteGroup } from "../openapi/document";
import { isMiddlewareOnly, operationsOf } from "../openapi/operations";
import { KIND_SENTENCES, kindAnnotations, type ToolAnnotations } from "./annotations";

/**
 * The app's own MCP tools, read off the composed router (`docs/AGENT-ACCESS.md` §4.1, §5).
 *
 * **The route declarations are already a tool list.** A route that opts in with `describeRoute({ tool })` carries
 * everything a tool definition needs: the `summary` an agent chooses on, a `description` for what the schemas do not
 * say, the `power` that gates it, the `scopes` a caller must carry, and an `operation` that names it. Its input is
 * the route's own `validate(...)` schemas, in the same `{ path, query, body }` shape the control-plane server's tools
 * take. Nothing is written twice: a route that changes its body, its power or its summary changes its tool on the
 * same commit.
 *
 * **A tool inherits its route's power. That is the whole mapping**, and there is no tool-to-role table to maintain.
 */

/** One route, as a tool. */
export interface AppTool {
  /** `<capability>_<operation>`, through the control-plane server's normalizer. */
  readonly name: string;
  /** The capability that registered the route — the unit of consent. */
  readonly capability: string;
  /** The route's declared operation. */
  readonly operation: string;
  /** The HTTP method a call dispatches with. */
  readonly method: string;
  /** The mounted path a call dispatches to, Hono's spelling. */
  readonly path: string;
  /** The route's summary, in its capability's own words. What the consent screen lists. */
  readonly summary: string;
  /** What an agent reads: the summary, the route's description, and its effect said aloud. */
  readonly description: string;
  /** The route's input as JSON Schema. */
  readonly inputSchema: Record<string, unknown>;
  /** What the tool does beyond reading, or `null` for a read. */
  readonly effect: ToolEffect | null;
  /** The MCP annotations its effect sets. */
  readonly annotations: ToolAnnotations;
  /** The power the caller's role must hold, or `undefined` when the route declares none. */
  readonly power: string | undefined;
  /** The attestation scopes a caller must carry, from `describeRoute({ scopes })`. */
  readonly scopes: readonly string[];
}

/** What each effect says in a tool's description and on the consent screen. One sentence each. */
export const EFFECT_SENTENCES: Readonly<Record<ToolEffect, string>> = {
  writes: KIND_SENTENCES.writes,
  sends: KIND_SENTENCES.sends,
  charges: KIND_SENTENCES.charges,
  deletes: KIND_SENTENCES.deletes,
};

/** The MCP annotations for an effect. `null` is a read. */
export function toolAnnotations(effect: ToolEffect | null): ToolAnnotations {
  return kindAnnotations(effect ?? "reads");
}

/** One described route that opted in, before it is a tool. */
interface Declared {
  readonly capability: string;
  readonly method: string;
  readonly path: string;
  readonly spec: RouteSpec;
  readonly handlers: readonly unknown[];
}

/** Every described route in these groups, with the method it is mounted under. */
function described(groups: readonly RouteGroup[]): Declared[] {
  return groups.flatMap((group) =>
    operationsOf(group.routes)
      .filter((operation) => !isMiddlewareOnly(operation))
      .flatMap((operation) => {
        const spec = operation.handlers.map(routeSpecOf).find((candidate) => candidate !== undefined);
        return spec === undefined
          ? []
          : [
              {
                capability: group.tag,
                method: operation.method.toUpperCase(),
                path: operation.path,
                spec,
                handlers: operation.handlers,
              },
            ];
      }),
  );
}

function refuse(message: string, detail: string): never {
  throw new ValidationError({
    message,
    action:
      "Fix the route's describeRoute({ operation, tool }). A GET opts in with `tool: true`; any other method declares `tool: { effect }`.",
    detail,
  });
}

/**
 * Refuse a composition whose tool declarations are wrong, naming the route.
 *
 * **This is where "it does not compile" is enforced.** `describeRoute` cannot see the method it is mounted under, so
 * a `POST` saying `tool: true` type-checks; `createBackend` calls this at assembly, so the Worker refuses to boot
 * and the kit's own composition fails its tests. Five checks: a non-`GET` opting in without an effect, a `GET`
 * declaring one, a tool with no operation, an operation outside the published alphabet, and two routes sharing an
 * operation within a capability — or two capabilities whose names normalize to one tool.
 */
export function assertToolDeclarations(groups: readonly RouteGroup[]): void {
  const operations = new Map<string, string>();
  const names = new Map<string, string>();
  for (const route of described(groups)) {
    const where = `${route.method} ${route.path}`;
    const { operation, tool } = route.spec;
    if (operation !== undefined) {
      if (!AdminOperation.safeParse(operation).success) {
        refuse(
          `The operation "${operation}" on ${where} is not a valid name.`,
          `capability ${route.capability} route ${where} declares operation "${operation}"; an operation is lowercase words joined by ".", "_" or "-"`,
        );
      }
      const key = `${route.capability} ${operation}`;
      const earlier = operations.get(key);
      if (earlier !== undefined) {
        refuse(
          `Two ${route.capability} routes declare the operation "${operation}".`,
          `${earlier} and ${where} both declare operation "${operation}" in capability ${route.capability}`,
        );
      }
      operations.set(key, where);
    }
    if (tool === undefined) continue;
    if (operation === undefined) {
      refuse(
        `${where} opts in as a tool with no operation.`,
        `capability ${route.capability} route ${where} declares tool but no operation, so its tool has no name`,
      );
    }
    if (route.method !== "GET" && tool === true) {
      refuse(
        `${where} opts in as a tool without an effect.`,
        `capability ${route.capability} route ${where} is not a GET, so it must declare tool: { effect } (writes, sends, charges or deletes)`,
      );
    }
    if (route.method === "GET" && tool !== true) {
      refuse(
        `${where} is a read and declares an effect.`,
        `capability ${route.capability} route ${where} is a GET; a GET opts in with tool: true`,
      );
    }
    const name = controlPlaneToolName(route.capability, operation);
    const clash = names.get(name);
    if (clash !== undefined) {
      refuse(`Two routes are both the tool ${name}.`, `${clash} and ${where} both normalize to the tool name ${name}`);
    }
    names.set(name, where);
  }
}

/** The description an agent reads: the summary, the route's own description, and its effect. */
function descriptionOf(spec: RouteSpec, effect: ToolEffect | null): string {
  return [spec.summary, spec.description, effect === null ? undefined : EFFECT_SENTENCES[effect]]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ");
}

/** Every tool these groups declare, in registration order. Refuses a wrong declaration first. */
export function appTools(groups: readonly RouteGroup[]): AppTool[] {
  assertToolDeclarations(groups);
  return described(groups).flatMap((route): AppTool[] => {
    const { spec } = route;
    if (spec.tool === undefined || spec.operation === undefined) return [];
    const effect = spec.tool === true ? null : spec.tool.effect;
    return [
      {
        name: controlPlaneToolName(route.capability, spec.operation),
        capability: route.capability,
        operation: spec.operation,
        method: route.method,
        path: route.path,
        summary: spec.summary,
        description: descriptionOf(spec, effect),
        inputSchema: inputOf(route.handlers),
        effect,
        annotations: toolAnnotations(effect),
        power: spec.power,
        scopes: spec.scopes ?? [],
      },
    ];
  });
}

/** What a caller holds, for {@link offeredTools}. */
export interface ToolCaller {
  /** Whether the caller's role holds a power, or `null` when no organization is in force — nothing is held. */
  readonly roleAllows: ((power: string) => boolean) | null;
  /** The attestation scopes the caller carries. */
  readonly scopes: readonly string[];
}

/** Whether this caller may call this tool, by exactly the checks its route makes. */
export function mayCall(tool: AppTool, caller: ToolCaller): boolean {
  if (tool.power !== undefined && (caller.roleAllows === null || !caller.roleAllows(tool.power))) return false;
  return tool.scopes.every((scope) => caller.scopes.includes(scope));
}

/**
 * The tools this caller may call. **A tool a role withholds is absent, not locked**: offering it discloses that it
 * exists and spends a call to learn what the answer would be (`docs/AGENT-ACCESS.md` §4.1).
 */
export function offeredTools(tools: readonly AppTool[], caller: ToolCaller): AppTool[] {
  return tools.filter((tool) => mayCall(tool, caller));
}
