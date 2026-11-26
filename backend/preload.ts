import { contextBridge, ipcRenderer } from 'electron';
import type { ServiceResult } from './ipc/capabilities';
import {
  DESKTOP_BRIDGE_KEY,
  DESKTOP_IPC_CHANNELS,
  type DesktopBridge,
  type DesktopStartupInfo,
} from './ipc/contracts';

function isStartupInfo(value: unknown): value is DesktopStartupInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.appName === 'string' &&
    typeof candidate.appVersion === 'string' &&
    (candidate.mode === 'development' ||
      candidate.mode === 'production' ||
      candidate.mode === 'test') &&
    typeof candidate.electronVersion === 'string' &&
    typeof candidate.nodeVersion === 'string' &&
    typeof candidate.chromeVersion === 'string' &&
    typeof candidate.schemaVersion === 'number' &&
    Number.isSafeInteger(candidate.schemaVersion) &&
    typeof candidate.startedAt === 'number' &&
    Number.isFinite(candidate.startedAt)
  );
}

function isEnvelope(value: unknown): value is ServiceResult<unknown> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.status === 'cancelled') return true;
  if (candidate.status === 'error') return typeof candidate.message === 'string';
  return candidate.status === 'success' && 'value' in candidate;
}

async function invoke<T>(
  channel: string,
  ...args: unknown[]
): Promise<ServiceResult<T>> {
  try {
    const result: unknown = await ipcRenderer.invoke(channel, ...args);
    if (!isEnvelope(result)) {
      return { status: 'error', message: '桌面操作返回格式无效。' };
    }
    return result as ServiceResult<T>;
  } catch {
    return { status: 'error', message: '桌面操作不可用，主进程未返回有效结果。' };
  }
}

async function getStartupInfo(): Promise<
  ServiceResult<DesktopStartupInfo>
> {
  if (arguments.length !== 0) {
    return { status: 'error', message: '启动信息请求参数无效。' };
  }
  const result = await invoke<DesktopStartupInfo>(
    DESKTOP_IPC_CHANNELS.getStartupInfo,
  );
  if (result.status === 'success' && !isStartupInfo(result.value)) {
    return {
      status: 'error',
      message: '桌面启动信息格式无效，应用无法确认运行状态。',
    };
  }
  return result;
}

async function loadRecentProjects() {
  return invoke(DESKTOP_IPC_CHANNELS.loadRecentProjects);
}
async function listToolboxes() {
  return invoke(DESKTOP_IPC_CHANNELS.listToolboxes);
}
async function pickProjectFolder(
  purpose: Parameters<DesktopBridge['pickProjectFolder']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.pickProjectFolder, purpose);
}
async function createProject(
  input: Parameters<DesktopBridge['createProject']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.createProject, input);
}
async function openProject(
  input: Parameters<DesktopBridge['openProject']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.openProject, input);
}
async function getProjectAvailability(
  input: Parameters<DesktopBridge['getProjectAvailability']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.getProjectAvailability, input);
}
async function readFile(input: Parameters<DesktopBridge['readFile']>[0]) {
  return invoke(DESKTOP_IPC_CHANNELS.readFile, input);
}

const resolveProjectFileLink: DesktopBridge['resolveProjectFileLink'] = (input) =>
  invoke(DESKTOP_IPC_CHANNELS.resolveProjectFileLink, input);

