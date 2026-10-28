// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneConnection, RegisteredKey } from "@pithy-sh/core/src/controlPlane/data/connection";
import { authorizedByPrincipal, revokeCredentials } from "@pithy-sh/core/src/controlPlane/data/connections";
import { activeKeys } from "@pithy-sh/core/src/controlPlane/data/keyLifecycle";
import { ControlPlaneKeyConflictError } from "@pithy-sh/core/src/controlPlane/error/errors";
import type { ConnectionRegistry } from "../dashboard/registry";

/**
 * An in-memory registry — the D1 half is proven in registry.test.ts against a real database.
 *
 * It mirrors the real key invariant: a key may be added only while nothing live could have signed for one
 * at the seam. A permissive fake would let this file prove behavior the actual registry refuses.
 *
 * `seamRegister` is the *worker's* write, not the CLI's — what `POST {basePath}/keys` does to this row
 * when a management client calls it. Nothing in `connect.ts` may reach it; a test plays the worker.
 */
export function fakeConnectionRegistry(initial: ControlPlaneConnection | null = null): ConnectionRegistry & {
  current: () => ControlPlaneConnection | null;
  seamRegister: (key: RegisteredKey) => void;
} {
  let row = initial;
  return {
    read: async () => row,
    save: async (connection) => {
      if (row && row.id === connection.id && JSON.stringify(row.keys) !== JSON.stringify(connection.keys)) {
        if (activeKeys(row.keys, connection.updatedAt).length > 0) {
          throw new ControlPlaneKeyConflictError({ detail: "save rewrote the keys of a connection with a live key" });
        }
      }
      row = connection;
    },
    appendKey: async (key, now) => {
      if (!row) throw new Error("appendKey called with nothing registered");
      if (activeKeys(row.keys, now).length > 0) {
        throw new ControlPlaneKeyConflictError({ detail: "appendKey while a key is live" });
      }
      row = { ...row, keys: [...row.keys, key], updatedAt: now };
      return row;
    },
    seamRegister: (key) => {
      if (!row) throw new Error("the worker cannot register a key on a connection that does not exist");
      row = { ...row, keys: [...row.keys, key] };
    },
    revokeKey: async (keyId, now) => {
      if (!row) throw new Error("revokeKey called with nothing registered");
      if (!row.keys.some((key) => key.keyId === keyId)) return null;
      row = {
        ...row,
        keys: row.keys.map((key) => (key.keyId === keyId ? { ...key, revokedAt: now } : key)),
        updatedAt: now,
      };
      return row;
    },
    appendTrust: async (trust, now) => {
      if (!row) throw new Error("appendTrust called with nothing registered");
      row = { ...row, trusts: [...(row.trusts ?? []), trust], updatedAt: now };
      return row;
    },
    revokeTrust: async (trustId, now) => {
      if (!row) throw new Error("revokeTrust called with nothing registered");
      if (!(row.trusts ?? []).some((trust) => trust.trustId === trustId)) return null;
      row = {
        ...row,
        trusts: (row.trusts ?? []).map((trust) => (trust.trustId === trustId ? { ...trust, revokedAt: now } : trust)),
        updatedAt: now,
      };
      return row;
    },
    list: async (principal) => {
      if (!row) return { connections: [], unattributed: [] };
      if (row.authorizedBy === null) return { connections: [], unattributed: [row] };
      const matches = principal === undefined || authorizedByPrincipal(row, principal);
      return { connections: matches ? [row] : [], unattributed: [] };
    },
    revokeConnection: async (id, _reason, now) => {
      if (!row || row.id !== id) return null;
      const revoked = revokeCredentials(row, now);
      row = revoked.connection;
      return revoked;
    },
    remove: async () => {
      const had = row !== null;
      row = null;
      return had;
    },
    dispose: async () => {},
    current: () => row,
  };
}
