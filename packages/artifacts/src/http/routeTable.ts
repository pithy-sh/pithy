// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { artifactsAdminRoutes } from "./scopes";

/**
 * Every route `registerArtifactsRoutes` mounts under `base`: the management surface, a caller's repositories, an organization's while `organization` is on, and each repository's contents.
 */
export function artifactsRouteTable(base: string, organization: boolean): DeclaredRoute[] {
  return [
    ...adminRouteTable(artifactsAdminRoutes(base)),
    ...declareRoutes(base, [
      ["POST", "/repos"],
      ["GET", "/repos"],
      ...(organization
        ? ([
            ["POST", "/organization/repos"],
            ["GET", "/organization/repos"],
          ] as const)
        : []),
      ["GET", "/repos/:name"],
      ["DELETE", "/repos/:name"],
      ["POST", "/repos/:name/grants"],
      ["DELETE", "/repos/:name/grants/:userId"],
      ["POST", "/repos/:name/credentials"],
      ["DELETE", "/repos/:name/credentials"],
      ["GET", "/repos/:name/log"],
      ["GET", "/repos/:name/commits/:hash"],
      ["GET", "/repos/:name/tree/:hash"],
      ["GET", "/repos/:name/blob/:hash"],
      ["GET", "/repos/:name/file"],
    ]),
  ];
}
