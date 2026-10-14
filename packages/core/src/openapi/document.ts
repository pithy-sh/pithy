// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Hono } from "hono";
import { z } from "zod";
import { CONTROL_PLANE_HEADER } from "../controlPlane/wire";
import { pathParams } from "../http/routeContract";
import { type DocumentedMethod, type RouteResponse, type RouteSpec, routeSpecOf } from "../http/routeSpec";
import { type RequestContract, requestContractOf } from "../http/validation";
import type { VerificationStrategy } from "../http/verification";

/**
 * **The OpenAPI contract, read off a composed app.**
 *
 * Nothing here is written by hand. A route's request schemas come from its `validate` middleware, its
 * summary, verification and responses from its `describeRoute`, and both are found by walking
 * `app.routes` — the same table Hono dispatches from. So the document describes exactly what the Worker
 * serves, the adopter's own routes included, and a schema edit reaches it with no second step.
 *
 * Zod is already the source of truth for every request and response, and every field carries a
 * `.describe()` (CLAUDE.md §Zod). `z.toJSONSchema` keeps those descriptions, which is what lets a client
 * generated in Swift or Kotlin carry the same documentation as the TypeScript one.
 *
 * OpenAPI 3.1, whose schema dialect is JSON Schema 2020-12 — the dialect `z.toJSONSchema` writes — so
 * every schema crosses unchanged.
 */

/** The OpenAPI version this module writes. */
export const OPENAPI_VERSION = "3.1.0";

/** One entry of a Hono app's route table: a method, a path and one handler. */
export type RouterRoute = Hono["routes"][number];

/** One capability's routes, as registered by its `routes` hook. Becomes one tag. */
export interface RouteGroup {
  /** The tag, normally the capability's name. */
  readonly tag: string;
  /** What the capability does, for the tag's description. */
  readonly description?: string;
  /** The routes it registered, in registration order. */
  readonly routes: readonly RouterRoute[];
}

/** The document's `info` block. */
export interface ContractInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

/** A JSON Schema object, as `z.toJSONSchema` writes one. */
export type JsonSchema = Record<string, unknown>;

