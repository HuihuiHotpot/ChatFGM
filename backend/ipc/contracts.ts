import type {
  ChatAttachment,
  ChatCapabilityContext,
  ChatConversationSnapshot,
  ChatConversationSummary,
  ChatProjectChatState,
  ChatSendResult,
  ChatUpdate,
  CreateChatConversationInput,
  GetChatProjectStateInput,
  ListChatConversationsInput,
  LoadChatConversationInput,
  ProjectTreeUpdate,
  ProjectSyncFailure,
  FlushProjectSyncInput,
  ProjectAvailability,
  ProjectAvailabilityInput,
  ReleaseChatAttachmentInput,
  RespondChatApprovalInput,
  SaveChatConversationStateInput,
  SaveChatConversationStateResult,
  SelectChatAttachmentInput,
  SendChatMessageInput,
  SetActiveChatConversationInput,
  StopChatRunInput,
  ChatFgmCapabilities,
  SaveSettingsInput,
  ServiceResult,
  SettingsChatGptAccount,
  SettingsCliDetection,
  SettingsPathSelection,
  SettingsRuntimeUpdate,
  SettingsServiceConnectionTest,
  SettingsSnapshot,
  SettingsToolboxEnvironmentDetection,
  TestSettingsServiceInput,
  ToolboxOption,
} from '../ipc/capabilities';
import type {
  LoadProjectWorkspaceInput,
  ProjectWorkspaceRecord,
  QuitRequestInput,
  SaveProjectWorkspaceInput,
  SaveWorkspaceLayoutInput,
  SaveWorkspaceResult,
  WorkspaceLayoutRecord,
} from '../ipc/workspace';

/** Explicit launch modes. Never inferred from `app.isPackaged`. */
export type DesktopRunMode = 'development' | 'production' | 'test';

export const DESKTOP_IPC_CHANNELS = {
  getStartupInfo: 'chatfgm:desktop:get-startup-info',
  loadRecentProjects: 'chatfgm:desktop:load-recent-projects',
  listToolboxes: 'chatfgm:desktop:list-toolboxes',
  pickProjectFolder: 'chatfgm:desktop:pick-project-folder',
  createProject: 'chatfgm:desktop:create-project',
  openProject: 'chatfgm:desktop:open-project',
  getProjectAvailability: 'chatfgm:desktop:get-project-availability',
  readFile: 'chatfgm:desktop:read-file',
  resolveProjectFileLink: 'chatfgm:desktop:resolve-project-file-link',
  readBinaryResource: 'chatfgm:desktop:read-binary-resource',
  getHtmlPreviewUrl: 'chatfgm:desktop:get-html-preview-url',
  releaseHtmlPreview: 'chatfgm:desktop:release-html-preview',
  listH5Datasets: 'chatfgm:desktop:list-h5-datasets',
  readH5DatasetRange: 'chatfgm:desktop:read-h5-dataset-range',
  createEntry: 'chatfgm:desktop:create-entry',
  renameEntry: 'chatfgm:desktop:rename-entry',
  deleteEntry: 'chatfgm:desktop:delete-entry',
  pasteEntry: 'chatfgm:desktop:paste-entry',
  copyText: 'chatfgm:desktop:copy-text',
  revealPath: 'chatfgm:desktop:reveal-path',
  saveFile: 'chatfgm:desktop:save-file',
  saveFileAs: 'chatfgm:desktop:save-file-as',
  bindProjectToolbox: 'chatfgm:desktop:bind-project-toolbox',
  flushProjectSync: 'chatfgm:desktop:flush-project-sync',
  projectUpdates: 'chatfgm:desktop:project-updates',
  projectSyncFailure: 'chatfgm:desktop:project-sync-failure',
  listRunningTasks: 'chatfgm:desktop:list-running-tasks',
  stopTask: 'chatfgm:desktop:stop-task',
  loadWorkspaceLayout: 'chatfgm:desktop:load-workspace-layout',
  saveWorkspaceLayout: 'chatfgm:desktop:save-workspace-layout',
  loadProjectWorkspace: 'chatfgm:desktop:load-project-workspace',
  saveProjectWorkspace: 'chatfgm:desktop:save-project-workspace',
  respondQuit: 'chatfgm:desktop:respond-quit',
  quitRequested: 'chatfgm:desktop:quit-requested',
  quitReady: 'chatfgm:desktop:quit-ready',
  getSettingsSnapshot: 'chatfgm:desktop:get-settings-snapshot',
  saveSettings: 'chatfgm:desktop:save-settings',
  pickCliExecutable: 'chatfgm:desktop:pick-cli-executable',
  detectCli: 'chatfgm:desktop:detect-cli',
  pickToolboxEnvironment: 'chatfgm:desktop:pick-toolbox-environment',
  detectToolboxEnvironment: 'chatfgm:desktop:detect-toolbox-environment',
  testSettingsService: 'chatfgm:desktop:test-settings-service',
  startChatGptLogin: 'chatfgm:desktop:start-chatgpt-login',
  cancelChatGptLogin: 'chatfgm:desktop:cancel-chatgpt-login',
  logoutChatGpt: 'chatfgm:desktop:logout-chatgpt',
  scanSettingsToolboxes: 'chatfgm:desktop:scan-settings-toolboxes',
  cancelSettingsPendingOperations:
    'chatfgm:desktop:cancel-settings-pending-operations',
  settingsRuntime: 'chatfgm:desktop:settings-runtime',
  getChatContext: 'chatfgm:desktop:get-chat-context',
  listChatConversations: 'chatfgm:desktop:list-chat-conversations',
  loadChatConversation: 'chatfgm:desktop:load-chat-conversation',
  createChatConversation: 'chatfgm:desktop:create-chat-conversation',
  saveChatConversationState: 'chatfgm:desktop:save-chat-conversation-state',
  getChatProjectState: 'chatfgm:desktop:get-chat-project-state',
  setActiveChatConversation: 'chatfgm:desktop:set-active-chat-conversation',
  selectChatAttachment: 'chatfgm:desktop:select-chat-attachment',
  releaseChatAttachmentPreview:
    'chatfgm:desktop:release-chat-attachment-preview',
  sendChatMessage: 'chatfgm:desktop:send-chat-message',
  stopChatRun: 'chatfgm:desktop:stop-chat-run',
  respondChatApproval: 'chatfgm:desktop:respond-chat-approval',
  chatUpdates: 'chatfgm:desktop:chat-updates',
} as const;

