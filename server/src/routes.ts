import { Hono } from "hono";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { WorkspaceManager } from "./workspace-manager.ts";
import type { SessionSummary, Workspace } from "./protocol.ts";

/**
 * Read-only-ish HTTP API. Everything here reads the local Pi runtime directly —
 * no auth, no database. State-changing actions that need live streaming go over
 * the WebSocket instead (see ws-bridge.ts).
 *
 * Sessions are listed from disk without needing a runtime (SessionManager.list
 * is static). State, history, and tree need an active session runtime. Models
 * come from the shared (process-global) registry so they're available even
 * before the first session is opened.
 */
export function createApi(mgr: WorkspaceManager): Hono {
  const api = new Hono();

  // ── workspace list ──

  api.get("/workspaces", (c) =>
    c.json<{ workspaces: Workspace[]; activeId: string | null }>({
      workspaces: mgr.list(),
      activeId: mgr.activeIdOrNull,
    }),
  );

  // ── sessions (no runtime needed — static disk read) ──

  api.get("/sessions", async (c) => {
    const cwd = mgr.resolvePath(c.req.query("ws") || undefined);
    const all = c.req.query("all") === "1";
    const infos = all
      ? await SessionManager.listAll()
      : await SessionManager.list(cwd);
    const summaries: SessionSummary[] = infos.map((s) => ({
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      parentSessionPath: s.parentSessionPath,
      created: s.created.toISOString(),
      modified: s.modified.toISOString(),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
    }));
    return c.json({ sessions: summaries });
  });

  // ── state / history / tree (need an active runtime) ──

  api.get("/state", (c) => {
    const rt = mgr.resolveRuntime(c.req.query("ws") || undefined);
    return c.json({ state: rt ? rt.snapshot() : null });
  });

  api.get("/history", (c) => {
    const rt = mgr.resolveRuntime(c.req.query("ws") || undefined);
    return c.json({ items: rt ? rt.history() : [] });
  });

  api.get("/tree", (c) => {
    const rt = mgr.resolveRuntime(c.req.query("ws") || undefined);
    return c.json({ tree: rt ? rt.tree() : [] });
  });

  // ── models (shared registry — process-global) ──

  api.get("/models", (c) =>
    c.json({ models: mgr.sharedModels }),
  );

  return api;
}
