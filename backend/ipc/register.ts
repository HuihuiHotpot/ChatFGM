import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { ResolveProjectFileLinkInput, ServiceResult } from '../ipc/capabilities';
import { ProjectServiceError, type ProjectService } from '../projects/service';
import type { ProjectResourceService } from '../projects/resources';
import type { H5Service } from '../h5/service';
import type { WorkspaceService } from '../workspace/service';
import type { SettingsService } from '../settings/service';
import type { ChatService } from '../chat/service';
import type { ProjectFileSyncService } from '../workspace/file-sync';
import { SettingsCancelledError } from '../settings/service';
import {
  DESKTOP_IPC_CHANNELS,
  type DesktopStartupInfo,
} from './contracts';
import { validateDesktopRequest } from './validate';

export interface DesktopIpcOptions {
  mainWindow: BrowserWindow;
  startupInfo: DesktopStartupInfo;
  projectService: ProjectService;
  resourceService: ProjectResourceService;
  h5Service: H5Service;
  workspaceService: WorkspaceService;
  settingsService: SettingsService;
  chatService: ChatService;
  fileSyncService: ProjectFileSyncService;
  onQuitReady: () => void;
  onQuitResponse: (allow: boolean) => void;
  /** Exact top-level URL rule used by the window navigation guard too. */
  isAllowedMainFrameUrl: (url: string) => boolean;
}

const INVALID_ARGUMENTS_MESSAGE = '请求参数无效。';
const UNAUTHORIZED_MESSAGE = '未授权的调用来源。';

function sameFrame(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
): boolean {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return false;
  }
  if (event.sender !== mainWindow.webContents) return false;

  let frame;
  try {
    frame = event.senderFrame;
  } catch {
    return false;
  }
  if (!frame || frame.parent !== null) return false;

  const mainFrame = mainWindow.webContents.mainFrame;
  return (
    frame === mainFrame ||
    (frame.processId === mainFrame.processId &&
      frame.routingId === mainFrame.routingId)
  );
}

function isTrustedSender(
  event: IpcMainInvokeEvent,
  options: DesktopIpcOptions,
): boolean {
  if (!sameFrame(event, options.mainWindow)) return false;
  try {
    const frame = event.senderFrame;
    if (!frame) return false;
    return options.isAllowedMainFrameUrl(frame.url);
  } catch {
    return false;
  }
}

function errorResult(error: unknown): ServiceResult<never> {
  const details =
    error && typeof error === 'object'
      ? (error as {
          code?: unknown;
          existingProjectId?: unknown;
          existingProjectIds?: unknown;
          treeResult?: unknown;
          partial?: unknown;
          currentVersion?: unknown;
        })
      : {};
  return {
    status: 'error',
    message:
      error instanceof Error && error.message
        ? error.message
        : '桌面文件操作失败。',
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(typeof details.existingProjectId === 'string'
      ? { existingProjectId: details.existingProjectId } : {}),
    ...(Array.isArray(details.existingProjectIds)
      ? { existingProjectIds: details.existingProjectIds as string[] } : {}),
    ...(details.treeResult !== undefined
      ? { treeResult: details.treeResult as never }
      : {}),
    ...(details.partial === true ? { partial: true } : {}),
    ...(typeof details.currentVersion === 'string'
      ? { currentVersion: details.currentVersion }
      : {}),
  };
}

/**
 * Registers the explicit desktop operations. Every channel repeats the same
 * top-level sender/frame/URL check before touching a service. There is no
 * generic filesystem or invoke channel.
 */