export type DesktopIpcChannel =
  (typeof DESKTOP_IPC_CHANNELS)[keyof typeof DESKTOP_IPC_CHANNELS];

/**
 * Public, read-only startup facts returned by the real main process.
 * Paths, secrets, tokens and unrelated machine details are intentionally
 * excluded.
 */
export interface DesktopStartupInfo {
  appName: string;
  appVersion: string;
  mode: DesktopRunMode;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  schemaVersion: number;
  startedAt: number;
}

type DesktopProjectCapabilities = Pick<
  ChatFgmCapabilities,
  | 'loadRecentProjects'
  | 'listToolboxes'
  | 'pickProjectFolder'
  | 'createProject'
  | 'openProject'
  | 'getProjectAvailability'
  | 'readFile'
  | 'readBinaryResource'
  | 'getHtmlPreviewUrl'
  | 'releaseHtmlPreview'
  | 'listH5Datasets'
  | 'readH5DatasetRange'
  | 'createEntry'
  | 'renameEntry'
  | 'deleteEntry'
  | 'pasteEntry'
  | 'copyText'
  | 'revealPath'
  | 'saveFile'
  | 'saveFileAs'
  | 'bindProjectToolbox'
  | 'flushProjectSync'
  | 'listRunningTasks'
  | 'stopTask'
>;

/**
 * The only object exposed through contextBridge. It deliberately contains no
 * generic invoke function and no access to ipcRenderer.
 */
