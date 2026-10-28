// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { RpcMessage } from "../rpc";

/** The MCP endpoint's body: one JSON-RPC message. */
export const McpRequestBody = RpcMessage;

/** The consent screen's question: the signed authorization query the provider redirected it with. */
export const ConsentQuery = z
  .object({
    oauth_query: z
      .string()
      .min(1)
      .max(8192)
      .describe("The query string the authorization server redirected the screen with, signed by it."),
  })
  .describe("Which authorization request the consent screen is about.");

/** The consent decision: one, for the whole request. */
export const ConsentBody = z
  .object({
    oauth_query: z
      .string()
      .min(1)
      .max(8192)
      .describe("The query string the authorization server redirected the screen with, signed by it."),
    accept: z.boolean().describe("Whether you let this client act as you in this application."),
  })
  .strict()
  .describe("One decision: let this client act as you, or not. Nothing in it is selectable.");

/** Which connected application. */
export const ConnectionParam = z
  .object({ clientId: z.string().min(1).max(256).describe("The client's id.") })
  .describe("One connected application.");
