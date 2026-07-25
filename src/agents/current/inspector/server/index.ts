import { serve } from "@hono/node-server";

import { app } from "./app.js";

const port = Number(process.env.MEMORYBENCH_UI_PORT ?? 8765);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
process.stderr.write(`[memory-observatory] http://127.0.0.1:${String(port)}\n`);