async function readBinaryResource(
  input: Parameters<
    NonNullable<DesktopBridge['readBinaryResource']>
  >[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.readBinaryResource, input);
}
async function getHtmlPreviewUrl(
  input: Parameters<NonNullable<DesktopBridge['getHtmlPreviewUrl']>>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.getHtmlPreviewUrl, input);
}
async function releaseHtmlPreview(
  input: Parameters<
    NonNullable<DesktopBridge['releaseHtmlPreview']>
  >[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.releaseHtmlPreview, input);
}
async function listH5Datasets(
  input: Parameters<NonNullable<DesktopBridge['listH5Datasets']>>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.listH5Datasets, input);
}
async function readH5DatasetRange(
  input: Parameters<
    NonNullable<DesktopBridge['readH5DatasetRange']>
  >[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.readH5DatasetRange, input);
}
async function createEntry(
  input: Parameters<DesktopBridge['createEntry']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.createEntry, input);
}
async function renameEntry(
  input: Parameters<DesktopBridge['renameEntry']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.renameEntry, input);
}
async function deleteEntry(
  input: Parameters<DesktopBridge['deleteEntry']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.deleteEntry, input);
}
async function pasteEntry(
  input: Parameters<DesktopBridge['pasteEntry']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.pasteEntry, input);
}
async function copyText(text: string) {
  return invoke(DESKTOP_IPC_CHANNELS.copyText, text);
}
async function revealPath(
  input: Parameters<DesktopBridge['revealPath']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.revealPath, input);
}
async function saveFile(input: Parameters<DesktopBridge['saveFile']>[0]) {
  return invoke(DESKTOP_IPC_CHANNELS.saveFile, input);
}
async function saveFileAs(
  input: Parameters<NonNullable<DesktopBridge['saveFileAs']>>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.saveFileAs, input);
}
async function bindProjectToolbox(
  input: Parameters<NonNullable<DesktopBridge['bindProjectToolbox']>>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.bindProjectToolbox, input);
}
async function flushProjectSync(
  input: Parameters<NonNullable<DesktopBridge['flushProjectSync']>>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.flushProjectSync, input);
}
async function listRunningTasks(projectId: string) {
  return invoke(DESKTOP_IPC_CHANNELS.listRunningTasks, projectId);
}
async function stopTask(input: Parameters<DesktopBridge['stopTask']>[0]) {
  return invoke(DESKTOP_IPC_CHANNELS.stopTask, input);
}
async function loadWorkspaceLayout() {
  return invoke(DESKTOP_IPC_CHANNELS.loadWorkspaceLayout);
}
async function saveWorkspaceLayout(
  input: Parameters<DesktopBridge['saveWorkspaceLayout']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.saveWorkspaceLayout, input);
}
async function loadProjectWorkspace(
  input: Parameters<DesktopBridge['loadProjectWorkspace']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.loadProjectWorkspace, input);
}
async function saveProjectWorkspace(
  input: Parameters<DesktopBridge['saveProjectWorkspace']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.saveProjectWorkspace, input);
}
function onQuitRequested(listener: () => void): () => void {
  if (typeof listener !== 'function') return () => undefined;
  const handler = () => {
    try {
      listener();
    } catch {
      // The renderer reports the failure through respondQuit.
    }
  };
  ipcRenderer.on(DESKTOP_IPC_CHANNELS.quitRequested, handler);
  return () => {
    ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.quitRequested, handler);
  };
}
async function respondQuit(
  input: Parameters<DesktopBridge['respondQuit']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.respondQuit, input);
}
async function markQuitReady() {
  return invoke(DESKTOP_IPC_CHANNELS.quitReady);
}

async function getSettingsSnapshot() {
  return invoke(DESKTOP_IPC_CHANNELS.getSettingsSnapshot);
}
async function saveSettings(
  input: Parameters<DesktopBridge['saveSettings']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.saveSettings, input);
}
async function pickCliExecutable() {
  return invoke(DESKTOP_IPC_CHANNELS.pickCliExecutable);
}
async function detectCli(
  input: Parameters<DesktopBridge['detectCli']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.detectCli, input);
}
async function pickToolboxEnvironment(
  input: Parameters<DesktopBridge['pickToolboxEnvironment']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.pickToolboxEnvironment, input);
}
async function detectToolboxEnvironment(
  input: Parameters<DesktopBridge['detectToolboxEnvironment']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.detectToolboxEnvironment, input);
}
async function testSettingsService(
  input: Parameters<DesktopBridge['testSettingsService']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.testSettingsService, input);
}
async function startChatGptLogin() {
  return invoke(DESKTOP_IPC_CHANNELS.startChatGptLogin);
}
async function cancelChatGptLogin() {
  return invoke(DESKTOP_IPC_CHANNELS.cancelChatGptLogin);
}
async function logoutChatGpt() {
  return invoke(DESKTOP_IPC_CHANNELS.logoutChatGpt);
}
async function scanSettingsToolboxes() {
  return invoke(DESKTOP_IPC_CHANNELS.scanSettingsToolboxes);
}
async function cancelSettingsPendingOperations() {
  return invoke(DESKTOP_IPC_CHANNELS.cancelSettingsPendingOperations);
}

