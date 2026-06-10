import { createContext, useContext } from "react";

export type Lang = "zh" | "en";
export type ActivityLabelKey = "reasoning" | "tool" | "system" | "error";

export const LANG_STORE = "pi-webui:lang";

/** 所有会出现在前端的文案，按 简体中文 / English 两套维护。 */
export interface Strings {
  // Topbar
  themeToggle: string;
  lightTheme: string;
  darkTheme: string;
  langToggle: string;
  langZh: string;
  langEn: string;
  connected: string;
  workspaceLabel: string;

  // Session column
  sessions: string;
  noSessions: string;
  pinned: string;
  otherSessions: string;
  newSessionTitle: string;
  newSession: string;
  cloneDisabledStreaming: string;
  cloneToMain: string;
  cloneSession: string;
  exportSession: string;
  exportDisabledBusy: string;
  unpin: string;
  pin: string;
  deleteDisabledActive: string;
  deleteSession: string;
  forkCount: (n: number) => string;
  collapse: string;
  expand: string;
  cloneToIndependent: string;

  // Chat column
  startConversation: string;
  stopExecution: string;
  stop: string;
  placeholderStreaming: string;
  placeholderIdle: string;
  joinSteerQueue: string;
  send: string;
  sendAria: string;
  attachFile: string;
  dropToAttach: string;
  dropHint: string;
  attachedFiles: string;
  removeFile: (name: string) => string;
  removeAttachment: string;
  noFolders: string;
  ignoredLarge: (size: string) => string;
  readDropFailed: string;
  readFileFailed: string;
  attachedPrefix: string;
  treeToggle: string;
  treeNavigate: string;
  treeGo: string;
  treeGoTitle: string;
  treeSummarize: string;
  treeEmpty: string;
  treeActive: string;
  treeDisabledBusy: string;

  // Steering dock
  steerQueueAria: string;
  steerQueueLabel: string;
  clearAllToComposer: string;
  clearAll: string;

  // Session name editor
  editSessionTitle: string;
  defaultConversation: string;
  sessionMeta: (tokens: string, cacheRead: string, cacheWrite: string, cost: string) => string;

  // Message bubble
  forkRewrite: string;
  forkToReply: string;
  forkUnavailable: string;
  forkDisabledBusy: string;
  copyMessage: string;
  forkSession: string;

  // Context meter
  contextUsage: string;
  compactTitle: string;
  compactAria: string;
  compact: string;

  // Thinking level
  thinkingStrength: string;
  thinkingStrengthTitle: (label: string) => string;

  // Activity column
  activity: string;
  toolCallCount: (n: number) => string;
  clear: string;
  toolCall: string;
  activityLabels: Record<ActivityLabelKey, string>;
  noActivity: string;

  // Tab bar
  openWorkspace: string;
  openWorkspaceByPathPrompt: string;
  close: string;

  // App level
  abortExecution: string;

  // Model picker
  noModel: string;
  noConfiguredModels: string;

  // Relative time
  now: string;
  minutesAgo: (n: number) => string;
  hoursAgo: (n: number) => string;
  daysAgo: (n: number) => string;
}