/** The subset of an OpenAPI 3.1 document this module writes. */
export interface OpenApiDocument {
  openapi: string;
  info: ContractInfo;
  tags: { name: string; description?: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, JsonSchema>;
    responses: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

/** A route that registered no `describeRoute`, so the contract can say nothing true about it. */
export interface UndescribedRoute {
  readonly method: string;
  readonly path: string;
}

/**
 * The wire body of every error a route returns, whatever its status: `pithyErrorHandler` renders
 * `{ error: clientError(payload) }`. The payload's own schema is a union over every kit code, which
 * would put several hundred variants into each operation, so the contract describes the envelope and
 * names the code list's home instead.
 */
export const ErrorBody = z
  .object({
    error: z
      .object({
        code: z
          .string()
          .describe(
            "Namespaced `domain/reason`, e.g. `auth/invalid_token`. Stable: a client switches on it. The full list is `pithy schema --json`'s `errorCodes`.",
          ),
        status: z.number().int().describe("The HTTP status, repeated in the body."),
        message: z
          .string()
          .describe("English, for a person. A client that translates renders its own wording for `code` instead."),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Values a translating client interpolates into its own wording for `code`."),
        issues: z
          .array(z.unknown())
          .optional()
          .describe("For `validation/invalid_input`: one entry per field that failed, with its path."),
      })
      .describe("The public error payload. Never carries the operator's remedy or internal detail."),
  })
  .describe("The body of every error response.");
export type ErrorBody = z.infer<typeof ErrorBody>;

/** How each verification strategy is presented on the wire. `signed-webhook` and `public` have no scheme. */
const SECURITY_SCHEMES: Record<string, unknown> = {
  bearer: {
    type: "http",
    scheme: "bearer",
    description: "A short-lived access token from `@pithy-sh/auth`, sent as `Authorization: Bearer <token>`.",
  },
  session: {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description:
      "A browser session cookie from `@pithy-sh/auth`, named `__Secure-better-auth.session_token` over HTTPS. A state-changing request also needs its `Origin` to be one the Worker trusts.",
  },
  controlPlane: {
    type: "apiKey",
    in: "header",
    name: CONTROL_PLANE_HEADER,
    description: "A customer-issued, scoped control-plane credential. Default-denied.",
  },
};

/** The `security` requirement for each strategy that has one. */
const REQUIREMENT: Partial<Record<VerificationStrategy, Record<string, string[]>>> = {
  bearer: { bearer: [] },
  session: { session: [] },
  "control-plane": { controlPlane: [] },
  public: {},
};

const ERROR_RESPONSE = "Error";

/** Hono's `/a/:id{[0-9]+}/*` as OpenAPI's `/a/{id}/{path}`. */
export function openApiPath(path: string): string {
  return path
    .replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g, "{$1}")
    .replace(/\/\*$/, "/{path}")
    .replace(/\*/g, "{path}");
}

/**
 * `get` + `/leaderboard/{board}/top` → `getLeaderboardByBoardTop`. A parameter reads as `By<Name>`, so
 * `/items/{id}` and `/items/id` do not meet. Stable, but not unique on its own — `/a-b` and `/a/b` still
 * share one — so {@link openApiDocument} numbers a repeat rather than writing an invalid document.
 */
export function operationId(method: string, path: string): string {
  const words = path
    .split("/")
    .flatMap((segment) => {
      const param = /^\{(.+)\}$/.exec(segment);
      return param ? ["by", ...(param[1] ?? "").split(/[^A-Za-z0-9]+/)] : segment.split(/[^A-Za-z0-9]+/);
    })
    .filter((word) => word.length > 0)
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`);
  return `${method.toLowerCase()}${words.join("")}`;
}

/** A Zod schema as JSON Schema, without the `$schema` key OpenAPI does not want inside a document. */
function jsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
  return rest;
}

/** One route's handlers, grouped by method and path the way Hono stores them: one entry per handler. */
interface Operation {
  readonly method: string;
  readonly path: string;
  readonly handlers: unknown[];
}

function operationsOf(routes: readonly RouterRoute[]): Operation[] {
  const byKey = new Map<string, Operation>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const entry = byKey.get(key) ?? { method: route.method, path: route.path, handlers: [] };
    entry.handlers.push(route.handler);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

/**
 * An `ALL` entry with no spec is `app.use` — middleware, not a route — because Hono records both as
 * `ALL`. An `app.all` route that forgot its `describeRoute` is therefore invisible to the coverage
 * check, which is the one blind spot here; the kit has one such route and it is described.
 */
function isMiddlewareOnly(operation: Operation): boolean {
  return operation.method === "ALL" && !operation.handlers.some((handler) => routeSpecOf(handler));
}

/** Every route in these groups that registered no `describeRoute`. Empty is the contract being met. */
export function undescribedRoutes(groups: readonly RouteGroup[]): UndescribedRoute[] {
  return groups.flatMap((group) =>
    operationsOf(group.routes)
      .filter((operation) => !isMiddlewareOnly(operation))
      .filter((operation) => !operation.handlers.some((handler) => routeSpecOf(handler)))
      .map(({ method, path }) => ({ method, path })),
  );
}

/** The parameters one validator contributes: one per property of its object schema. */
function parametersOf(contract: RequestContract): Record<string, unknown>[] {
  const location = { param: "path", query: "query", header: "header", cookie: "cookie" }[contract.target as string];
  if (location === undefined) return [];
  const schema = jsonSchema(contract.schema, "input");
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: location,
      required: location === "path" || required.has(name),
      ...(typeof description === "string" ? { description } : {}),
      schema: rest,
    };
  });
}

/** The request body one validator contributes, if it reads the body. */
function requestBodyOf(contract: RequestContract): Record<string, unknown> | undefined {
  const media = { json: "application/json", form: "multipart/form-data" }[contract.target as string];
  if (media === undefined) return undefined;
  const schema = jsonSchema(contract.schema, "input");
  return {
    required: !contract.schema.safeParse(undefined).success,
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    content: { [media]: { schema } },
  };
}

function isZodSchema(value: z.ZodType | RouteResponse): value is z.ZodType {
  return value instanceof z.ZodType;
}

/** One `responses` entry. A bare schema is a JSON body; a {@link RouteResponse} says what it is. */
function responseOf(declared: z.ZodType | RouteResponse): Record<string, unknown> {
  if (isZodSchema(declared)) {
    const schema = jsonSchema(declared, "input");
    return {
      description: typeof schema.description === "string" ? schema.description : "Success.",
      content: { "application/json": { schema } },
    };
  }
  const media = declared.contentType ?? (declared.schema ? "application/json" : undefined);
  return {
    description: declared.description,
    ...(media === undefined
      ? {}
      : { content: { [media]: { schema: declared.schema ? jsonSchema(declared.schema, "input") : {} } } }),
  };
}

function strategiesOf(spec: RouteSpec): readonly VerificationStrategy[] {
  return typeof spec.verification === "string" ? [spec.verification] : spec.verification;
}

/** One OpenAPI operation for a described route. */
function operationOf(tag: string, method: string, operation: Operation, spec: RouteSpec): Record<string, unknown> {
  const contracts = operation.handlers.flatMap((handler) => {
    const contract = requestContractOf(handler);
    return contract ? [contract] : [];
  });

  const parameters = contracts.flatMap(parametersOf);
  // A `:segment` with no param validator still has to be declared, or the document is invalid. It is
  // declared bare — no description — which is exactly what the field-description sweep then reports.
  for (const name of pathParams(operation.path)) {
    if (!parameters.some((parameter) => parameter.in === "path" && parameter.name === name)) {
      parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
    }
  }
  if (/\*/.test(operation.path)) {
    parameters.push({
      name: "path",
      in: "path",
      required: true,
      description: "The rest of the path, passed through to the handler.",
      schema: { type: "string" },
    });
  }

  const body = contracts.map(requestBodyOf).find((candidate) => candidate !== undefined);
  const strategies = strategiesOf(spec);
  const security = strategies.flatMap((strategy) => {
    const requirement = REQUIREMENT[strategy];
    return requirement === undefined ? [] : [requirement];
  });

  const responses: Record<string, unknown> = {};
  for (const [status, declared] of Object.entries(spec.responses)) responses[status] = responseOf(declared);
  responses.default = { $ref: `#/components/responses/${ERROR_RESPONSE}` };

  return {
    tags: [tag],
    operationId: operationId(method, openApiPath(operation.path)),
    summary: spec.summary,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(body === undefined ? {} : { requestBody: body }),
    responses,
    ...(strategies.length === 0 ? {} : { security, "x-pithy-verification": strategies }),
    ...(spec.scopes === undefined || spec.scopes.length === 0 ? {} : { "x-pithy-scopes": spec.scopes }),
  };
}

/** The methods an operation is documented under: its own, or for `app.all` the ones its spec names. */
function methodsOf(operation: Operation, spec: RouteSpec): readonly DocumentedMethod[] {
  if (operation.method !== "ALL") return [operation.method.toLowerCase() as DocumentedMethod];
  return spec.methods ?? ["get", "post"];
}

/** How {@link openApiDocument} treats a route with no `describeRoute`. */
export interface DocumentOptions {
  /**
   * `omit` (the default) leaves it out, which is right for the kit: {@link undescribedRoutes} keeps that
   * set empty, so anything missing is a bug the gate names. `include` writes what the validators alone
   * can say — the path, its parameters and body — marked `x-pithy-undescribed`, which is right for an
   * adopter's own routes: a client generated from the contract still reaches them, and the mark says
   * which ones to describe.
   */
  readonly undescribed?: "omit" | "include";
}

/** The spec an undescribed route is written with under `undescribed: "include"`. It claims nothing. */
const UNDESCRIBED: RouteSpec = {
  summary: "Not described. Add describeRoute to this route.",
  verification: [],
  responses: {},
};

/**
 * The OpenAPI document for these route groups. Undescribed routes are left out rather than guessed at,
 * unless {@link DocumentOptions.undescribed} says otherwise; {@link undescribedRoutes} is the check that
 * keeps that set empty.
 */
export function openApiDocument(
  info: ContractInfo,
  groups: readonly RouteGroup[],
  options: DocumentOptions = {},
): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  const tags: OpenApiDocument["tags"] = [];
  const ids = new Map<string, number>();
  /** An operation id no earlier operation took: the derived one, or it with the next free number. */
  const unique = (id: string): string => {
    const seen = ids.get(id) ?? 0;
    ids.set(id, seen + 1);
    return seen === 0 ? id : `${id}${seen + 1}`;
  };

