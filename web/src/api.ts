import type {
  ModelInfo,
  SessionState,
  SessionSummary,
  TranscriptItem,
  TreeNode,
  Workspace,
} from "@protocol";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Append `?ws=<id>` when a workspace is given. */
function q(ws?: string, extra = ""): string {
  const params = new URLSearchParams();
  if (ws) params.set("ws", ws);
  if (extra) for (const [k, v] of new URLSearchParams(extra)) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const api = {
  workspaces: () =>
    getJson<{ workspaces: Workspace[]; activeId: string | null }>("/api/workspaces"),
  sessions: (ws?: string, all = false) =>
    getJson<{ sessions: SessionSummary[] }>(
      `/api/sessions${q(ws, all ? "all=1" : "")}`,
    ).then((r) => r.sessions),
  state: (ws?: string) =>
    getJson<{ state: SessionState }>(`/api/state${q(ws)}`).then((r) => r.state),
  history: (ws?: string) =>
    getJson<{ items: TranscriptItem[] }>(`/api/history${q(ws)}`).then((r) => r.items),
  tree: (ws?: string) => getJson<{ tree: TreeNode[] }>(`/api/tree${q(ws)}`).then((r) => r.tree),
  models: (ws?: string) =>
    getJson<{ models: ModelInfo[] }>(`/api/models${q(ws)}`).then((r) => r.models),
};