async function getChatContext(
  input?: Parameters<DesktopBridge['getChatContext']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.getChatContext, input ?? {});
}
async function listChatConversations(
  input: Parameters<DesktopBridge['listChatConversations']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.listChatConversations, input);
}
async function loadChatConversation(
  input: Parameters<DesktopBridge['loadChatConversation']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.loadChatConversation, input);
}
async function createChatConversation(
  input: Parameters<DesktopBridge['createChatConversation']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.createChatConversation, input);
}
async function saveChatConversationState(
  input: Parameters<DesktopBridge['saveChatConversationState']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.saveChatConversationState, input);
}
async function getChatProjectState(
  input: Parameters<DesktopBridge['getChatProjectState']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.getChatProjectState, input);
}
async function setActiveChatConversation(
  input: Parameters<DesktopBridge['setActiveChatConversation']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.setActiveChatConversation, input);
}
async function selectChatAttachment(
  input: Parameters<DesktopBridge['selectChatAttachment']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.selectChatAttachment, input);
}
async function releaseChatAttachmentPreview(
  input: Parameters<DesktopBridge['releaseChatAttachmentPreview']>[0],
) {
  return invoke(
    DESKTOP_IPC_CHANNELS.releaseChatAttachmentPreview,
    input,
  );
}
async function sendChatMessage(
  input: Parameters<DesktopBridge['sendChatMessage']>[0],
): Promise<import('./ipc/capabilities').ChatSendResult> {
  try {
    const result: unknown = await ipcRenderer.invoke(
      DESKTOP_IPC_CHANNELS.sendChatMessage,
      input,
    );
    if (!result || typeof result !== 'object') {
      return {
        status: 'error',
        message: '发送结果格式无效，原提交可能已到达服务。',
        acceptance: 'unknown',
      };
    }
    const value = result as Record<string, unknown>;
    if (value.status === 'success' && value.value && typeof value.value === 'object') {
      return result as import('./ipc/capabilities').ChatSendResult;
    }
    if (value.status === 'cancelled') {
      return { status: 'cancelled' };
    }
    if (
      value.status === 'error' &&
      typeof value.message === 'string'
    ) {
      return {
        status: 'error',
        message: value.message,
        ...(value.acceptance === 'not-sent' ||
        value.acceptance === 'unknown'
          ? { acceptance: value.acceptance }
          : {}),
      };
    }
    return {
      status: 'error',
      message: '发送结果格式无效，原提交可能已到达服务。',
      acceptance: 'unknown',
    };
  } catch {
    return {
      status: 'error',
      message: '发送结果未知，原提交已保留，请先核实后再发送。',
      acceptance: 'unknown',
    };
  }
}
async function stopChatRun(
  input: Parameters<DesktopBridge['stopChatRun']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.stopChatRun, input);
}

async function respondChatApproval(
  input: Parameters<DesktopBridge['respondChatApproval']>[0],
) {
  return invoke(DESKTOP_IPC_CHANNELS.respondChatApproval, input);
}

function isChatUpdate(
  value: unknown,
): value is import('./ipc/capabilities').ChatUpdate {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'context') {
    return Boolean(record.context && typeof record.context === 'object');
  }
  if (typeof record.projectId !== 'string') return false;
  if (record.type === 'conversation') {
    return Boolean(record.summary && typeof record.summary === 'object');
  }
  if (record.type === 'snapshot') {
    return Boolean(record.snapshot && typeof record.snapshot === 'object');
  }
  if (record.type === 'message') {
    return (
      typeof record.conversationId === 'string' &&
      Boolean(record.message && typeof record.message === 'object')
    );
  }
  if (record.type === 'run') {
    return (
      typeof record.conversationId === 'string' &&
      Boolean(record.run && typeof record.run === 'object')
    );
  }
  if (record.type === 'approvals') {
    return (
      typeof record.conversationId === 'string' &&
      Array.isArray(record.approvals)
    );
  }
  return false;
}

function onChatUpdate(
  listener: (update: import('./ipc/capabilities').ChatUpdate) => void,
): () => void {
  if (typeof listener !== 'function') return () => undefined;
  const handler = (_event: unknown, update: unknown) => {
    if (!isChatUpdate(update)) return;
    try {
      listener(update);
    } catch {
      // The renderer owns its listener failures.
    }
  };
  ipcRenderer.on(DESKTOP_IPC_CHANNELS.chatUpdates, handler);
  return () => {
    ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.chatUpdates, handler);
  };
}