  for (const group of groups) {
    let documented = false;
    for (const operation of operationsOf(group.routes)) {
      if (isMiddlewareOnly(operation)) continue;
      const declared = operation.handlers.map(routeSpecOf).find((candidate) => candidate !== undefined);
      if (declared === undefined && options.undescribed !== "include") continue;
      const spec = declared ?? UNDESCRIBED;
      documented = true;
      const path = openApiPath(operation.path);
      const item = paths[path] ?? {};
      for (const method of methodsOf(operation, spec)) {
        const derived = operationOf(group.tag, method, operation, spec);
        const written = { ...derived, operationId: unique(String(derived.operationId)) };
        item[method] = declared === undefined ? { ...written, "x-pithy-undescribed": true } : written;
      }
      paths[path] = item;
    }
    if (documented) tags.push({ name: group.tag, ...(group.description ? { description: group.description } : {}) });
  }

  return {
    openapi: OPENAPI_VERSION,
    info,
    tags,
    paths,
    components: {
      schemas: { [ERROR_RESPONSE]: jsonSchema(ErrorBody, "input") },
      responses: {
        [ERROR_RESPONSE]: {
          description: "Any failure. The status is the error's own; the body is always this shape.",
          content: { "application/json": { schema: { $ref: `#/components/schemas/${ERROR_RESPONSE}` } } },
        },
      },
      securitySchemes: SECURITY_SCHEMES,
    },
  };
}

/** One schema property somewhere in the document that carries no `description`. */
export interface UndescribedField {
  /** A JSON pointer to the property, e.g. `/paths/~1leaderboard/get/responses/200/…/properties/rank`. */
  readonly pointer: string;
}

const escapePointer = (segment: string) => segment.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Every object property and every parameter in the document without a description. The kit holds every
 * Zod field to `.describe()`, and this is how that rule is checked on the wire shape a client actually
 * generates from, rather than on the source it came from.
 */
export function undescribedFields(document: OpenApiDocument): UndescribedField[] {
  const found: UndescribedField[] = [];
  const visit = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        visit(child, `${pointer}/${index}`);
      });
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.in === "string" && typeof record.name === "string" && typeof record.description !== "string") {
      found.push({ pointer });
    }
    const properties = record.properties;
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
        const described =
          property !== null &&
          typeof property === "object" &&
          typeof (property as Record<string, unknown>).description === "string";
        if (!described) found.push({ pointer: `${pointer}/properties/${escapePointer(name)}` });
      }
    }
    for (const [key, child] of Object.entries(record)) visit(child, `${pointer}/${escapePointer(key)}`);
  };
  visit(document.paths, "/paths");
  return found;
}
