// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { errorSchemas } from "./payloadSchemas";

/**
 * The error object model, by name. Every schema here is built by `./payloadSchemas` and read off it when
 * this module loads, so importing it builds the whole taxonomy; code that only throws or encodes an error
 * reads `errorSchemas()` at the point of use instead, and a Worker that never fails builds none of it.
 */
const schemas = errorSchemas();

/** A single field-level validation failure, mirrored from a Zod issue for the wire. */
export const ValidationIssue = schemas.ValidationIssue;
export type ValidationIssue = z.infer<typeof ValidationIssue>;

/** The public projection of every error the kit itself defines: the wire shape clients receive. */
export const KitPublicErrorPayload = schemas.KitPublicErrorPayload;

/** Every error the kit itself defines, in full. The closed taxonomy, and the only union anything may switch over exhaustively. */
export const KitErrorPayload = schemas.KitErrorPayload;
export type KitErrorPayload = z.infer<typeof KitErrorPayload>;

/**
 * The closed set of codes the kit defines. Exhaustive handling — a `switch` with no `default`, a
 * lookup table keyed by code — belongs on this type, never on {@link ErrorCode}, which is open by
 * construction and would make such a switch a lie the moment an adopter registers a code.
 */
export type KitErrorCode = KitErrorPayload["code"];

/** The `domain` half of every code the kit defines, as a type. The reserved set, at compile time. */
export type KitErrorDomain = KitErrorCode extends `${infer Domain}/${string}` ? Domain : never;

/** An adopter-defined `domain/reason` code, outside the set the kit defines. */
export const ExtendedErrorCode = schemas.ExtendedErrorCode;
export type ExtendedErrorCode = z.output<typeof ExtendedErrorCode>;

/** Every error that can reach a client, from the kit or from the adopter. */
export const PublicErrorPayload = schemas.PublicErrorPayload;
export type PublicErrorPayload = z.infer<typeof PublicErrorPayload>;

/** An adopter's own error, in full: their public fields plus the same operator-only `action` and `detail`. */
export const ExtendedErrorPayload = schemas.ExtendedErrorPayload;
export type ExtendedErrorPayload = z.infer<typeof ExtendedErrorPayload>;

/** Every error Pithy can carry, in full. What a `PithyError` carries in memory. */
export const ErrorPayload = schemas.ErrorPayload;
export type ErrorPayload = z.infer<typeof ErrorPayload>;

/** Every machine-readable error code: the kit's closed set, plus whatever an adopter registers. */
export type ErrorCode = ErrorPayload["code"];