export interface DesktopBridge extends DesktopProjectCapabilities {
  resolveProjectFileLink: NonNullable<ChatFgmCapabilities['resolveProjectFileLink']>;
  getStartupInfo(): Promise<ServiceResult<DesktopStartupInfo>>;
  loadWorkspaceLayout(): Promise<ServiceResult<WorkspaceLayoutRecord>>;
  saveWorkspaceLayout(
    input: SaveWorkspaceLayoutInput,
  ): Promise<ServiceResult<SaveWorkspaceResult>>;
  loadProjectWorkspace(
    input: LoadProjectWorkspaceInput,
  ): Promise<ServiceResult<ProjectWorkspaceRecord>>;
  saveProjectWorkspace(
    input: SaveProjectWorkspaceInput,
  ): Promise<ServiceResult<SaveWorkspaceResult>>;
  /** Registers the main-process quit request; no arguments are forwarded. */
  onQuitRequested(listener: () => void): () => void;
  /** Tells main that the renderer can arbitrate quit requests. */
  markQuitReady(): Promise<ServiceResult<null>>;
  respondQuit(
    input: QuitRequestInput,
  ): Promise<ServiceResult<null>>;
  getProjectAvailability(
    input: ProjectAvailabilityInput,
  ): Promise<ServiceResult<ProjectAvailability>>;
  flushProjectSync(
    input: FlushProjectSyncInput,
  ): Promise<ServiceResult<null>>;
  onProjectSyncFailure(
    listener: (failure: ProjectSyncFailure) => void,
  ): () => void;
  onProjectUpdate(listener: (update: ProjectTreeUpdate) => void): () => void;
  getSettingsSnapshot(): Promise<ServiceResult<SettingsSnapshot>>;
  saveSettings(
    input: SaveSettingsInput,
  ): Promise<ServiceResult<SettingsSnapshot>>;
  pickCliExecutable(): Promise<ServiceResult<SettingsPathSelection>>;
  detectCli(input: { path: string }): Promise<
    ServiceResult<SettingsCliDetection>
  >;
  pickToolboxEnvironment(input: {
    toolboxId: string;
  }): Promise<ServiceResult<SettingsPathSelection>>;
  detectToolboxEnvironment(input: {
    toolboxId: string;
    path: string;
  }): Promise<ServiceResult<SettingsToolboxEnvironmentDetection>>;
  testSettingsService(
    input: TestSettingsServiceInput,
  ): Promise<ServiceResult<SettingsServiceConnectionTest>>;
  startChatGptLogin(): Promise<
    ServiceResult<SettingsChatGptAccount>
  >;
  cancelChatGptLogin(): Promise<
    ServiceResult<SettingsChatGptAccount>
  >;
  logoutChatGpt(): Promise<ServiceResult<SettingsChatGptAccount>>;
  scanSettingsToolboxes(): Promise<ServiceResult<readonly ToolboxOption[]>>;
  cancelSettingsPendingOperations(): Promise<ServiceResult<null>>;
  onSettingsRuntime(
    listener: (update: SettingsRuntimeUpdate) => void,
  ): () => void;
  getChatContext(
    input?: { projectId?: string; refresh?: boolean },
  ): Promise<ServiceResult<ChatCapabilityContext>>;
  listChatConversations(
    input: ListChatConversationsInput,
  ): Promise<ServiceResult<readonly ChatConversationSummary[]>>;
  loadChatConversation(
    input: LoadChatConversationInput,
  ): Promise<ServiceResult<ChatConversationSnapshot>>;
  createChatConversation(
    input: CreateChatConversationInput,
  ): Promise<ServiceResult<ChatConversationSnapshot>>;
  saveChatConversationState(
    input: SaveChatConversationStateInput,
  ): Promise<ServiceResult<SaveChatConversationStateResult>>;
  getChatProjectState(
    input: GetChatProjectStateInput,
  ): Promise<ServiceResult<ChatProjectChatState>>;
  setActiveChatConversation(
    input: SetActiveChatConversationInput,
  ): Promise<ServiceResult<ChatProjectChatState>>;
  selectChatAttachment(
    input: SelectChatAttachmentInput,
  ): Promise<ServiceResult<ChatAttachment>>;
  releaseChatAttachmentPreview(
    input: ReleaseChatAttachmentInput,
  ): Promise<ServiceResult<null>>;
  sendChatMessage(input: SendChatMessageInput): Promise<ChatSendResult>;
  stopChatRun(input: StopChatRunInput): Promise<ServiceResult<null>>;
  respondChatApproval(
    input: RespondChatApprovalInput,
  ): Promise<ServiceResult<null>>;
  onChatUpdate(listener: (update: ChatUpdate) => void): () => void;
}

export const DESKTOP_BRIDGE_KEY = 'chatfgmDesktop' as const;
