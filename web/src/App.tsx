import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGemoji from "remark-gemoji";
import remarkGfm from "remark-gfm";

import type {
  ClientMessage,
  ModelInfo,
  PromptAttachment,
  ServerMessage,
  SessionState,
  SessionSummary,
  TranscriptItem,
  Workspace,
} from "@protocol";

import { api } from "./api.ts";
import { I18nProvider, type Lang, LANG_STORE, loadLang, STRINGS, type Strings, useT } from "./i18n.tsx";
import { applyEvent, newCursor } from "./transcript.ts";
import { usePiSocket } from "./usePiSocket.ts";

const ACTIVITY_TYPES = [
  "reasoning",
  "tool",
  "shell",
  "file",
  "network",
  "system",
  "error",
] as const;

type ActivityType = (typeof ACTIVITY_TYPES)[number];
type Theme = "light" | "dark";

const COLLAPSED_STORE = "pi-webui:collapsed-logs";
const HIDDEN_STORE = "pi-webui:hidden-logs";
const PINNED_STORE = "pi-webui:pinned-sessions";
const THEME_STORE = "pi-webui:theme";
const SESSION_NAME_STORE = "pi-webui:session-name";
const MODEL_STORE = "pi-webui:model";
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const CHECK_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>`;
const PROVIDER_ICONS: Record<string, string> = {
  anthropic:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2c.4 2.9.9 4.9 1.7 6 .8 1.1 2.6 2 5.4 2.7-2.8.7-4.6 1.6-5.4 2.7-.8 1.1-1.3 3.1-1.7 6-.4-2.9-.9-4.9-1.7-6-.8-1.1-2.6-2-5.4-2.7 2.8-.7 4.6-1.6 5.4-2.7.8-1.1 1.3-3.1 1.7-6z"/></svg>',
  openai:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7.5a3 3 0 0 0-5.2-2 3 3 0 0 0-1.3 4.3 3 3 0 0 0 .7 4.5 3 3 0 0 0 4.8 2.2 3 3 0 0 0 5.2 .1 3 3 0 0 0 1.4-4.3 3 3 0 0 0-.7-4.5A3 3 0 0 0 12 7.5z"/><path d="M12 7.5v9M8 9.7l8 4.6M16 9.7l-8 4.6"/></svg>',
  google:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.4 4.2 3.8 7.6 8 8-4.2.4-7.6 3.8-8 8-.4-4.2-3.8-7.6-8-8 4.2-.4 7.6-3.8 8-8z"/></svg>',
  meta:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12c0-3 1.6-5 4-5 3 0 4.5 4 5 5 .5 1 2 5 5 5 2.4 0 4-2 4-5s-1.6-5-4-5c-3 0-4.5 4-5 5-.5 1-2 5-5 5-2.4 0-4-2-4-5z"/></svg>',
  mistral:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h4v4H3zM10 5h4v4h-4zM17 5h4v4h-4zM3 12h4v4H3zM17 12h4v4h-4zM3 19h4v-3H3zM17 19h4v-3h-4z"/></svg>',
  xai:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M5 4l14 16M19 4 5 20"/></svg>',
  deepseek:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(-25 12 12)"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>',
  local:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="11" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>',
};

interface StoredModelChoice {
  prov: string;
  model: string;
}

interface SessionTreeNode {
  session: SessionSummary;
  children: SessionTreeNode[];
}

interface ThinkingOption {
  id: string;
  label: string;
}

interface ForkRow {
  session: SessionSummary;
  rail: string;
}

interface ComposerAttachment {
  id: string;
  type: "text" | "image";
  name: string;
  size: number;
  mimeType?: string;
  text?: string;
  data?: string;
}

type FileSystemDropHandle =
  | { kind: "file"; name: string; getFile: () => Promise<File> }
  | { kind: "directory"; name: string };

type DataTransferItemWithHandles = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemDropHandle | null>;
};

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWs, setActiveWs] = useState<string | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [input, setInput] = useState("");
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [lang, setLang] = useState<Lang>(loadLang);
  const [hiddenActivity, setHiddenActivity] = useState<Set<ActivityType>>(loadHidden);
  const [collapsedLogs, setCollapsedLogs] = useState<Set<ActivityType>>(loadCollapsed);
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(loadPinnedSessions);
  const [sessionNames, setSessionNames] = useState<Record<string, string>>(loadSessionNames);
  const [storedModel, setStoredModel] = useState<StoredModelChoice | null>(loadStoredModel);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

  const cursorRef = useRef(newCursor());
  const activeWsRef = useRef<string | null>(null);
  const abortDividerRef = useRef<{ workspaceId: string; sessionId: string; item: TranscriptItem } | null>(null);
  activeWsRef.current = activeWs;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORE, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
    try {
      localStorage.setItem(LANG_STORE, lang);
    } catch {
      // ignore
    }
  }, [lang]);

  const t = STRINGS[lang];

  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_STORE, JSON.stringify([...hiddenActivity]));
    } catch {
      // ignore
    }
  }, [hiddenActivity]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_STORE, JSON.stringify([...collapsedLogs]));
    } catch {
      // ignore
    }
  }, [collapsedLogs]);

  useEffect(() => {
    try {
      localStorage.setItem(PINNED_STORE, JSON.stringify([...pinnedSessions]));
    } catch {
      // ignore
    }
  }, [pinnedSessions]);

  useEffect(() => {
    try {
      localStorage.setItem(SESSION_NAME_STORE, JSON.stringify(sessionNames));
    } catch {
      // ignore
    }
  }, [sessionNames]);

  useEffect(() => {
    if (!storedModel) return;
    try {
      localStorage.setItem(MODEL_STORE, JSON.stringify(storedModel));
    } catch {
      // ignore
    }
  }, [storedModel]);

  const refreshSessionList = useCallback(() => {
    const ws = activeWsRef.current;
    if (!ws) return;
    void api.sessions(ws).then(setSessions).catch(() => {});
  }, []);

  const refreshSessionListWithBackoff = useCallback(() => {
    refreshSessionList();
    window.setTimeout(refreshSessionList, 250);
    window.setTimeout(refreshSessionList, 1000);
  }, [refreshSessionList]);

  const hydrate = useCallback(async (ws: string | null) => {
    if (!ws) return;
    const [hist, sess, mods, st] = await Promise.all([
      api.history(ws).catch(() => [] as TranscriptItem[]),
      api.sessions(ws).catch(() => [] as SessionSummary[]),
      api.models(ws).catch(() => [] as ModelInfo[]),
      api.state(ws).catch(() => null),
    ]);
    cursorRef.current = newCursor();
    const transientDivider = abortDividerRef.current;
    setItems(
      transientDivider && st?.workspaceId === transientDivider.workspaceId && st.sessionId === transientDivider.sessionId
        ? [...hist, transientDivider.item]
        : hist,
    );
    setSessions(sess);
    setModels(mods);
    if (st) setState(st);
  }, []);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "workspaces":
        setWorkspaces(msg.workspaces);
        setActiveWs((prev) => {
          if (prev && msg.workspaces.some((workspace) => workspace.id === prev)) return prev;
          return msg.activeId;
        });
        break;
      case "state":
        if (msg.state.workspaceId === activeWsRef.current) setState(msg.state);
        break;
      case "session_replaced":
        if (msg.state.workspaceId === activeWsRef.current) {
          setState(msg.state);
          cursorRef.current = newCursor();
          void hydrate(msg.state.workspaceId);
        }
        break;
      case "agent_event":
        if (msg.workspaceId !== activeWsRef.current) break;
        {
          const change = applyEvent(msg.event, setItems, cursorRef.current);
          const eventType = (msg.event as { type?: unknown }).type;
          if (change === "start") setState((current) => (current ? { ...current, isStreaming: true } : current));
          if (change === "end") {
            setState((current) => (current ? { ...current, isStreaming: false } : current));
            refreshSessionListWithBackoff();
            void hydrate(activeWsRef.current);
          }
          if (eventType === "model_select" || eventType === "thinking_level_changed") {
            void api.state(activeWsRef.current ?? undefined).then((next) => next && setState(next)).catch(() => {});
          }
        }
        break;
      case "fork_prefill":
        if (msg.workspaceId === activeWsRef.current) setInput(msg.text);
        break;
      case "error":
        setItems((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: "system",
            text: `⚠ ${msg.message}`,
            activity: "error",
            isError: true,
          },
        ]);
        break;
    }
  }, [hydrate, refreshSessionListWithBackoff]);

  const { status, send } = usePiSocket(handleMessage);

  useEffect(() => {
    void hydrate(activeWs);
  }, [activeWs, hydrate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !activeWsRef.current) return;
      if (!state?.isStreaming) return;
      if (
        abortDividerRef.current?.workspaceId === activeWsRef.current &&
        abortDividerRef.current.sessionId === state.sessionId
      ) {
        return;
      }
      const item: TranscriptItem = {
        id: crypto.randomUUID(),
        kind: "divider",
        text: t.abortExecution,
      };
      abortDividerRef.current = {
        workspaceId: activeWsRef.current,
        sessionId: state.sessionId,
        item,
      };
      setItems((current) => [...current, item]);
      send({ type: "abort", workspaceId: activeWsRef.current });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [send, state?.isStreaming, state?.sessionId, t.abortExecution]);

  useEffect(() => {
    if (!state?.model) return;
    setStoredModel({ prov: state.model.provider, model: state.model.id });
  }, [state?.model]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === state?.sessionId) ?? null,
    [sessions, state?.sessionId],
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWs) ?? null,
    [activeWs, workspaces],
  );

  const sessionName = useMemo(() => {
    const key = sessionStorageKey(state);
    return (
      state?.sessionName ??
      activeSession?.name ??
      (key ? sessionNames[key] : undefined) ??
      activeSession?.firstMessage ??
      t.defaultConversation
    );
  }, [activeSession, sessionNames, state, t.defaultConversation]);

  const currentModel = useMemo(
    () => resolveCurrentModel(models, state?.model, activeWorkspace?.defaultModel, storedModel),
    [activeWorkspace?.defaultModel, models, state?.model, storedModel],
  );

  const thinkingOptions = useMemo(
    () => resolveThinkingOptions(state, activeWorkspace, currentModel),
    [activeWorkspace, currentModel, state],
  );

  const currentThinkingLevel = state?.thinkingLevel ?? activeWorkspace?.defaultThinkingLevel ?? "off";

  const displayThinkingLevel = useMemo(
    () => (thinkingOptions.includes(currentThinkingLevel) ? currentThinkingLevel : (thinkingOptions[0] ?? "off")),
    [currentThinkingLevel, thinkingOptions],
  );

  const chatItems = useMemo(
    () => items.filter((item) => item.kind === "user" || item.kind === "assistant" || item.kind === "divider"),
    [items],
  );

  const activityItems = useMemo(
    () => items.filter((item) => item.kind === "reasoning" || item.kind === "tool" || item.kind === "system"),
    [items],
  );

  const sessionTree = useMemo(() => buildSessionTree(sessions), [sessions]);
  const pinnedGroups = useMemo(
    () => sessionTree.filter((node) => pinnedSessions.has(node.session.path)),
    [pinnedSessions, sessionTree],
  );
  const normalGroups = useMemo(
    () => sessionTree.filter((node) => !pinnedSessions.has(node.session.path)),
    [pinnedSessions, sessionTree],
  );
  const runtimeBusy = isRuntimeBusy(state);

  const submit = useCallback((text = input, attachments: PromptAttachment[] = []) => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || !activeWs) return;
    abortDividerRef.current = null;
    if (!state?.isStreaming) {
      setItems((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: "user", text: formatSubmittedText(trimmed, attachments) },
      ]);
    }
    send({
      type: "prompt",
      text: trimmed,
      attachments,
      workspaceId: activeWs,
      streamingBehavior: state?.isStreaming ? "steer" : undefined,
    });
    refreshSessionListWithBackoff();
    if (text === input) setInput("");
  }, [activeWs, input, refreshSessionListWithBackoff, send, state?.isStreaming]);

  const handleRenameSession = useCallback((nextName: string) => {
    const key = sessionStorageKey(state);
    const trimmed = nextName.trim().slice(0, 40);
    if (!key || !trimmed) return;
    setSessionNames((current) => ({ ...current, [key]: trimmed }));
    if (activeWsRef.current) {
      send({ type: "set_session_name", name: trimmed, workspaceId: activeWsRef.current });
      refreshSessionListWithBackoff();
    }
  }, [refreshSessionListWithBackoff, send, state]);

  const handleSetModel = useCallback((provider: string, modelId: string) => {
    setStoredModel({ prov: provider, model: modelId });
    if (activeWs) send({ type: "set_model", provider, modelId, workspaceId: activeWs });
  }, [activeWs, send]);

  const handleDeleteSessions = useCallback((paths: string[]) => {
    if (!activeWs || paths.length === 0) return;
    send({ type: "delete_sessions", workspaceId: activeWs, sessionPaths: paths });
    setPinnedSessions((current) => {
      const next = new Set(current);
      for (const sessionPath of paths) next.delete(sessionPath);
      return next;
    });
    setExpandedGroups((current) => {
      const next = new Set(current);
      for (const sessionPath of paths) next.delete(sessionPath);
      return next;
    });
    window.setTimeout(() => {
      void api.sessions(activeWs).then(setSessions).catch(() => {});
    }, 50);
  }, [activeWs, send]);

  const handleCloneSession = useCallback((sessionPath: string) => {
    if (!activeWs || isRuntimeBusy(state)) return;
    send({ type: "clone_session", workspaceId: activeWs, sessionPath });
    window.setTimeout(() => {
      void api.sessions(activeWs).then(setSessions).catch(() => {});
    }, 120);
  }, [activeWs, send, state]);

  const handleCompact = useCallback(() => {
    if (!activeWs || state?.isCompacting) return;
    send({ type: "compact", workspaceId: activeWs });
  }, [activeWs, send, state?.isCompacting]);

  return (
    <I18nProvider value={t}>
    <div className="app">
      <Topbar state={state} status={status} theme={theme} onThemeChange={setTheme} lang={lang} onLangChange={setLang} />

      <div className="main">
        <SessionColumn
          groups={normalGroups}
          pinnedGroups={pinnedGroups}
          pinnedSessions={pinnedSessions}
          expandedGroups={expandedGroups}
          activeSessionId={state?.sessionId}
          runtimeBusy={runtimeBusy}
          onNewSession={() => activeWs && send({ type: "new_session", workspaceId: activeWs })}
          onSelect={(path) =>
            activeWs && send({ type: "switch_session", sessionPath: path, workspaceId: activeWs })}
          onTogglePin={(rootPath) =>
            setPinnedSessions((current) => {
              const next = new Set(current);
              next.has(rootPath) ? next.delete(rootPath) : next.add(rootPath);
              return next;
            })}
          onToggleExpanded={(rootPath) =>
            setExpandedGroups((current) => {
              const next = new Set(current);
              next.has(rootPath) ? next.delete(rootPath) : next.add(rootPath);
              return next;
            })}
          onClone={handleCloneSession}
          onDeleteSessions={handleDeleteSessions}
        />

        <ChatColumn
          state={state}
          items={chatItems}
          input={input}
          setInput={setInput}
          currentModel={currentModel}
          models={models}
          thinkingLevel={displayThinkingLevel}
          thinkingOptions={thinkingOptions}
          sessionName={sessionName}
          onSubmit={submit}
          onAbort={() => activeWs && send({ type: "abort", workspaceId: activeWs })}
          onClearQueue={() => activeWs && send({ type: "clear_queue", workspaceId: activeWs })}
          onSetModel={handleSetModel}
          onSetThinkingLevel={(level) =>
            activeWs && send({ type: "set_thinking_level", level, workspaceId: activeWs })}
          onCompact={handleCompact}
          onRenameSession={handleRenameSession}
          onForkMessage={(entryId, position) =>
            activeWs && !runtimeBusy && send({ type: "fork", entryId, position, workspaceId: activeWs })}
          forkDisabled={runtimeBusy}
        />

        <ActivityColumn
          items={activityItems}
          hidden={hiddenActivity}
          collapsedLogs={collapsedLogs}
          onToggle={(type) =>
            setHiddenActivity((current) => {
              const next = new Set(current);
              next.has(type) ? next.delete(type) : next.add(type);
              return next;
            })}
          onToggleCollapse={(type) =>
            setCollapsedLogs((current) => {
              const next = new Set(current);
              next.has(type) ? next.delete(type) : next.add(type);
              return next;
            })}
          onClear={() => setItems((current) => current.filter((item) => item.kind === "user" || item.kind === "assistant"))}
        />
      </div>

      <TabBar
        workspaces={workspaces}
        activeWs={activeWs}
        onSwitch={(id) => {
          setActiveWs(id);
          send({ type: "switch_workspace", workspaceId: id });
        }}
        onClose={(id) => send({ type: "close_workspace", workspaceId: id })}
        onOpen={() => openWorkspaceByPath(send, t)}
      />
    </div>
    </I18nProvider>
  );
}

function Topbar({
  state,
  status,
  theme,
  onThemeChange,
  lang,
  onLangChange,
}: {
  state: SessionState | null;
  status: string;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
}) {
  const t = useT();
  const ws = state?.cwd ?? "—";
  return (
    <header className="topbar">
      <div className="brand">
        <span className="dot" />
        <b>pi</b>
        <span className="ws mono" title={ws}>{t.workspaceLabel} · {ws}</span>
      </div>
      <span className="spacer" />
      <span className={`pill ${status === "open" ? "ok" : ""}`}>
        {status === "open" ? t.connected : status}
      </span>
      <div className="theme-toggle" role="group" aria-label={t.langToggle}>
        <button type="button" aria-pressed={lang === "zh"} aria-label={t.langZh} onClick={() => onLangChange("zh")}>
          {t.langZh}
        </button>
        <button type="button" aria-pressed={lang === "en"} aria-label={t.langEn} onClick={() => onLangChange("en")}>
          {t.langEn}
        </button>
      </div>
      <button
        type="button"
        className="theme-icon-btn"
        aria-label={t.themeToggle}
        title={theme === "dark" ? t.lightTheme : t.darkTheme}
        onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
    </header>
  );
}

function SessionColumn({
  groups,
  pinnedGroups,
  pinnedSessions,
  expandedGroups,
  activeSessionId,
  runtimeBusy,
  onNewSession,
  onSelect,
  onTogglePin,
  onToggleExpanded,
  onClone,
  onDeleteSessions,
}: {
  groups: SessionTreeNode[];
  pinnedGroups: SessionTreeNode[];
  pinnedSessions: Set<string>;
  expandedGroups: Set<string>;
  activeSessionId?: string;
  runtimeBusy: boolean;
  onNewSession: () => void;
  onSelect: (path: string) => void;
  onTogglePin: (rootPath: string) => void;
  onToggleExpanded: (rootPath: string) => void;
  onClone: (sessionPath: string) => void;
  onDeleteSessions: (paths: string[]) => void;
}) {
  const t = useT();
  const count = groups.length + pinnedGroups.length;

  return (
    <section className="col col-sessions">
      <div className="col-head">
        <h2>{t.sessions}</h2>
        <span className="count">{count}</span>
        <span className="spacer" />
      </div>

      <div className="col-scroll">
        {count === 0 && <div className="empty">{t.noSessions}</div>}

        {pinnedGroups.length > 0 && (
          <>
            <div className="region-label">
              <span className="ico"><PinIcon /></span>
              <span>{t.pinned}</span>
            </div>
            <div id="pin-region">
              {pinnedGroups.map((node) => (
                <SessionGroup
                  key={node.session.path}
                  node={node}
                  pinned
                  expanded={isGroupExpanded(node, expandedGroups, activeSessionId)}
                  activeSessionId={activeSessionId}
                  runtimeBusy={runtimeBusy}
                  onSelect={onSelect}
                  onTogglePin={onTogglePin}
                  onToggleExpanded={onToggleExpanded}
                  onClone={onClone}
                  onDeleteSessions={onDeleteSessions}
                />
              ))}
            </div>
            <div className="pin-divider"><span>{t.otherSessions}</span></div>
          </>
        )}

        <div id="normal-region">
          {groups.map((node) => (
            <SessionGroup
              key={node.session.path}
              node={node}
              pinned={pinnedSessions.has(node.session.path)}
              expanded={isGroupExpanded(node, expandedGroups, activeSessionId)}
              activeSessionId={activeSessionId}
              runtimeBusy={runtimeBusy}
              onSelect={onSelect}
              onTogglePin={onTogglePin}
              onToggleExpanded={onToggleExpanded}
              onClone={onClone}
              onDeleteSessions={onDeleteSessions}
            />
          ))}
        </div>
      </div>
      <div className="session-foot">
        <button className="new-session-btn" type="button" onClick={onNewSession} title={t.newSessionTitle}>
          <PlusIcon />
          <span>{t.newSession}</span>
        </button>
      </div>
    </section>
  );
}

function SessionGroup({
  node,
  pinned,
  expanded,
  activeSessionId,
  runtimeBusy,
  onSelect,
  onTogglePin,
  onToggleExpanded,
  onClone,
  onDeleteSessions,
}: {
  node: SessionTreeNode;
  pinned: boolean;
  expanded: boolean;
  activeSessionId?: string;
  runtimeBusy: boolean;
  onSelect: (path: string) => void;
  onTogglePin: (rootPath: string) => void;
  onToggleExpanded: (rootPath: string) => void;
  onClone: (sessionPath: string) => void;
  onDeleteSessions: (paths: string[]) => void;
}) {
  const t = useT();
  const descendants = useMemo(() => flattenForkRows(node), [node]);
  const descendantPaths = useMemo(() => collectDescendantPaths(node), [node]);
  const hasForks = descendants.length > 0;
  const rootActive = node.session.id === activeSessionId;
  const activeChild = descendants.some((row) => row.session.id === activeSessionId);
  const deleteDisabled = rootActive || activeChild;
  const cloneDisabled = runtimeBusy;

  return (
    <div className={`session-group ${expanded ? "expanded" : ""}`}>
      <div
        className={`session ${rootActive ? "active" : ""} ${pinned ? "pinned" : ""}`}
        onClick={() => onSelect(node.session.path)}
        title={node.session.firstMessage}
      >
        <div className="row">
          <span className="tagdot" />
          <span className="session-name">{displaySessionLabel(node.session)}</span>
          <span className="spacer" />
          <span className="ts-inline mono">{relTime(node.session.modified, t)}</span>
          <div className="acts">
            <ActionButton
              className="clone-btn"
              title={cloneDisabled ? t.cloneDisabledStreaming : t.cloneToMain}
              label={t.cloneSession}
              disabled={cloneDisabled}
              onClick={() => onClone(node.session.path)}
            >
              <CloneIcon />
            </ActionButton>
            <ActionButton
              className="pin-btn"
              title={pinned ? t.unpin : t.pin}
              label={pinned ? t.unpin : t.pin}
              onClick={() => onTogglePin(node.session.path)}
            >
              <PinIcon />
            </ActionButton>
            <ActionButton
              className="del-btn"
              title={deleteDisabled ? t.deleteDisabledActive : t.deleteSession}
              label={t.deleteSession}
              disabled={deleteDisabled}
              onClick={() => onDeleteSessions([node.session.path, ...descendantPaths])}
            >
              <TrashIcon />
            </ActionButton>
          </div>
        </div>

        {hasForks && (
          <button
            type="button"
            className="fork-expander"
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpanded(node.session.path);
            }}
          >
            <span className="tree-ico"><TreeIcon /></span>
            <span className="fork-count-label">{t.forkCount(descendants.length)}</span>
            <span className="exp-spacer" />
            <span className="exp-toggle">
              <span className="exp-word">{expanded ? t.collapse : t.expand}</span>
              <ChevronIcon className="chev" />
            </span>
          </button>
        )}
      </div>

      {hasForks && (
        <div className="fork-track">
          {descendants.map((row) => {
            const active = row.session.id === activeSessionId;
            return (
              <div
                key={row.session.path}
                className={`fork-line ${active ? "active" : ""}`}
                onClick={() => onSelect(row.session.path)}
                title={row.session.firstMessage}
              >
                <span className="rail mono">{row.rail} </span>
                <span className="fork-title">{displaySessionLabel(row.session)}</span>
                <span className="ts-inline mono">{relTime(row.session.modified, t)}</span>
                <div className="acts">
                  <ActionButton
                    className="clone-btn"
                    title={runtimeBusy ? t.cloneDisabledStreaming : t.cloneToMain}
                    label={t.cloneToIndependent}
                    disabled={runtimeBusy}
                    onClick={() => onClone(row.session.path)}
                  >
                    <CloneIcon />
                  </ActionButton>
                  <ActionButton
                    className="del-btn"
                    title={active ? t.deleteDisabledActive : t.deleteSession}
                    label={t.deleteSession}
                    disabled={active}
                    onClick={() => onDeleteSessions([row.session.path])}
                  >
                    <TrashIcon />
                  </ActionButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  className,
  title,
  label,
  disabled = false,
  onClick,
  children,
}: {
  className: string;
  title: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`s-act ${className}`}
      title={title}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function ChatColumn({
  state,
  items,
  input,
  setInput,
  currentModel,
  models,
  thinkingLevel,
  thinkingOptions,
  sessionName,
  onSubmit,
  onAbort,
  onClearQueue,
  onSetModel,
  onSetThinkingLevel,
  onCompact,
  onRenameSession,
  onForkMessage,
  forkDisabled,
}: {
  state: SessionState | null;
  items: TranscriptItem[];
  input: string;
  setInput: (value: string) => void;
  currentModel: ModelInfo | null;
  models: ModelInfo[];
  thinkingLevel: string;
  thinkingOptions: string[];
  sessionName: string;
  onSubmit: (text?: string, attachments?: PromptAttachment[]) => void;
  onAbort: () => void;
  onClearQueue: () => void;
  onSetModel: (provider: string, modelId: string) => void;
  onSetThinkingLevel: (level: string) => void;
  onCompact: () => void;
  onRenameSession: (nextName: string) => void;
  onForkMessage: (entryId: string, position: "before" | "at") => void;
  forkDisabled: boolean;
}) {
  const t = useT();
  const scrollRef = useAutoScroll(items);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [dropNotice, setDropNotice] = useState<string | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
  }, [input]);

  const showDropNotice = useCallback((message: string) => {
    setDropNotice(message);
    window.setTimeout(() => setDropNotice(null), 2400);
  }, []);

  const handleDrop = useCallback(async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);

    try {
      const next = await readDroppedAttachments(event.dataTransfer, attachments);
      if (next.rejectedDirectories > 0) showDropNotice(t.noFolders);
      if (next.rejectedLarge > 0) showDropNotice(t.ignoredLarge(formatBytes(MAX_ATTACHMENT_BYTES)));
      if (next.attachments.length > attachments.length) setAttachments(next.attachments);
    } catch (error) {
      showDropNotice(error instanceof Error ? error.message : t.readDropFailed);
    }
  }, [attachments, showDropNotice, t]);

  const submitCurrent = useCallback(() => {
    if (!input.trim() && attachments.length === 0) return;
    const trimmed = input.trim();
    const promptAttachments = attachmentsToPrompt(attachments);
    onSubmit(trimmed, promptAttachments);
    setInput("");
    setAttachments([]);
  }, [attachments, input, onSubmit, setInput]);

  const clearQueueToComposer = useCallback(() => {
    const queuedText = state?.steeringMessages.join("\n").trim();
    if (!queuedText) return;
    setInput(input.trim() ? `${input.trim()}\n${queuedText}` : queuedText);
    onClearQueue();
  }, [input, onClearQueue, setInput, state?.steeringMessages]);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    try {
      const next = await readFileAttachments([...files], attachments);
      if (next.rejectedLarge > 0) showDropNotice(t.ignoredLarge(formatBytes(MAX_ATTACHMENT_BYTES)));
      if (next.attachments.length > attachments.length) setAttachments(next.attachments);
    } catch (error) {
      showDropNotice(error instanceof Error ? error.message : t.readFileFailed);
    }
  }, [attachments, showDropNotice, t]);

  return (
    <section className="col col-chat">
      <div className="col-head">
        <SessionNameEditor value={sessionName} onSubmit={onRenameSession} />
        <span className="spacer" />
        {state && <span className="count mono">session #{state.sessionId.slice(0, 6)}</span>}
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {items.length === 0 && <div className="empty-chat"><p>{t.startConversation}</p></div>}
        {items.map((item) =>
          item.kind === "divider" ? (
            <ChatDivider key={item.id} text={item.text} />
          ) : (
            <MessageBubble
              key={item.id}
              item={item}
              providerId={currentModel?.provider ?? state?.model?.provider ?? "local"}
              onForkMessage={onForkMessage}
              forkDisabled={forkDisabled}
            />
          ),
        )}
      </div>

      <div className="composer">
        <div className="composer-bar">
          <div className="model-group">
            <ModelPicker currentModel={currentModel} models={models} onSetModel={onSetModel} />
            <ThinkingLevelTabs
              currentLevel={thinkingLevel}
              options={thinkingOptions}
              onSetLevel={onSetThinkingLevel}
            />
          </div>
          <div className="composer-status">
            {state?.isStreaming && (
              <button className="abort-chip" type="button" onClick={onAbort} title={t.stopExecution}>
                <StopIcon />
                <span>{t.stop}</span>
              </button>
            )}
            <ContextMeter state={state} onCompact={onCompact} />
          </div>
        </div>
        <SteeringDock
          messages={state?.steeringMessages ?? []}
          onClearToComposer={clearQueueToComposer}
        />
        <div
          className={`box ${dragActive ? "drag-active" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
          }}
          onDrop={(event) => void handleDrop(event)}
        >
          {dragActive && (
            <div className="drop-overlay">
              <strong>{t.dropToAttach}</strong>
              <span>{t.dropHint}</span>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="attach-tray" aria-label={t.attachedFiles}>
              {attachments.map((attachment) => (
                <span className="file-card" key={attachment.id} title={`${attachment.name} · ${formatBytes(attachment.size)}`}>
                  <span className={`fc-ico ${attachment.type}`}><FileIcon /></span>
                  <span className="fc-main">
                    <span className="fc-name mono">{attachment.name}</span>
                    <span className="fc-meta mono">{attachment.type === "image" ? "image" : "text"} · {formatBytes(attachment.size)}</span>
                  </span>
                  <button
                    type="button"
                    className="fc-x"
                    aria-label={t.removeFile(attachment.name)}
                    title={t.removeAttachment}
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="input-row">
            <button
              type="button"
              className="attach-btn"
              aria-label={t.attachFile}
              title={t.attachFile}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const files = event.currentTarget.files;
                if (files?.length) void handleFiles(files);
                event.currentTarget.value = "";
              }}
            />
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              placeholder={state?.isStreaming ? t.placeholderStreaming : t.placeholderIdle}
              onChange={(e) => {
                setInput(e.target.value);
              }}
              onKeyDown={(e) => {
                if (isComposingKeyEvent(e.nativeEvent)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitCurrent();
                }
              }}
            />
            <button className="send" onClick={submitCurrent} aria-label={t.sendAria} title={state?.isStreaming ? t.joinSteerQueue : t.send}>
              <SendIcon />
            </button>
          </div>
        </div>
        {dropNotice && <div className="drop-notice">{dropNotice}</div>}
      </div>
    </section>
  );
}

function SteeringDock({
  messages,
  onClearToComposer,
}: {
  messages: string[];
  onClearToComposer: () => void;
}) {
  const t = useT();
  if (messages.length === 0) return null;
  return (
    <div className="steering-dock has-items" aria-label={t.steerQueueAria}>
      <div className="steering-label">
        <span className="steering-title">
          <span className="pulse" />
          <span className="mono">{t.steerQueueLabel}</span>
        </span>
        <button className="queue-clear" type="button" onClick={onClearToComposer} title={t.clearAllToComposer}>
          {t.clearAll}
        </button>
      </div>
      <div className="steering-stack">
        {messages.map((message, index) => (
          <SteeringChip key={`${index}-${message}`} message={message} index={index} />
        ))}
      </div>
    </div>
  );
}

function SteeringChip({
  message,
  index,
}: {
  message: string;
  index: number;
}) {
  return (
    <div className="steering-chip">
      <span className="sc-index mono">{index + 1}</span>
      <span className="sc-text" title={message}>{message}</span>
    </div>
  );
}

function SessionNameEditor({
  value,
  onSubmit,
}: {
  value: string;
  onSubmit: (nextName: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value.slice(0, 40));

  useEffect(() => {
    if (!editing) setDraft(value.slice(0, 40));
  }, [editing, value]);

  if (editing) {
    return (
      <div className="sess-name" id="sessName">
        <input
          autoFocus
          className="name-input"
          maxLength={40}
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 40))}
          onBlur={() => {
            if (draft.trim()) onSubmit(draft);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (draft.trim()) onSubmit(draft);
              setEditing(false);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(value.slice(0, 40));
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="sess-name" id="sessName">
      <span className="name-text" title={value} onDoubleClick={() => setEditing(true)}>
        {value.slice(0, 40)}
      </span>
      <button
        type="button"
        className="edit-btn"
        aria-label={t.editSessionTitle}
        title={t.editSessionTitle}
        onClick={() => setEditing(true)}
      >
        <EditIcon />
      </button>
    </div>
  );
}

function MessageBubble({
  item,
  providerId,
  onForkMessage,
  forkDisabled,
}: {
  item: TranscriptItem;
  providerId: string;
  onForkMessage: (entryId: string, position: "before" | "at") => void;
  forkDisabled: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const isUser = item.kind === "user";
  const forkPosition = isUser ? "before" : "at";
  const forkTitle = forkDisabled
    ? t.forkDisabledBusy
    : item.sourceEntryId
      ? isUser
      ? t.forkRewrite
      : t.forkToReply
      : t.forkUnavailable;

  const copyText = useCallback(async () => {
    await navigator.clipboard.writeText(item.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [item.text]);

  return (
    <div className={`msg ${isUser ? "user" : "agent"}`}>
      <span className={`av ${isUser ? "" : "prov-av"}`}>
        {isUser ? (
          <img src="/avatar.jpg" alt="" />
        ) : (
          <span
            className="prov"
            data-prov={providerId}
            dangerouslySetInnerHTML={{ __html: providerIcon(providerId) }}
          />
        )}
      </span>
      <div className="bubble">
        <span className="who">{isUser ? "you" : "pi"}</span>
        <MarkdownMessage text={displayMessageText(item)} />
        <div className="msg-acts">
          <button
            type="button"
            className={`msg-act ${copied ? "copied" : ""}`}
            aria-label={t.copyMessage}
            title={t.copyMessage}
            onClick={() => void copyText()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button
            type="button"
            className="msg-act"
            aria-label={t.forkSession}
            title={forkTitle}
            disabled={!item.sourceEntryId || forkDisabled}
            onClick={() => item.sourceEntryId && !forkDisabled && onForkMessage(item.sourceEntryId, forkPosition)}
          >
            <ForkIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="text markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkGemoji]}>{text}</ReactMarkdown>
    </div>
  );
}

function ChatDivider({ text }: { text: string }) {
  return (
    <div className="chat-divider" role="separator">
      <span>{text}</span>
    </div>
  );
}

function ModelPicker({
  currentModel,
  models,
  onSetModel,
}: {
  currentModel: ModelInfo | null;
  models: ModelInfo[];
  onSetModel: (provider: string, modelId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const model of models) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    return [...byProvider.entries()];
  }, [models]);

  return (
    <div className={`model-picker ${open ? "open" : ""}`} ref={ref}>
      <button
        className="model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <span
          className="prov"
          data-prov={currentModel?.provider ?? "local"}
          dangerouslySetInnerHTML={{ __html: providerIcon(currentModel?.provider ?? "local") }}
        />
        <span className="model-name">{currentModel?.name ?? t.noModel}</span>
        <span className="caret"><CaretIcon /></span>
      </button>

      <div className="model-menu" role="listbox">
        {groups.length === 0 && <div className="menu-empty">{t.noConfiguredModels}</div>}
        {groups.map(([provider, list]) => (
          <div key={provider}>
            <div className="grp-label">
              <span
                className="prov"
                data-prov={provider}
                dangerouslySetInnerHTML={{ __html: providerIcon(provider) }}
              />
              {provider}
            </div>
            {list.map((model) => {
              const selected = currentModel?.provider === model.provider && currentModel.id === model.id;
              return (
                <div
                  key={`${model.provider}/${model.id}`}
                  className="opt"
                  aria-selected={selected}
                  onClick={() => {
                    onSetModel(model.provider, model.id);
                    setOpen(false);
                  }}
                >
                  <span className="nm">{model.name}</span>
                  <span className="tag mono">{Math.round(model.contextWindow / 1000)}K</span>
                  <span
                    className="check"
                    dangerouslySetInnerHTML={{ __html: selected ? CHECK_ICON : "" }}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function ThinkingLevelTabs({
  currentLevel,
  options,
  onSetLevel,
}: {
  currentLevel: string;
  options: string[];
  onSetLevel: (level: string) => void;
}) {
  const t = useT();
  const normalized = useMemo(() => normalizeThinkingOptions(options), [options]);
  if (normalized.length <= 1) return null;
  return (
    <div className="effort-tabs" role="radiogroup" aria-label={t.thinkingStrength}>
      {normalized.map((option) => (
        <button
          key={option.id}
          type="button"
          className="effort-tab"
          role="radio"
          aria-checked={option.id === currentLevel}
          title={t.thinkingStrengthTitle(option.label)}
          onClick={() => onSetLevel(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ContextMeter({
  state,
  onCompact,
}: {
  state: SessionState | null;
  onCompact: () => void;
}) {
  const t = useT();
  const usage = state?.contextUsage;
  const pct = usage?.percent == null ? 0 : Math.min(100, Math.round(usage.percent));
  const meterClass = pct >= 85 ? "high" : pct >= 60 ? "warn" : "";
  const label = usage
    ? `${Math.round((usage.tokens ?? 0) / 1000)}K / ${Math.round(usage.contextWindow / 1000)}K · ${pct}%`
    : "—";

  return (
    <div className={`ctx-meter ${meterClass}`} title={t.contextUsage}>
      <span className="label mono">{label}</span>
      <span className="bar"><span className="fill" style={{ width: `${pct}%` }} /></span>
      <button
        type="button"
        className={`ctx-compress ${state?.isCompacting ? "busy" : ""}`}
        onClick={onCompact}
        disabled={!state || state.isCompacting}
        title={t.compactTitle}
        aria-label={t.compactAria}
      >
        <CompressIcon />
        <span>{t.compact}</span>
      </button>
    </div>
  );
}

function ActivityColumn({
  items,
  hidden,
  collapsedLogs,
  onToggle,
  onToggleCollapse,
  onClear,
}: {
  items: TranscriptItem[];
  hidden: Set<ActivityType>;
  collapsedLogs: Set<ActivityType>;
  onToggle: (type: ActivityType) => void;
  onToggleCollapse: (type: ActivityType) => void;
  onClear: () => void;
}) {
  const t = useT();
  const visible = items.filter((item) => !hidden.has(resolveActivityType(item)));
  const scrollRef = useAutoScroll(visible);

  return (
    <section className="col col-logs">
      <div className="col-head">
        <h2>{t.activity}</h2>
        <span className="spacer" />
        <button className="ghost-btn" onClick={onClear}>{t.clear}</button>
      </div>

      <div className="log-filters">
        {ACTIVITY_TYPES.map((type) => (
          <span
            key={type}
            className="chip"
            data-type={type}
            aria-pressed={!hidden.has(type)}
            onClick={() => onToggle(type)}
          >
            <span className="swatch" data-type={type} />
            {t.activityLabels[type]}
          </span>
        ))}
      </div>

      <div className="col-scroll" ref={scrollRef}>
        {visible.length === 0 && <div className="empty">{t.noActivity}</div>}
        {visible.map((item) => {
          const type = resolveActivityType(item);
          const collapsed = collapsedLogs.has(type);
          return (
            <div key={item.id} className={`log ${collapsed ? "collapsed" : ""}`} data-type={type}>
              <div className="head" onClick={() => onToggleCollapse(type)}>
                <span className="badge" />
                <span className="title mono">{`{${t.activityLabels[type]}}`}</span>
              </div>
              {!collapsed && <div className="body mono">{item.text}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TabBar({
  workspaces,
  activeWs,
  onSwitch,
  onClose,
  onOpen,
}: {
  workspaces: Workspace[];
  activeWs: string | null;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <nav className="tabbar">
      <button className="tab-add" onClick={onOpen} title={t.openWorkspace}>+</button>
      <div className="tab-track">
        {workspaces.map((workspace) => (
          <div
            key={workspace.id}
            className={`tab ${workspace.id === activeWs ? "active" : ""}`}
            onClick={() => onSwitch(workspace.id)}
            title={workspace.path}
          >
            <span className={`stat ${workspace.status}`} />
            <span className="nm">
              {workspace.name}
              <small className="mono">pi · {workspace.status}</small>
            </span>
            <button
              className="x"
              aria-label={t.close}
              onClick={(e) => {
                e.stopPropagation();
                onClose(workspace.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </nav>
  );
}

function useAutoScroll(items: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items]);
  return ref;
}

function loadCollapsed(): Set<ActivityType> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORE);
    if (raw) return new Set(JSON.parse(raw) as ActivityType[]);
  } catch {
    // ignore
  }
  return new Set<ActivityType>(ACTIVITY_TYPES.filter((type) => type !== "reasoning"));
}

function loadHidden(): Set<ActivityType> {
  try {
    const raw = localStorage.getItem(HIDDEN_STORE);
    if (raw) return new Set(JSON.parse(raw) as ActivityType[]);
  } catch {
    // ignore
  }
  return new Set();
}

function loadPinnedSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_STORE);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // ignore
  }
  return new Set();
}

function loadSessionNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSION_NAME_STORE);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    // ignore
  }
  return {};
}

function loadStoredModel(): StoredModelChoice | null {
  try {
    const raw = localStorage.getItem(MODEL_STORE);
    return raw ? (JSON.parse(raw) as StoredModelChoice) : null;
  } catch {
    return null;
  }
}

function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORE) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function resolveCurrentModel(
  models: ModelInfo[],
  activeModel: ModelInfo | undefined,
  workspaceDefaultModel: ModelInfo | undefined,
  storedModel: StoredModelChoice | null,
): ModelInfo | null {
  if (activeModel) return activeModel;
  if (workspaceDefaultModel) {
    const match = models.find((model) =>
      model.provider === workspaceDefaultModel.provider && model.id === workspaceDefaultModel.id);
    return match ?? workspaceDefaultModel;
  }
  if (storedModel) {
    const match = models.find((model) =>
      model.provider === storedModel.prov && model.id === storedModel.model);
    if (match) return match;
  }
  return models[0] ?? null;
}

function openWorkspaceByPath(send: (msg: ClientMessage) => void, t: Strings): void {
  const path = window.prompt(t.openWorkspaceByPathPrompt);
  if (path && path.trim()) send({ type: "open_workspace", path: path.trim() });
}

function resolveThinkingOptions(
  state: SessionState | null,
  activeWorkspace: Workspace | null,
  currentModel: ModelInfo | null,
): string[] {
  if (state?.availableThinkingLevels?.length) {
    return state.availableThinkingLevels;
  }
  const workspaceModel = activeWorkspace?.defaultModel;
  if (
    currentModel &&
    workspaceModel &&
    currentModel.provider === workspaceModel.provider &&
    currentModel.id === workspaceModel.id &&
    activeWorkspace?.defaultThinkingLevels?.length
  ) {
    return activeWorkspace.defaultThinkingLevels;
  }
  if (currentModel?.thinkingLevels?.length) return currentModel.thinkingLevels;
  return ["off"];
}

function normalizeThinkingOptions(options: string[]): ThinkingOption[] {
  const unique = [...new Set(options)];
  return unique.map((id) => ({ id, label: thinkingLabel(id) }));
}

function thinkingLabel(level: string): string {
  switch (level) {
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Max";
    default:
      return level;
  }
}

function sessionStorageKey(state: SessionState | null): string | null {
  return state ? `${state.workspaceId}:${state.sessionId}` : null;
}

function buildSessionTree(sessions: SessionSummary[]): SessionTreeNode[] {
  const byPath = new Map(sessions.map((session) => [session.path, { session, children: [] as SessionTreeNode[] }]));
  const roots: SessionTreeNode[] = [];

  for (const node of byPath.values()) {
    const parent = node.session.parentSessionPath;
    if (parent && byPath.has(parent)) {
      byPath.get(parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortTree = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => +new Date(b.session.modified) - +new Date(a.session.modified));
    nodes.forEach((node) => sortTree(node.children));
  };

  sortTree(roots);
  return roots;
}

function flattenForkRows(node: SessionTreeNode): ForkRow[] {
  const rows: ForkRow[] = [];
  const visit = (children: SessionTreeNode[], ancestorsLast: boolean[]) => {
    children.forEach((child, index) => {
      const isLast = index === children.length - 1;
      let rail = "";
      ancestorsLast.forEach((ancestorIsLast) => {
        rail += ancestorIsLast ? "  " : "│ ";
      });
      rail += `${isLast ? "└─" : "├─"}●`;
      rows.push({ session: child.session, rail });
      visit(child.children, [...ancestorsLast, isLast]);
    });
  };
  visit(node.children, []);
  return rows;
}

function collectDescendantPaths(node: SessionTreeNode): string[] {
  const paths: string[] = [];
  const visit = (current: SessionTreeNode) => {
    for (const child of current.children) {
      paths.push(child.session.path);
      visit(child);
    }
  };
  visit(node);
  return paths;
}

function isGroupExpanded(
  node: SessionTreeNode,
  expandedGroups: Set<string>,
  activeSessionId?: string,
): boolean {
  return expandedGroups.has(node.session.path) || hasActiveDescendant(node, activeSessionId);
}

function hasActiveDescendant(node: SessionTreeNode, activeSessionId?: string): boolean {
  if (!activeSessionId) return false;
  return node.children.some((child) =>
    child.session.id === activeSessionId || hasActiveDescendant(child, activeSessionId));
}

function displaySessionLabel(session: SessionSummary): string {
  return session.name || session.firstMessage || session.id.slice(0, 8);
}

function resolveActivityType(item: TranscriptItem): ActivityType {
  return (item.activity ??
    (item.kind === "reasoning" ? "reasoning" : item.kind === "system" ? "system" : "tool")) as ActivityType;
}

function isRuntimeBusy(state: SessionState | null): boolean {
  return Boolean(
    state?.isStreaming ||
      state?.isCompacting ||
      state?.steeringMessages.length ||
      state?.followUpMessages.length,
  );
}

function isComposingKeyEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

async function readDroppedAttachments(
  transfer: DataTransfer,
  current: ComposerAttachment[],
): Promise<{ attachments: ComposerAttachment[]; rejectedDirectories: number; rejectedLarge: number }> {
  const items = [...transfer.items].filter((item) => item.kind === "file");
  const files: File[] = [];
  let rejectedDirectories = 0;

  for (const raw of items) {
    const item = raw as DataTransferItemWithHandles;
    const handle = item.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
    if (handle?.kind === "directory" || item.webkitGetAsEntry?.()?.isDirectory) {
      rejectedDirectories += 1;
      continue;
    }
    const file = handle?.kind === "file" ? await handle.getFile() : item.getAsFile();
    if (file) files.push(file);
  }

  const next = await readFileAttachments(files, current);
  return { ...next, rejectedDirectories };
}

async function readFileAttachments(
  files: File[],
  current: ComposerAttachment[],
): Promise<{ attachments: ComposerAttachment[]; rejectedLarge: number }> {
  let rejectedLarge = 0;
  let totalBytes = current.reduce((sum, item) => sum + item.size, 0);
  const accepted = [...current];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES || totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      rejectedLarge += 1;
      continue;
    }
    accepted.push(await fileToAttachment(file));
    totalBytes += file.size;
  }

  return { attachments: accepted, rejectedLarge };
}

async function fileToAttachment(file: File): Promise<ComposerAttachment> {
  const id = crypto.randomUUID();
  const mimeType = file.type || guessMimeType(file.name);
  if (mimeType.startsWith("image/")) {
    return {
      id,
      type: "image",
      name: file.name,
      size: file.size,
      mimeType,
      data: arrayBufferToBase64(await file.arrayBuffer()),
    };
  }

  return {
    id,
    type: "text",
    name: file.name,
    size: file.size,
    mimeType,
    text: await file.text(),
  };
}

function attachmentsToPrompt(attachments: ComposerAttachment[]): PromptAttachment[] {
  return attachments.map((attachment) =>
    attachment.type === "image"
      ? {
          type: "image",
          name: attachment.name,
          mimeType: attachment.mimeType ?? "image/png",
          data: attachment.data ?? "",
        }
      : {
          type: "text",
          name: attachment.name,
          text: attachment.text ?? "",
        },
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function guessMimeType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "text/plain";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSubmittedText(text: string, attachments: PromptAttachment[]): string {
  if (attachments.length === 0) return text;
  const attached = attachments.map((attachment) => `- ${attachment.name}`).join("\n");
  return text ? `Attached:\n${attached}\n\n${text}` : `Attached:\n${attached}`;
}

function displayMessageText(item: TranscriptItem): string {
  return item.kind === "user" ? collapseFileBlocks(item.text) : item.text;
}

function collapseFileBlocks(text: string): string {
  const names: string[] = [];
  const stripped = text.replace(/<file name="([^"]*)">[\s\S]*?<\/file>\s*/g, (_match, rawName: string) => {
    names.push(decodeFileName(rawName));
    return "";
  }).trim();
  if (names.length === 0) return text;
  const attached = names.map((name) => `- ${name}`).join("\n");
  return stripped ? `Attached:\n${attached}\n\n${stripped}` : `Attached:\n${attached}`;
}

function decodeFileName(name: string): string {
  return name
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function providerIcon(id: string): string {
  if (id && PROVIDER_ICONS[id]) return PROVIDER_ICONS[id];
  const letter = (id || "?").trim().charAt(0).toUpperCase() || "?";
  return `<svg viewBox="0 0 24 24"><text x="12" y="12" text-anchor="middle" dominant-baseline="central" font-size="13" font-weight="700" font-family="system-ui,sans-serif" fill="currentColor">${letter}</text></svg>`;
}

function relTime(iso: string, t: Strings): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return t.now;
  if (min < 60) return t.minutesAgo(min);
  const hr = Math.floor(min / 60);
  if (hr < 24) return t.hoursAgo(hr);
  const day = Math.floor(hr / 24);
  if (day < 7) return t.daysAgo(day);
  return new Date(iso).toLocaleDateString();
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.7M12 18.8v2.7M21.5 12h-2.7M5.2 12H2.5M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9M18.8 18.8l-1.9-1.9M7.1 7.1 5.2 5.2" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M19 14.8A7.5 7.5 0 0 1 9.2 5 8 8 0 1 0 19 14.8z" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M14.9 3.5c.8 0 1.2 1 .6 1.6l-1.1 1.1 4.4 4.4 1.1-1.1c.6-.6 1.6-.2 1.6.6v.4c0 .5-.2 1-.6 1.4l-2.8 2.8-4.2-.7-4.9 4.9v4.3l-.7.7-.7-.7v-4.3l4.9-4.9-.7-4.2 2.8-2.8c.4-.4.9-.6 1.4-.6h.4z" />
    </svg>
  );
}

function CloneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <rect x="5" y="5" width="10" height="10" rx="2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 1H8a2 2 0 0 1-2-1L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5 10 17l9-10" />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="5" r="2.3" />
      <circle cx="17" cy="5" r="2.3" />
      <circle cx="7" cy="19" r="2.3" />
      <path d="M9.3 5h2.2a4 4 0 0 1 4 4v0" />
      <path d="M7 7.3v7.4" />
      <path d="M9.3 19h2.2a4 4 0 0 0 4-4V9" />
    </svg>
  );
}

function TreeIcon() {
  return (
    <svg viewBox="0 0 16 16">
      <circle cx="4" cy="3.5" r="1.4" />
      <circle cx="4" cy="12.5" r="1.4" />
      <circle cx="12" cy="8" r="1.4" />
      <path d="M4 5v6M4 8h4.5a2 2 0 0 0 2-2V8M4 8h4a2 2 0 0 1 2 2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6.5 8 10.5l4-4" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.2 5.8 8 10.6l4.8-4.8z" />
    </svg>
  );
}

function CompressIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 5h2v6H3l3 3M10 2l3 3h-2v6h2l-3 3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5 12.2 20.3a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 1 1 5.7 5.7l-9.4 9.4a2 2 0 1 1-2.8-2.8l8.7-8.7" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
