import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";

import { WorkspaceManager } from "./workspace-manager.ts";
import { createApi } from "./routes.ts";
import { WsBridge } from "./ws-bridge.ts";

const PORT = Number(process.env.PI_WEBUI_PORT ?? process.env.PORT ?? 9529);
// Bind to loopback only. This server exposes the local Pi runtime — which can
// run bash/edit/write — so it must never be reachable off the machine. There
// is deliberately no auth layer; the security boundary is the loopback bind.
const HOST = process.env.HOST ?? "127.0.0.1";

/**
 * Where pi-webui persists its own state (open tabs).
 *
 * Deliberately project-local, NOT in `~/.pi`: pi-webui is an independent
 * dashboard and must not write bookkeeping into the user's Pi runtime data.
 * The file sits at the repo root (gitignored) so the app stays self-contained.
 * Overridable for packaged installs via PI_WEBUI_STATE.
 */
function stateFilePath(): string {
  if (process.env.PI_WEBUI_STATE) return path.resolve(process.env.PI_WEBUI_STATE);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  return path.join(repoRoot, ".pi-webui-state.json");
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

async function main(): Promise<void> {
  const mgr = await WorkspaceManager.create(stateFilePath());
  const bridge = new WsBridge(mgr);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.route("/api", createApi(mgr));

  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen: (_evt, ws) => bridge.add(ws),
      onMessage: (evt, ws) => {
        void bridge.handle(ws, String(evt.data));
      },
      onClose: (_evt, ws) => bridge.remove(ws),
      onError: (_evt, ws) => bridge.remove(ws),
    })),
  );

  app.get("/health", (c) => c.json({ ok: true }));
  app.use("/*", serveStatic({ root: path.join(repoRoot(), "web", "dist") }));
  app.get("*", serveStatic({ root: path.join(repoRoot(), "web", "dist"), path: "index.html" }));

  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`pi-webui server on http://${HOST}:${info.port}`);
  });
  injectWebSocket(server);
}

main().catch((err) => {
  console.error("Failed to start pi-webui server:", err);
  process.exit(1);
});
