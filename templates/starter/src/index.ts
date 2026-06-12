import { createBackend } from "@pithy-sh/core/src/createBackend";
import config from "../pithy.config";

// The Worker. createBackend assembles the capabilities in pithy.config.ts into
// one Hono app: typed db/kv registries on every request, fail-fast binding
// validation, and GET /health.
export default createBackend(config);