const zh: Strings = {
  themeToggle: "主题切换",
  lightTheme: "浅色主题",
  darkTheme: "深色主题",
  langToggle: "语言切换",
  langZh: "简",
  langEn: "EN",
  connected: "已连接 · localhost",
  workspaceLabel: "工作区",

  sessions: "会话",
  noSessions: "还没有会话",
  pinned: "置顶",
  otherSessions: "其余会话",
  newSessionTitle: "新建会话",
  newSession: "新会话",
  cloneDisabledStreaming: "当前 runtime 非 idle，不能克隆",
  cloneToMain: "克隆当前路径为独立主会话",
  cloneSession: "克隆会话",
  exportSession: "导出当前会话",
  exportDisabledBusy: "当前 runtime 非 idle，不能导出",
  unpin: "取消置顶",
  pin: "置顶会话",
  deleteDisabledActive: "不能删除当前活动会话",
  deleteSession: "删除会话",
  forkCount: (n) => `+${n} 分支`,
  collapse: "收起",
  expand: "展开",
  cloneToIndependent: "克隆为独立主会话",

  startConversation: "给 pi 发条消息开始对话。",
  stopExecution: "停止当前执行",
  stop: "停止",
  placeholderStreaming: "当前处理中，Enter 加入 steer 队列，Shift+Enter 换行，Esc 停止当前执行",
  placeholderIdle: "Enter 发送，Shift+Enter 换行，Esc 可停止运行中的 agent",
  joinSteerQueue: "加入 steer 队列",
  send: "发送",
  sendAria: "发送",
  attachFile: "附加文件",
  dropToAttach: "释放以附加文件",
  dropHint: "支持文本与图片，文件夹会被忽略",
  attachedFiles: "已附加文件",
  removeFile: (name) => `移除 ${name}`,
  removeAttachment: "移除附件",
  noFolders: "不支持拖入文件夹",
  ignoredLarge: (size) => `已忽略超过 ${size} 的文件`,
  readDropFailed: "读取拖入文件失败",
  readFileFailed: "读取文件失败",
  attachedPrefix: "已附加：",
  treeToggle: "会话树",
  treeNavigate: "节点导航",
  treeGo: "GO",
  treeGoTitle: "跳转到这个节点（不总结当前分支）",
  treeSummarize: "summarize",
  treeEmpty: "当前会话还没有可导航节点",
  treeActive: "当前路径",
  treeDisabledBusy: "当前 runtime 非 idle，不能切换节点",

  steerQueueAria: "待送入消息队列",
  steerQueueLabel: "待送入 · Pi 原生队列逐条投递",
  clearAllToComposer: "全部取消并回填到编辑框",
  clearAll: "全部取消",

  editSessionTitle: "编辑会话标题",
  defaultConversation: "对话",
  sessionMeta: (tokens, cacheRead, cacheWrite, cost) => `tokens ${tokens} · cache ${cacheRead}/${cacheWrite} · ${cost}`,

  forkRewrite: "Fork 并重写这条消息",
  forkToReply: "Fork 到这条回复",
  forkUnavailable: "当前消息尚不可 fork",
  forkDisabledBusy: "当前 runtime 非 idle，不能 fork",
  copyMessage: "复制消息",
  forkSession: "Fork 会话",

  contextUsage: "当前会话上下文占用",
  compactTitle: "压缩上下文 (/compact)",
  compactAria: "压缩上下文",
  compact: "压缩",

  thinkingStrength: "推理强度",
  thinkingStrengthTitle: (label) => `推理强度：${label}`,

  activity: "活动",
  toolCallCount: (n) => `${n} 工具调用`,
  clear: "清空",
  toolCall: "工具调用",
  activityLabels: {
    reasoning: "推理",
    tool: "工具调用",
    system: "系统",
    error: "错误",
  },
  noActivity: "暂无推理 / 执行日志",

  openWorkspace: "打开 workspace",
  openWorkspaceByPathPrompt: "打开 workspace - 输入项目目录的绝对路径：\nmacOS：在 Finder 中选中文件夹，按 Option+Command+C 复制路径\nWindows：在资源管理器中选中文件夹，Shift+右键，选择 Copy as path",
  close: "关闭",

  abortExecution: "中断执行",

  noModel: "(无模型)",
  noConfiguredModels: "没有已配置的模型",

  now: "现在",
  minutesAgo: (n) => `${n} 分钟前`,
  hoursAgo: (n) => `${n} 小时前`,
  daysAgo: (n) => `${n} 天前`,
};

