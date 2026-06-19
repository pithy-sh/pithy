import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import config from "../pithy.config";

// The Worker. createEntrypoint assembles the capabilities in pithy.config.ts into
// a Worker entrypoint: `fetch` is one Hono app (typed db/kv registries on every
// request, fail-fast binding validation, GET /health), and `email` fans inbound
// mail to every capability that handles it (e.g. @pithy-sh/email's bounce handler).
export default createEntrypoint(config);