export function registerDesktopIpc(options: DesktopIpcOptions): () => void {
  const cancellationChannels = new Set<string>([
    DESKTOP_IPC_CHANNELS.pickProjectFolder,
    DESKTOP_IPC_CHANNELS.pickCliExecutable,
    DESKTOP_IPC_CHANNELS.pickToolboxEnvironment,
    DESKTOP_IPC_CHANNELS.selectChatAttachment,
  ]);
  const eventChannels = new Set<string>([
    DESKTOP_IPC_CHANNELS.settingsRuntime,
    DESKTOP_IPC_CHANNELS.chatUpdates,
    DESKTOP_IPC_CHANNELS.projectUpdates,
    DESKTOP_IPC_CHANNELS.projectSyncFailure,
  ]);
  const channels = Object.values(DESKTOP_IPC_CHANNELS).filter(
    (channel) => !eventChannels.has(channel),
  );
  const { projectService, resourceService, h5Service, startupInfo } = options;
  const { workspaceService, settingsService, chatService, fileSyncService } =
    options;
  projectService.setRecreationGuard((id) => chatService.beginProjectRecreation(id));
  const disposeRetirement = projectService.subscribeRetired((id) => {
    fileSyncService.forgetProject(id);
    resourceService.forgetProject(id);
    chatService.forgetProject(id);
  });
  let settingsRuntimeDisposed = false;
  let chatUpdatesDisposed = false;
  let projectUpdatesDisposed = false;
  let projectSyncFailureDisposed = false;
  const disposeSettingsRuntime = settingsService.subscribeUpdates((update) => {
    if (settingsRuntimeDisposed) return;
    const window = options.mainWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(DESKTOP_IPC_CHANNELS.settingsRuntime, update);
  });
  const disposeChatUpdates = chatService.subscribeUpdates((update) => {
    if (chatUpdatesDisposed) return;
    const window = options.mainWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(DESKTOP_IPC_CHANNELS.chatUpdates, update);
  });
  const disposeProjectUpdates = fileSyncService.subscribe((update) => {
    if (projectUpdatesDisposed) return;
    const window = options.mainWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(DESKTOP_IPC_CHANNELS.projectUpdates, update);
  });
  const disposeProjectSyncFailures = fileSyncService.subscribeFailures(
    (failure) => {
      if (projectSyncFailureDisposed) return;
      const window = options.mainWindow;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        return;
      }
      window.webContents.send(
        DESKTOP_IPC_CHANNELS.projectSyncFailure,
        failure,
      );
    },
  );

  const register = (
    channel: string,
    expectedArguments: number,
    operation: (args: unknown[]) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.handle(
      channel,
      async (event, ...args): Promise<ServiceResult<unknown>> => {
        if (!isTrustedSender(event, options)) {
          return { status: 'error', message: UNAUTHORIZED_MESSAGE };
        }
        if (args.length !== expectedArguments) {
          return { status: 'error', message: INVALID_ARGUMENTS_MESSAGE };
        }
        try {
          validateDesktopRequest(channel, args);
        } catch (error) {
          return errorResult(error);
        }
        try {
          const value = await operation(args);
          if (
            value === null &&
            cancellationChannels.has(channel)
          ) {
            return { status: 'cancelled' };
          }
          return { status: 'success', value };
        } catch (error) {
          if (error instanceof SettingsCancelledError) {
            return { status: 'cancelled' };
          }
          return errorResult(error);
        }
      },
    );
  };

  // sendMessage has its own result shape (ChatSendResult). It must not be
  // wrapped in a second ServiceResult envelope or the acceptance state would be
  // lost between the main process and the renderer.
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.sendChatMessage,
    async (event, ...args): Promise<unknown> => {
      if (!isTrustedSender(event, options)) {
        return {
          status: 'error',
          message: UNAUTHORIZED_MESSAGE,
          acceptance: 'not-sent',
        };
      }
      if (args.length !== 1) {
        return {
          status: 'error',
          message: INVALID_ARGUMENTS_MESSAGE,
          acceptance: 'not-sent',
        };
      }
      try {
        validateDesktopRequest(
          DESKTOP_IPC_CHANNELS.sendChatMessage,
          args,
        );
      } catch (error) {
        return {
          ...errorResult(error),
          acceptance: 'not-sent',
        };
      }
      try {
        return await chatService.sendMessage(args[0] as never);
      } catch (error) {
        return {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : '发送结果未知，原提交已保留。',
          acceptance: 'unknown',
        };
      }
    },
  );

  register(DESKTOP_IPC_CHANNELS.getStartupInfo, 0, () => startupInfo);
  register(DESKTOP_IPC_CHANNELS.loadRecentProjects, 0, () =>
    projectService.loadRecentProjects(),
  );
  register(DESKTOP_IPC_CHANNELS.getChatContext, 1, ([input]) => {
    const request = input as
      | { projectId?: string; refresh?: boolean }
      | undefined;
    return chatService.getContext(request);
  });
  register(DESKTOP_IPC_CHANNELS.listChatConversations, 1, ([input]) =>
    chatService.listConversations(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.loadChatConversation, 1, ([input]) =>
    chatService.loadConversation(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.createChatConversation, 1, ([input]) =>
    chatService.createConversation(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.saveChatConversationState, 1, ([input]) =>
    chatService.saveConversationState(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.getChatProjectState, 1, ([input]) => {
    const request = input as { projectId: string };
    return chatService.getProjectState(request.projectId);
  });
  register(DESKTOP_IPC_CHANNELS.setActiveChatConversation, 1, ([input]) =>
    chatService.setActiveConversation(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.selectChatAttachment, 1, ([input]) =>
    chatService.selectAttachment(input as never),
  );
  register(
    DESKTOP_IPC_CHANNELS.releaseChatAttachmentPreview,
    1,
    ([input]) => {
      chatService.releaseAttachmentPreview(input as never);
      return null;
    },
  );
  register(DESKTOP_IPC_CHANNELS.stopChatRun, 1, ([input]) =>
    chatService.stopRun(input as never),
  );

  register(DESKTOP_IPC_CHANNELS.listRunningTasks, 1, ([projectId]) =>
    chatService.listRunningTasks(projectId as string),
  );
  register(DESKTOP_IPC_CHANNELS.listToolboxes, 0, () =>
    projectService.listToolboxes(),
  );
  register(
    DESKTOP_IPC_CHANNELS.pickProjectFolder,
    1,
    ([purpose]) => projectService.pickProjectFolder(purpose as 'create' | 'open'),
  );
  register(DESKTOP_IPC_CHANNELS.createProject, 1, ([input]) =>
    projectService.createProject(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.openProject, 1, ([input]) =>
    projectService.openProject(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.getProjectAvailability, 1, ([input]) => {
    const { projectId } = input as { projectId: string };
    return projectService.getProjectAvailability(projectId);
  });
  register(DESKTOP_IPC_CHANNELS.readFile, 1, ([input]) =>
    projectService.readFile(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.resolveProjectFileLink, 1, async ([input]) => {
    const request = input as ResolveProjectFileLinkInput;
    const indexed = projectService.resolveProjectFileLink(request);
    if (indexed) return indexed;
    await fileSyncService.finalize(request.projectId);
    const synced = projectService.resolveProjectFileLink(request);
    if (synced) return synced;
    throw new ProjectServiceError('entry-not-found', '链接目标未能加入项目文件树。');
  });
  register(DESKTOP_IPC_CHANNELS.readBinaryResource, 1, ([input]) =>
    resourceService.readBinaryResource(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.getHtmlPreviewUrl, 1, ([input]) =>
    resourceService.getHtmlPreviewUrl(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.releaseHtmlPreview, 1, ([input]) =>
    resourceService.releaseHtmlPreview(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.listH5Datasets, 1, ([input]) => {
    const request = input as { projectId: string; fileIdentity: string };
    return h5Service.listDatasets(
      request.projectId,
      request.fileIdentity,
    );
  });
  register(DESKTOP_IPC_CHANNELS.readH5DatasetRange, 1, ([input]) =>
    h5Service.readDatasetRange(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.createEntry, 1, ([input]) =>
    projectService.createEntry(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.renameEntry, 1, ([input]) =>
    projectService.renameEntry(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.deleteEntry, 1, ([input]) =>
    projectService.deleteEntry(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.pasteEntry, 1, ([input]) =>
    projectService.pasteEntry(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.copyText, 1, ([text]) =>
    projectService.copyText(text as string),
  );
  register(DESKTOP_IPC_CHANNELS.revealPath, 1, ([input]) =>
    projectService.revealPath(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.saveFile, 1, ([input]) =>
    projectService.saveFile(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.saveFileAs, 1, ([input]) =>
    projectService.saveFileAs(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.bindProjectToolbox, 1, ([input]) =>
    projectService.bindProjectToolbox(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.flushProjectSync, 1, async ([input]) => {
    const { projectId } = input as { projectId: string };
    await fileSyncService.finalize(projectId);
    return null;
  });
  register(DESKTOP_IPC_CHANNELS.respondChatApproval, 1, ([input]) =>
    chatService.respondApproval(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.stopTask, 1, ([input]) =>
    chatService.stopTask(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.loadWorkspaceLayout, 0, () =>
    workspaceService.loadLayout(),
  );
  register(DESKTOP_IPC_CHANNELS.saveWorkspaceLayout, 1, ([input]) =>
    workspaceService.saveLayout(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.loadProjectWorkspace, 1, ([input]) => {
    const request = input as { projectId: string };
    return workspaceService.loadProjectWorkspace(request.projectId);
  });
  register(DESKTOP_IPC_CHANNELS.saveProjectWorkspace, 1, ([input]) =>
    workspaceService.saveProjectWorkspace(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.respondQuit, 1, ([input]) => {
    const request = input as { allow: boolean };
    options.onQuitResponse(request.allow);
    return null;
  });
  register(DESKTOP_IPC_CHANNELS.quitReady, 0, () => {
    options.onQuitReady();
    return null;
  });
  register(DESKTOP_IPC_CHANNELS.getSettingsSnapshot, 0, () =>
    settingsService.getSnapshot(),
  );
  register(DESKTOP_IPC_CHANNELS.saveSettings, 1, ([input]) =>
    settingsService.saveSettings(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.pickCliExecutable, 0, () =>
    settingsService.pickCliExecutable(),
  );
  register(DESKTOP_IPC_CHANNELS.detectCli, 1, ([input]) => {
    const request = input as { path: string };
    return settingsService.detectCli(request.path);
  });
  register(DESKTOP_IPC_CHANNELS.pickToolboxEnvironment, 1, ([input]) => {
    const request = input as { toolboxId: string };
    return settingsService.pickToolboxEnvironment(request.toolboxId);
  });
  register(DESKTOP_IPC_CHANNELS.detectToolboxEnvironment, 1, ([input]) =>
    settingsService.detectToolboxEnvironment(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.testSettingsService, 1, ([input]) =>
    settingsService.testServiceConnection(input as never),
  );
  register(DESKTOP_IPC_CHANNELS.startChatGptLogin, 0, () =>
    settingsService.startChatGptLogin(),
  );
  register(DESKTOP_IPC_CHANNELS.cancelChatGptLogin, 0, () =>
    settingsService.cancelChatGptLogin(),
  );
  register(DESKTOP_IPC_CHANNELS.logoutChatGpt, 0, () =>
    settingsService.logoutChatGpt(),
  );
  register(DESKTOP_IPC_CHANNELS.scanSettingsToolboxes, 0, () =>
    settingsService.scanToolboxes(),
  );
  register(
    DESKTOP_IPC_CHANNELS.cancelSettingsPendingOperations,
    0,
    () => settingsService.cancelPendingOperations(),
  );

  return () => {
    disposeRetirement();
    settingsRuntimeDisposed = true;
    chatUpdatesDisposed = true;
    projectUpdatesDisposed = true;
    disposeSettingsRuntime();
    disposeChatUpdates();
    disposeProjectUpdates();
    projectUpdatesDisposed = true;
    disposeProjectSyncFailures();
    projectSyncFailureDisposed = true;
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