function isSettingsRuntimeUpdate(
  value: unknown,
): value is import('./ipc/capabilities').SettingsRuntimeUpdate {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const runtime = record.runtime;
  if (!runtime || typeof runtime !== 'object') return false;
  const runtimeRecord = runtime as Record<string, unknown>;
  return (
    typeof record.revision === 'number' &&
    Number.isSafeInteger(record.revision) &&
    typeof runtimeRecord.revision === 'number' &&
    Number.isSafeInteger(runtimeRecord.revision) &&
    typeof runtimeRecord.cli === 'object' &&
    Boolean(runtimeRecord.cli) &&
    typeof runtimeRecord.chatgpt === 'object' &&
    Boolean(runtimeRecord.chatgpt) &&
    typeof runtimeRecord.toolboxEnvironments === 'object' &&
    Boolean(runtimeRecord.toolboxEnvironments)
  );
}

function onSettingsRuntime(
  listener: (update: import('./ipc/capabilities').SettingsRuntimeUpdate) => void,
): () => void {
  if (typeof listener !== 'function') return () => undefined;
  const handler = (_event: unknown, update: unknown) => {
    if (!isSettingsRuntimeUpdate(update)) return;
    try {
      listener(update);
    } catch {
      // The renderer owns its listener failures.
    }
  };
  ipcRenderer.on(DESKTOP_IPC_CHANNELS.settingsRuntime, handler);
  return () => {
    ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.settingsRuntime, handler);
  };
}

function isProjectTreeUpdate(
  value: unknown,
): value is import('./ipc/capabilities').ProjectTreeUpdate {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.projectId === 'string' &&
    typeof record.revision === 'number' &&
    Array.isArray(record.tree) &&
    Array.isArray(record.changedFileIdentities) &&
    Array.isArray(record.deletedFileIdentities)
  );
}

function onProjectUpdate(
  listener: (update: import('./ipc/capabilities').ProjectTreeUpdate) => void,
): () => void {
  if (typeof listener !== 'function') return () => undefined;
  const handler = (_event: unknown, update: unknown) => {
    if (!isProjectTreeUpdate(update)) return;
    try {
      listener(update);
    } catch {
      // The renderer owns its listener failures.
    }
  };
  ipcRenderer.on(DESKTOP_IPC_CHANNELS.projectUpdates, handler);
  return () => {
    ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.projectUpdates, handler);
  };
}

function onProjectSyncFailure(
  listener: (
    failure: import('./ipc/capabilities').ProjectSyncFailure,
  ) => void,
): () => void {
  if (typeof listener !== 'function') return () => undefined;
  const handler = (_event: unknown, failure: unknown) => {
    if (!failure || typeof failure !== 'object') return;
    const record = failure as Record<string, unknown>;
    if (
      typeof record.projectId !== 'string' ||
      typeof record.message !== 'string'
    ) {
      return;
    }
    try {
      listener({ projectId: record.projectId, message: record.message });
    } catch {
      // The renderer owns its listener failures.
    }
  };
  ipcRenderer.on(DESKTOP_IPC_CHANNELS.projectSyncFailure, handler);
  return () => {
    ipcRenderer.removeListener(
      DESKTOP_IPC_CHANNELS.projectSyncFailure,
      handler,
    );
  };
}

const bridge = Object.freeze({
  getStartupInfo,
  loadRecentProjects,
  listToolboxes,
  pickProjectFolder,
  createProject,
  openProject,
  getProjectAvailability,
  readFile,
  resolveProjectFileLink,
  readBinaryResource,
  getHtmlPreviewUrl,
  releaseHtmlPreview,
  listH5Datasets,
  readH5DatasetRange,
  createEntry,
  renameEntry,
  deleteEntry,
  pasteEntry,
  copyText,
  revealPath,
  saveFile,
  saveFileAs,
  bindProjectToolbox,
  flushProjectSync,
  onProjectUpdate,
  onProjectSyncFailure,
  listRunningTasks,
  stopTask,
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  loadProjectWorkspace,
  saveProjectWorkspace,
  onQuitRequested,
  markQuitReady,
  respondQuit,
  getSettingsSnapshot,
  saveSettings,
  pickCliExecutable,
  detectCli,
  pickToolboxEnvironment,
  detectToolboxEnvironment,
  testSettingsService,
  startChatGptLogin,
  cancelChatGptLogin,
  logoutChatGpt,
  scanSettingsToolboxes,
  cancelSettingsPendingOperations,
  onSettingsRuntime,
  getChatContext,
  listChatConversations,
  loadChatConversation,
  createChatConversation,
  saveChatConversationState,
  getChatProjectState,
  setActiveChatConversation,
  selectChatAttachment,
  releaseChatAttachmentPreview,
  sendChatMessage,
  stopChatRun,
  respondChatApproval,
  onChatUpdate,
}) as unknown as DesktopBridge;

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge);
