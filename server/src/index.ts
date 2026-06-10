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
 * Loopback binding stops other *machines*, but not other *origins in the user's
 * own browser*. Any website the user visits can open a WebSocket to
 * `ws://127.0.0.1:<port>/ws` (browsers allow cross-origin WS connections) and
 * then drive the full command surface — open a workspace, prompt the agent,
 * run bash. That's cross-site WebSocket hijacking / DNS rebinding, and the
 * loopback bind does nothing against it.
 *
 * The guard: a real browser always stamps a forgeable-by-JS-proof `Origin` on
 * the WS handshake, and same-origin requests from our own page carry a loopback
 * origin. So we reject any handshake whose `Origin` is present and not loopback,
 * and additionally require the `Host` header to be loopback (blocks DNS
 * rebinding, where a rebound domain points at 127.0.0.1). Non-browser clients
 * (curl, a CLI) send no `Origin` and are allowed — they're outside the browser
 * threat model and can already talk to any local port.
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function isAllowedOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let hostname = host;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    hostname = end === -1 ? host : host.slice(0, end + 1);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1) hostname = host.slice(0, colon);
  }
  return isLoopbackHostname(hostname);
}

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
    (c, next) => {
      // Reject cross-site WebSocket hijacking / DNS rebinding before upgrading.
      const origin = c.req.header("origin");
      if (origin && !isAllowedOrigin(origin)) {
        return c.text("Forbidden origin", 403);
      }
      if (!isLoopbackHost(c.req.header("host"))) {
        return c.text("Forbidden host", 403);
      }
      return next();
    },
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
