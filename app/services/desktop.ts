import type {
  DesktopBridge,
  DesktopStartupInfo,
} from '../../backend/ipc/contracts';
import type { ChatFgmCapabilities, ServiceResult } from './capabilities';

declare global {
  interface Window {
    readonly chatfgmDesktop?: DesktopBridge;
  }
}

export type DesktopBridgeDetection =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ready'; bridge: DesktopBridge };

/**
 * The browser development entry intentionally has no desktop bridge. A
 * property that exists but is unusable is not treated as the normal browser
 * case, so a broken preload cannot silently fall back to a working-looking
 * page.
 */
export function detectDesktopBridge(): DesktopBridgeDetection {
  if (!('chatfgmDesktop' in window) || window.chatfgmDesktop === undefined) {
    return { kind: 'absent' };
  }
  const candidate = window.chatfgmDesktop;
  if (!candidate || typeof candidate !== 'object') {
    return { kind: 'invalid' };
  }
  const getStartupInfo = (candidate as { getStartupInfo?: unknown })
    .getStartupInfo;
  if (typeof getStartupInfo !== 'function') {
    return { kind: 'invalid' };
  }
  return { kind: 'ready', bridge: candidate as DesktopBridge };
}

export async function readDesktopStartupInfo(
  bridge: DesktopBridge,
): Promise<ServiceResult<DesktopStartupInfo>> {
  try {
    return await bridge.getStartupInfo();
  } catch {
    return {
      status: 'error',
      message: '无法获取启动信息，请重新启动应用。',
    };
  }
}

/**
 * Adapts the explicitly exposed preload operations to the existing frontend
 * capability contract. No in-memory test implementation is used and optional
 * Step 3 viewer methods stay absent instead of returning empty successes.
 */
export function createDesktopCapabilities(
  bridge: DesktopBridge,
): ChatFgmCapabilities {
  return {
    loadRecentProjects: () => bridge.loadRecentProjects(),
    listToolboxes: () => bridge.listToolboxes(),
    pickProjectFolder: (purpose) => bridge.pickProjectFolder(purpose),
    createProject: (input) => bridge.createProject(input),
    openProject: (input) => bridge.openProject(input),
    getProjectAvailability: (input) =>
      bridge.getProjectAvailability(input),
    readFile: (input) => bridge.readFile(input),
    resolveProjectFileLink: (input) => bridge.resolveProjectFileLink(input),
    readBinaryResource: (input) => bridge.readBinaryResource!(input),
    getHtmlPreviewUrl: (input) => bridge.getHtmlPreviewUrl!(input),
    releaseHtmlPreview: (input) => bridge.releaseHtmlPreview!(input),
    listH5Datasets: (input) => bridge.listH5Datasets!(input),
    readH5DatasetRange: (input) => bridge.readH5DatasetRange!(input),
    createEntry: (input) => bridge.createEntry(input),
    renameEntry: (input) => bridge.renameEntry(input),
    deleteEntry: (input) => bridge.deleteEntry(input),
    pasteEntry: (input) => bridge.pasteEntry(input),
    copyText: (text) => bridge.copyText(text),
    revealPath: (input) => bridge.revealPath(input),
    saveFile: (input) => bridge.saveFile(input),
    saveFileAs: (input) => bridge.saveFileAs!(input),
    bindProjectToolbox: (input) => bridge.bindProjectToolbox!(input),
    subscribeProjectUpdates: (listener) => bridge.onProjectUpdate(listener),
    flushProjectSync: (input) => bridge.flushProjectSync(input),
    subscribeProjectSyncFailures: (listener) =>
      bridge.onProjectSyncFailure(listener),
    listRunningTasks: (projectId) => bridge.listRunningTasks(projectId),
    stopTask: (input) => bridge.stopTask(input),
    workspace: {
      loadLayout: () => bridge.loadWorkspaceLayout(),
      saveLayout: (input) => bridge.saveWorkspaceLayout(input),
      loadProjectWorkspace: (input) =>
        bridge.loadProjectWorkspace(input),
      saveProjectWorkspace: (input) =>
        bridge.saveProjectWorkspace(input),
      onQuitRequested: (listener) => bridge.onQuitRequested(listener),
      markQuitReady: () => bridge.markQuitReady(),
      respondQuit: (input) => bridge.respondQuit(input),
    },
    settings: {
      getSnapshot: () => bridge.getSettingsSnapshot(),
      saveSettings: (input) => bridge.saveSettings(input),
      pickCliExecutable: () => bridge.pickCliExecutable(),
      pickToolboxEnvironment: (input) =>
        bridge.pickToolboxEnvironment(input),
      detectCli: (input) => bridge.detectCli(input),
      testServiceConnection: (input) =>
        bridge.testSettingsService(input),
      startChatGptLogin: () => bridge.startChatGptLogin(),
      cancelChatGptLogin: () => bridge.cancelChatGptLogin(),
      logoutChatGpt: () => bridge.logoutChatGpt(),
      scanToolboxes: () => bridge.scanSettingsToolboxes(),
      detectToolboxEnvironment: (input) =>
        bridge.detectToolboxEnvironment(input),
      cancelPendingOperations: () =>
        bridge.cancelSettingsPendingOperations(),
      subscribeUpdates: (listener) => bridge.onSettingsRuntime(listener),
    },
    chat: {
      getContext: (input) => bridge.getChatContext(input),
      listConversations: (input) =>
        bridge.listChatConversations(input),
      loadConversation: (input) => bridge.loadChatConversation(input),
      createConversation: (input) =>
        bridge.createChatConversation(input),
      saveConversationState: (input) =>
        bridge.saveChatConversationState(input),
      getProjectState: (input) => bridge.getChatProjectState(input),
      setActiveConversation: (input) =>
        bridge.setActiveChatConversation(input),
      selectAttachment: (input) => bridge.selectChatAttachment(input),
      releaseAttachmentPreview: (input) =>
        bridge.releaseChatAttachmentPreview(input),
      sendMessage: (input) => bridge.sendChatMessage(input),
      stopRun: (input) => bridge.stopChatRun(input),
      respondApproval: (input) => bridge.respondChatApproval(input),
      subscribeUpdates: (listener) => bridge.onChatUpdate(listener),
    },
  };
}

