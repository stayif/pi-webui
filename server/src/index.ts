import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";

import { WorkspaceManager } from "./workspace-manager.ts";
import { createApi } from "./routes.ts";
import { MAX_CLIENT_MESSAGE_BYTES, WsBridge } from "./ws-bridge.ts";

const PORT = Number(process.env.PI_WEBUI_PORT ?? process.env.PORT ?? 9529);

// @hono/node-ws constructs ErrorEvent for socket errors, but Node 22 exposes
// MessageEvent without ErrorEvent. Keep the adapter's oversized-frame error
// path functional until the dependency ships its own fallback.
if (!("ErrorEvent" in globalThis)) {
  Object.defineProperty(globalThis, "ErrorEvent", {
    configurable: true,
    value: class ErrorEvent extends Event {
      constructor(type: string, init: { error?: unknown } = {}) {
        super(type);
        Object.defineProperty(this, "error", { enumerable: true, value: init.error });
      }
    },
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function bindHost(): string {
  const host = process.env.HOST ?? "127.0.0.1";
  if (!isLoopbackHostname(host)) {
    throw new Error(`pi-webui only supports loopback hosts; refusing to bind ${host}`);
  }
  // `localhost` is a DNS name. Bind an unambiguous loopback literal so a
  // modified hosts/DNS configuration cannot accidentally expose the runtime.
  if (host === "localhost") return "127.0.0.1";
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// This process controls a Pi runtime that can execute bash and edit files. It
// is intentionally local-only and must reject DNS-rebound browser requests as
// well as non-loopback listener configuration.
const HOST = bindHost();

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
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  wss.options.maxPayload = MAX_CLIENT_MESSAGE_BYTES;

  app.use("*", async (c, next) => {
    c.header("Content-Security-Policy", "base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (!isLoopbackHost(c.req.header("host"))) {
      return c.text("Forbidden host", 403);
    }
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.text("Forbidden origin", 403);
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

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