const en: Strings = {
  themeToggle: "Toggle theme",
  lightTheme: "Light theme",
  darkTheme: "Dark theme",
  langToggle: "Toggle language",
  langZh: "简",
  langEn: "EN",
  connected: "connected · localhost",
  workspaceLabel: "workspace",

  sessions: "Sessions",
  noSessions: "No sessions yet",
  pinned: "Pinned",
  otherSessions: "Other sessions",
  newSessionTitle: "New session",
  newSession: "New session",
  cloneDisabledStreaming: "Runtime is not idle; cloning is disabled",
  cloneToMain: "Clone this path as a standalone main session",
  cloneSession: "Clone session",
  exportSession: "Export active session",
  exportDisabledBusy: "Runtime is not idle; export is disabled",
  unpin: "Unpin",
  pin: "Pin session",
  deleteDisabledActive: "Can't delete the active session",
  deleteSession: "Delete session",
  forkCount: (n) => `+${n} forks`,
  collapse: "Collapse",
  expand: "Expand",
  cloneToIndependent: "Clone as standalone main session",

  startConversation: "Send pi a message to start the conversation.",
  stopExecution: "Stop current execution",
  stop: "Stop",
  placeholderStreaming: "Working - Enter queues a steer message, Shift+Enter for newline, Esc stops the run",
  placeholderIdle: "Enter to send, Shift+Enter for newline, Esc stops a running agent",
  joinSteerQueue: "Add to steer queue",
  send: "Send",
  sendAria: "Send",
  attachFile: "Attach file",
  dropToAttach: "Release to attach files",
  dropHint: "Text and images supported, folders are ignored",
  attachedFiles: "Attached files",
  removeFile: (name) => `Remove ${name}`,
  removeAttachment: "Remove attachment",
  noFolders: "Dropping folders isn't supported",
  ignoredLarge: (size) => `Ignored files larger than ${size}`,
  readDropFailed: "Failed to read dropped files",
  readFileFailed: "Failed to read file",
  attachedPrefix: "Attached:",
  treeToggle: "Session tree",
  treeNavigate: "Node navigation",
  treeGo: "GO",
  treeGoTitle: "Go to this node without summarizing the current branch",
  treeSummarize: "summarize",
  treeEmpty: "No navigable nodes in this session yet",
  treeActive: "active path",
  treeDisabledBusy: "Runtime is not idle; tree navigation is disabled",

  steerQueueAria: "Pending message queue",
  steerQueueLabel: "Pending · delivered one by one via Pi's native queue",
  clearAllToComposer: "Cancel all and move back to the composer",
  clearAll: "Cancel all",

  editSessionTitle: "Edit session title",
  defaultConversation: "Conversation",
  sessionMeta: (tokens, cacheRead, cacheWrite, cost) => `tokens ${tokens} · cache ${cacheRead}/${cacheWrite} · ${cost}`,

  forkRewrite: "Fork and rewrite this message",
  forkToReply: "Fork to this reply",
  forkUnavailable: "This message can't be forked yet",
  forkDisabledBusy: "Runtime is not idle; forking is disabled",
  copyMessage: "Copy message",
  forkSession: "Fork session",

  contextUsage: "Current session context usage",
  compactTitle: "Compact context (/compact)",
  compactAria: "Compact context",
  compact: "Compact",

  thinkingStrength: "Reasoning effort",
  thinkingStrengthTitle: (label) => `Reasoning effort: ${label}`,

  activity: "Activity",
  toolCallCount: (n) => `${n} tool calls`,
  clear: "Clear",
  toolCall: "tool call",
  activityLabels: {
    reasoning: "reasoning",
    tool: "tool call",
    system: "system",
    error: "error",
  },
  noActivity: "No reasoning / execution logs yet",

  openWorkspace: "Open workspace",
  openWorkspaceByPathPrompt: "Open workspace - enter the absolute project path:\nmacOS: select the folder in Finder, then press Option+Command+C to copy its path\nWindows: select the folder in File Explorer, Shift+right-click, then choose Copy as path",
  close: "Close",

  abortExecution: "Execution aborted",

  noModel: "(no model)",
  noConfiguredModels: "No models configured",

  now: "just now",
  minutesAgo: (n) => `${n} min ago`,
  hoursAgo: (n) => `${n} h ago`,
  daysAgo: (n) => `${n} d ago`,
};

export const STRINGS: Record<Lang, Strings> = { zh, en };

export function loadLang(): Lang {
  try {
    return localStorage.getItem(LANG_STORE) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

const I18nContext = createContext<Strings>(zh);

export const I18nProvider = I18nContext.Provider;

export function useT(): Strings {
  return useContext(I18nContext);
}
