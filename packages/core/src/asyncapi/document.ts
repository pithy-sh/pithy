// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import type { Capability } from "../capability/capability";
import { ErrorBody } from "../error/wire";
import type { SocketChannel, SocketMessage } from "../http/socket";
import type { VerificationStrategy } from "../http/verification";
import {
  type ContractInfo,
  type JsonSchema,
  jsonSchema,
  openApiPath,
  type UndescribedField,
  undescribedFieldsIn,
} from "../openapi/document";

/**
 * **The AsyncAPI contract: every socket a Worker serves, and every frame on it.**
 *
 * The OpenAPI document stops at the upgrade. This picks up after it, from the `sockets` each composed
 * capability declares (`../http/socket.ts`): one channel per socket, one message per frame, and one operation
 * per direction — `send` for what the Worker sends, `receive` for what it accepts, as AsyncAPI names them from
 * the application's side. Every schema is the one the socket parses with, converted by `z.toJSONSchema` with
 * its descriptions intact, so an engine with no generator still has typed messages to write against.
 *
 * AsyncAPI 3.0, whose schemas are JSON Schema — the dialect `z.toJSONSchema` writes.
 */

/** The AsyncAPI version this module writes. */
export const ASYNCAPI_VERSION = "3.0.0";

/** One capability's sockets. Becomes the channels tagged with its name. */
export interface SocketGroup {
  /** The capability's name. */
  readonly tag: string;
  /** The sockets it declared. */
  readonly sockets: readonly SocketChannel[];
}

/** The sockets of every capability that declares one, grouped by capability, in composition order. */
export function socketGroupsOf(capabilities: readonly Capability[]): SocketGroup[] {
  return capabilities
    .filter((capability) => (capability.sockets ?? []).length > 0)
    .map((capability) => ({ tag: capability.name, sockets: capability.sockets ?? [] }));
}

/** The subset of an AsyncAPI 3.0 document this module writes. */
export interface AsyncApiDocument {
  asyncapi: string;
  info: ContractInfo;
  channels: Record<string, Record<string, unknown>>;
  operations: Record<string, Record<string, unknown>>;
  components: {
    messages: Record<string, Record<string, unknown>>;
    schemas: Record<string, JsonSchema>;
  };
}

/** A frame's id in the document: its socket's name and its own, so two sockets' `error` frames stay apart. */
function messageId(socket: SocketChannel, message: SocketMessage, direction: "send" | "receive"): string {
  return `${socket.name}.${direction}.${message.name}`;
}

/** One `components.messages` entry: a JSON frame by its schema, a text frame by its exact text. */
function messageOf(message: SocketMessage): Record<string, unknown> {
  if (message.schema === undefined) {
    return {
      name: message.name,
      summary: message.summary,
      contentType: "text/plain",
      payload: { type: "string", const: message.text ?? "", description: message.summary },
    };
  }
  return {
    name: message.name,
    summary: message.summary,
    contentType: "application/json",
    payload: jsonSchema(message.schema, "input"),
  };
}

/** The path parameters, from the same schema the upgrade route validates them with. */
function parametersOf(params: z.ZodType | undefined): Record<string, Record<string, unknown>> {
  if (params === undefined) return {};
  const properties = (jsonSchema(params, "input").properties ?? {}) as Record<string, JsonSchema>;
  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      typeof property.description === "string" ? { description: property.description } : {},
    ]),
  );
}

function strategiesOf(socket: SocketChannel): readonly VerificationStrategy[] {
  return typeof socket.verification === "string" ? [socket.verification] : socket.verification;
}

/** The AsyncAPI document for these capabilities' sockets. */
export function asyncApiDocument(info: ContractInfo, groups: readonly SocketGroup[]): AsyncApiDocument {
  const document: AsyncApiDocument = {
    asyncapi: ASYNCAPI_VERSION,
    info,
    channels: {},
    operations: {},
    components: { messages: {}, schemas: { Error: jsonSchema(ErrorBody, "input") } },
  };

  for (const group of groups) {
    for (const socket of group.sockets) {
      const channelMessages: Record<string, { $ref: string }> = {};
      for (const direction of ["send", "receive"] as const) {
        const refs: { $ref: string }[] = [];
        for (const message of socket[direction]) {
          const id = messageId(socket, message, direction);
          document.components.messages[id] = messageOf(message);
          channelMessages[id] = { $ref: `#/components/messages/${id}` };
          refs.push({ $ref: `#/channels/${socket.name}/messages/${id}` });
        }
        if (refs.length > 0) {
          document.operations[`${socket.name}.${direction}`] = {
            action: direction,
            channel: { $ref: `#/channels/${socket.name}` },
            summary: direction === "send" ? "Frames the Worker sends." : "Frames the Worker accepts.",
            messages: refs,
          };
        }
      }
      const parameters = parametersOf(socket.params);
      document.channels[socket.name] = {
        address: openApiPath(socket.path),
        summary: socket.summary,
        ...(socket.description === undefined ? {} : { description: socket.description }),
        ...(Object.keys(parameters).length === 0 ? {} : { parameters }),
        messages: channelMessages,
        tags: [{ name: group.tag }],
        bindings: { ws: { method: "GET" } },
        "x-pithy-verification": strategiesOf(socket),
        "x-pithy-subprotocols": socket.versions,
      };
      for (const [name, schema] of Object.entries(socket.schemas ?? {})) {
        document.components.schemas[`${socket.name}.${name}`] = jsonSchema(schema, "input");
      }
    }
  }
  return document;
}

/**
 * Every message property, schema property and channel parameter in the document without a description —
 * the same rule as the OpenAPI document's, over the parts a client generates from.
 */
export function undescribedAsyncFields(document: AsyncApiDocument): UndescribedField[] {
  const parameters = Object.entries(document.channels).flatMap(([channel, item]) =>
    Object.entries((item.parameters ?? {}) as Record<string, Record<string, unknown>>)
      .filter(([, parameter]) => typeof parameter.description !== "string")
      .map(([name]) => ({ pointer: `/channels/${channel}/parameters/${name}` })),
  );
  return [
    ...parameters,
    ...undescribedFieldsIn(document.components.messages, "/components/messages"),
    ...undescribedFieldsIn(document.components.schemas, "/components/schemas"),
  ];
}
