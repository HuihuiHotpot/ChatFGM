import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { AppHeader } from './components/layout/AppHeader';
import { StatusBar } from './components/layout/StatusBar';
import { Notice } from './components/ui/Notice';
import type { NoticeTone } from './components/ui/Notice';
import { WelcomeView } from './features/welcome/WelcomeView';
import { WorkspaceView } from './features/workspace/WorkspaceView';
import { SettingsDialog } from './features/settings/SettingsDialog';
import type { ChatPanelProps } from './features/chat/ChatPanel';
import type {
  ChatBackgroundNoticeState,
} from './features/chat/ChatBackgroundNotice';
import {
  activeChatConversation,
  activeRunForConversation,
  createChatProjectState,
  hasTaskExecution,
  isAcceptedRunUpdate,
  isTerminalRun,
  unsettledRunForConversation,
} from './features/chat/chat-state';
import type {
  ChatConversationState,
  ChatProjectState,
} from './features/chat/chat-state';
import { NewProjectDialog } from './features/projects/NewProjectDialog';
import { findCaseDict, WORKFLOW_TOOLBOX } from './features/projects/workflow-progress';
import {
  invalidProjectCreationFolder,
  PROJECT_PATH_HAN_ERROR,
} from '../backend/ipc/project-creation-path';
import { LeaveDialog } from './features/projects/LeaveDialog';
import type {
  LeaveBusyKind,
  LeavePurpose,
} from './features/projects/LeaveDialog';
import { TabCloseDialog } from './features/workspace/TabCloseDialog';
import { FileConflictDialog } from './features/workspace/FileConflictDialog';
import { SaveAsDialog } from './features/workspace/SaveAsDialog';
import { ChatApprovalDialog } from './features/chat/ChatApprovalDialog';
import { ToolboxPickerDialog } from './features/chat/ToolboxPickerDialog';
import type { DocumentRenderer } from './features/workspace/WorkspaceTabs';
import type { TreeOperationFeedback } from './features/file-tree/ProjectTree';
import type {
  ChatAttachmentKind,
  ChatCapabilityContext,
  ChatConnectionState,
  ChatConversationSettings,
  ChatConversationSnapshot,
  ChatConversationSummary,
  ChatConversationUiState,
  ChatFgmCapabilities,
  ChatPendingSubmission,
  ChatReference,
  ChatRun,
  ChatRunStatus,
  ChatSendReceipt,
  ChatSendResult,
  ChatUpdate,
  SendChatMessageInput,
  SettingsCapabilityGroup,
  SettingsRuntimeState,
  SettingsSnapshot,
  FileTreeEntry,
  FileTreeEntryKind,
  FolderSelection,
  ListH5DatasetsInput,
  ProjectAvailability,
  ProjectSnapshot,
  ProjectTreeUpdate,
  ReadH5RangeInput,
  RunningTask,
  SaveFileResult,
  ServiceResult,
  ToolboxOption,
  TreeMutationResult,
} from './services/capabilities';
import { HtmlViewerHost } from './features/viewers/HtmlViewerHost';
import { markdownImageSources } from './features/viewers/markdown-images';
import {
  isEditableViewer,
  isTextContentViewer,
  viewerKindForFileName,
  viewerKindLabel,
} from './features/viewers/viewer-types';
import {
  createInitialLayoutState,
  layoutReducer,
} from './state/layout';
import type { PanelSide } from './state/layout';
import {
  appDataReducer,
  createInitialAppData,
  currentSession,
} from './state/app';
import {
  activeDocument,
  createDocument,
  createProjectSession,
  findFileByIdentity,
  liveFileEntries,
  parentIdOf,
  refreshProjectSession,
  sessionReducer,
} from './state/workspace';
import {
  cleanWorkspaceForQuit,
  layoutSnapshotFromState,
  restoreWorkspaceSession,
  workspaceSnapshotFromSession,
} from './state/workspace-persistence';
import type {
  ProjectWorkspaceRecord,
} from './services/workspace';
import type {
  CsvViewState,
  H5ViewState,
  ImageViewState,
  OpenDocument,
  ProjectSession,
  TextViewState,
  TreeClipboard,
} from './state/workspace';
import type { RecentProject } from './types';

export interface AppProps {
  capabilities?: ChatFgmCapabilities;
  renderDocument?: DocumentRenderer;
}

interface ProjectRebuildConfirmation {
  mode: 'overwrite' | 'recreate';
  existingProjectIds: readonly string[];
}

interface ProjectFormState {
  recreateProjectId?: string;
  recreateProjectIds?: readonly string[];
  rebuildConfirmation?: ProjectRebuildConfirmation;
  folder: FolderSelection | null;
  toolboxes: readonly ToolboxOption[];
  selectedToolboxId: string | null;
  toolboxesLoading: boolean;
  toolboxesError: string;
  pickingFolder: boolean;
  submitting: boolean;
  error: string;
}

interface OpenTarget {
  path: string;
  pathKey: string;
  name: string;
}

interface FormSnapshot {
  replaceProjectId?: string;
  replaceProjectIds?: readonly string[];
  confirmOverwrite?: boolean;
  folder: FolderSelection;
  toolboxId: string;
}

type LeaveIntent =
  | { kind: 'close' }
  | { kind: 'quit' }
  | { kind: 'open'; target: OpenTarget }
  | { kind: 'create'; form: FormSnapshot };

interface LeaveState {
  id: number;
  intent: LeaveIntent;
  tasks: RunningTask[];
  /** Projects whose running tasks must be checked before leaving. */
  taskProjectIds: string[];
  /** Project whose registered directory is being closed/replaced. */
  directoryProjectId: string | null;
  tasksStatus: 'loading' | 'ready' | 'error';
  tasksError: string;
  /** Registered project path state; a missing directory changes the flow. */
  directory: ProjectAvailability | null;
  directoryStatus: 'loading' | 'ready' | 'error';
  directoryError: string;
  busyKind: LeaveBusyKind | null;
  error: string;
  progress: string;
}

interface TabCloseState {
  id: number;
  projectId: string;
  identity: string;
  saving: boolean;
  error: string;
}

interface NoticeState {
  message: string;
  tone: NoticeTone;
  actionLabel?: string;
  onAction?: () => void;
  persistent?: boolean;
}

const EXTERNAL_SYNC_RETRY_LABEL = '重试读取';

interface ExternalReadFailure {
  projectId: string;
  identity: string;
  instanceId: string;
  name: string;
  message: string;
}

interface WorkspaceSaveOptions {
  snapshot?: import('./services/workspace').ProjectWorkspaceSnapshot;
  includeDrafts?: boolean;
  closeIdentity?: string;
}

function viewportWidth(): number {
  return Math.max(0, Math.round(window.innerWidth));
}

function emptyProjectForm(): ProjectFormState {
  return {
    folder: null,
    toolboxes: [],
    selectedToolboxId: null,
    toolboxesLoading: true,
    toolboxesError: '',
    pickingFolder: false,
    submitting: false,
    error: '',
  };
}

function documentKey(projectId: string, identity: string): string {
  return `${projectId}\u0000${identity}`;
}

function resultMessage(
  result: ServiceResult<unknown>,
  fallback: string,
): string {
  if (result.status === 'error') return result.message;
  if (result.status === 'cancelled') return '操作已取消。';
  return fallback;
}

async function safely<T>(
  operation: () => Promise<ServiceResult<T>>,
  fallbackMessage: string,
): Promise<ServiceResult<T>> {
  try {
    return await operation();
  } catch {
    return { status: 'error', message: fallbackMessage };
  }
}

export default function App({
  capabilities,
  renderDocument,
}: AppProps) {
  const [layout, dispatchLayout] = useReducer(
    layoutReducer,
    createInitialLayoutState(viewportWidth()),
  );
  const [data, dispatchData] = useReducer(
    appDataReducer,
    undefined,
    createInitialAppData,
  );
  const dataRef = useRef(data);
  dataRef.current = data;

  const [recentError, setRecentError] = useState('');
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [form, setForm] = useState<ProjectFormState>(emptyProjectForm);
  const [leave, setLeave] = useState<LeaveState | null>(null);
  const [tabClose, setTabClose] = useState<TabCloseState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState('');
  const [settingsSnapshot, setSettingsSnapshot] =
    useState<SettingsSnapshot | null>(null);
  const [settingsRuntime, setSettingsRuntime] =
    useState<SettingsRuntimeState | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [backgroundNotice, setBackgroundNotice] =
    useState<ChatBackgroundNoticeState | null>(null);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [toolboxPickerOpen, setToolboxPickerOpen] = useState(false);
  const [toolboxOptions, setToolboxOptions] = useState<
    readonly ToolboxOption[] | null
  >(null);
  const [toolboxPickerError, setToolboxPickerError] = useState('');
  const [toolboxBinding, setToolboxBinding] = useState(false);
  const [saveConflict, setSaveConflict] = useState<{
    projectId: string;
    identity: string;
    instanceId: string;
    fileName: string;
    currentVersion?: string;
    busy: boolean;
    error: string;
  } | null>(null);
  const [saveAsTarget, setSaveAsTarget] = useState<{
    projectId: string;
    identity: string;
    instanceId: string;
    name: string;
    busy: boolean;
    error: string;
  } | null>(null);

  const leaveSequenceRef = useRef(0);
  const formSequenceRef = useRef(0);
  const tabCloseSequenceRef = useRef(0);
  const projectActionLockRef = useRef(false);
  const formReturnFocusRef = useRef<HTMLElement | null>(null);
  const leaveReturnFocusRef = useRef<HTMLElement | null>(null);
  const tabCloseReturnFocusRef = useRef<HTMLElement | null>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const settingsRequestRef = useRef(0);
  const settingsLoadLockRef = useRef(false);
  const toolboxPickerSeqRef = useRef(0);
  const externalReadSequenceRef = useRef(new Map<string, number>());
  const externalReadAttemptsRef = useRef(new Map<string, number>());
  const externalReadTimersRef = useRef(new Map<string, number>());
  const externalReadFailuresRef = useRef(
    new Map<string, ExternalReadFailure>(),
  );
  const externalFailureNoticeRef = useRef(false);
  const syncFailureNoticeRef = useRef(false);
  const settingsInitialLoadRef = useRef<{
    capability: SettingsCapabilityGroup;
    promise: Promise<ServiceResult<SettingsSnapshot>>;
  } | null>(null);
  const pasteInFlightRef = useRef(new Set<string>());
  const inFlightReadsRef = useRef(new Map<string, Promise<void>>());
  const documentCloseEpochRef = useRef(new Map<string, number>());
  const documentInstanceRef = useRef(0);
  const kindHydrationRef = useRef(new Map<string, Promise<void>>());
  const htmlPreviewGenerationRef = useRef(new Map<string, number>());
  const htmlPreviewInFlightRef = useRef(new Set<string>());
  const htmlPreviewHandlesRef = useRef(
    new Map<
      string,
      { projectId: string; identity: string; handle: string }
    >(),
  );
  const saveInFlightRef = useRef(
    new Map<
      string,
      {
        content: string;
        promise: Promise<ServiceResult<SaveFileResult>>;
      }
    >(),
  );
  const saveVersionsRef = useRef(new Map<string, string>());
  const mountedRef = useRef(true);
  const manualSaveRef = useRef<() => void>(() => undefined);
  const noticeTimerRef = useRef<number | null>(null);
  const backgroundNoticeTimerRef = useRef<number | null>(null);
  const chatContextRequestRef = useRef<Promise<
    ServiceResult<ChatCapabilityContext>
  > | null>(null);
  const chatContextGenerationRef = useRef(0);
  /** Highest context read identity accepted from events or responses. */
  const chatContextRequestIdRef = useRef(0);
  const chatListRequestRef = useRef(
    new Map<
      string,
      Promise<ServiceResult<readonly ChatConversationSummary[]>>
    >(),
  );
  const chatConversationRequestsRef = useRef(
    new Map<
      string,
      Promise<ServiceResult<ChatConversationSnapshot>>
    >(),
  );
  const retiredProjectIdsRef = useRef(new Set<string>());
  const chatSaveTimersRef = useRef(new Map<string, number>());
  const chatSaveQueuesRef = useRef(
    new Map<string, Promise<void>>(),
  );
  const chatSaveFailuresRef = useRef(new Map<string, string>());
  /**
   * Latest user-selected conversation per project. Every save task writes the
   * latest intent, so stale retries or late responses cannot restore an older
   * selection.
   */
  const chatActiveIntentRef = useRef(
    new Map<string, { conversationId: string; token: number }>(),
  );
  const chatActiveTokenRef = useRef(0);
  /** Serialized active-conversation writers per project. */
  const chatActivePersistQueuesRef = useRef(new Map<string, Promise<unknown>>());
  /** Projects whose latest active-conversation write has not succeeded yet. */
  const chatActivePersistFailuresRef = useRef(new Set<string>());
  const chatSendLocksRef = useRef(new Set<string>());
  const chatReconcileLocksRef = useRef(new Set<string>());
  const chatStopLocksRef = useRef(new Set<string>());
  const chatCreateLockRef = useRef(false);
  const chatSwitchSequenceRef = useRef(0);
  const chatProjectStateRevisionRef = useRef(new Map<string, number>());
  const chatSubmissionRef = useRef(0);
  const chatRunStatusRef = useRef(
    new Map<string, { status: ChatRunStatus; revision: number }>(),
  );
  const chatConnectionRef = useRef<
    ChatCapabilityContext['connection'] | null
  >(null);
  const chatReconnectSyncRef = useRef(new Set<string>());
  const chatReconnectGenerationRef = useRef(new Map<string, number>());
  const chatReconnectQueuedRef = useRef(new Map<string, number>());
  const chatPreviewTokensRef = useRef(new Set<string>());
  const chatPreviewTokenProjectsRef = useRef(
    new Map<string, string>(),
  );
  const chatPreviewMountedRef = useRef(false);
  const chatPreviewReleaseTimerRef = useRef<number | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const leaveRef = useRef<LeaveState | null>(leave);
  leaveRef.current = leave;
  const tabCloseRef = useRef<TabCloseState | null>(tabClose);
  tabCloseRef.current = tabClose;
  const projectFormOpenRef = useRef(projectFormOpen);
  projectFormOpenRef.current = projectFormOpen;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const formRef = useRef<ProjectFormState>(form);
  formRef.current = form;

  const workspaceCapabilities = capabilities?.workspace;
  const layoutHydratedRef = useRef(false);
  const layoutBlockedRef = useRef(false);
  const layoutRevisionRef = useRef(0);
  const layoutSaveTimerRef = useRef<number | null>(null);
  const layoutMaxTimerRef = useRef<number | null>(null);
  const layoutSaveQueueRef = useRef<Promise<string | null>>(
    Promise.resolve(null),
  );
  const workspaceHydratedRef = useRef(new Set<string>());
  const workspaceBlockedRef = useRef(new Set<string>());
  const workspaceRevisionRef = useRef(new Map<string, number>());
  const workspaceSaveTimersRef = useRef(new Map<string, number>());
  const workspaceMaxTimersRef = useRef(new Map<string, number>());
  const workspaceSaveQueuesRef = useRef(
    new Map<string, Promise<string | null>>(),
  );
  const workspaceNoticeAtRef = useRef(0);
  const quitFlowRef = useRef(false);
  const quitLeaveRef = useRef(false);
  const quitRequestRef = useRef(false);

  const [workflowSaveRevision, refreshSavedWorkflow] = useReducer(
    (revision: number) => revision + 1,
    0,
  );
  const session = currentSession(data);
  const tabCloseDocument =
    tabClose && session
      ? session.tabs.find(
          (document) => document.identity === tabClose.identity,
        ) ?? null
      : null;
  const chatCapabilities = capabilities?.chat;
  const chatAvailable = Boolean(chatCapabilities);
  const settingsCapabilities = capabilities?.settings;
  const settingsAvailable = Boolean(settingsCapabilities);
  const chatProject: ChatProjectState | null = session
    ? data.chat.projects[session.project.id] ?? null
    : null;
  const chatConversation = activeChatConversation(chatProject);
  const chatContext = data.chat.context;
  const actionsAvailable = Boolean(capabilities);
  const modalOpen =
    projectFormOpen ||
    leave !== null ||
    tabClose !== null ||
    settingsOpen ||
    approvalsOpen ||
    toolboxPickerOpen ||
    saveConflict !== null ||
    saveAsTarget !== null;
  const projectActionsDisabled =
    !capabilities ||
    projectBusy ||
    projectFormOpen ||
    leave !== null ||
    tabClose !== null ||
    settingsOpen;
  const leaveUnsavedDocuments = session
    ? session.tabs.filter((document) => document.dirty)
    : [];
  const readBinaryResource = useMemo(() => {
    const operation = capabilities?.readBinaryResource;
    if (!operation) return undefined;
    return (input: Parameters<typeof operation>[0]) =>
      operation.call(capabilities, input);
  }, [capabilities]);
  const listH5Datasets = useMemo(() => {
    const operation = capabilities?.listH5Datasets;
    if (!operation) return undefined;
    return (input: ListH5DatasetsInput) => operation.call(capabilities, input);
  }, [capabilities]);
  const readH5DatasetRange = useMemo(() => {
    const operation = capabilities?.readH5DatasetRange;
    if (!operation) return undefined;
    return (input: ReadH5RangeInput) => operation.call(capabilities, input);
  }, [capabilities]);

  useEffect(() => {
    if (!settingsCapabilities) {
      setSettingsRuntime(null);
      return;
    }
    let active = true;
    const unsubscribe = settingsCapabilities.subscribeUpdates(
      (update) => {
        if (active) applySettingsRuntime(update.runtime);
      },
    );
    let initialRequest = settingsInitialLoadRef.current;
    if (
      !initialRequest ||
      initialRequest.capability !== settingsCapabilities
    ) {
      initialRequest = {
        capability: settingsCapabilities,
        promise: safely(
          () => settingsCapabilities.getSnapshot(),
          '无法读取依赖设置状态。',
        ),
      };
      settingsInitialLoadRef.current = initialRequest;
    }
    void initialRequest.promise.then((result) => {
      if (!active) return;
      if (result.status === 'success') {
        applySettingsRuntime(result.value.runtime);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [settingsCapabilities]);

  function showNotice(
    message: string,
    tone: NoticeTone = 'neutral',
    options: {
      actionLabel?: string;
      onAction?: () => void;
      persistent?: boolean;
      externalFailure?: boolean;
      syncFailure?: boolean;
    } = {},
  ) {
    window.clearTimeout(noticeTimerRef.current ?? undefined);
    externalFailureNoticeRef.current = Boolean(options.externalFailure);
    syncFailureNoticeRef.current = Boolean(options.syncFailure);
    setNotice({
      message,
      tone,
      ...(options.actionLabel ? { actionLabel: options.actionLabel } : {}),
      ...(options.onAction ? { onAction: options.onAction } : {}),
      ...(options.persistent ? { persistent: true } : {}),
    });
    if (options.persistent) {
      noticeTimerRef.current = null;
      return;
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 4000);
  }

  function dismissNotice() {
    window.clearTimeout(noticeTimerRef.current ?? undefined);
    noticeTimerRef.current = null;
    externalFailureNoticeRef.current = false;
    syncFailureNoticeRef.current = false;
    setNotice(null);
  }

  function dismissBackgroundNotice() {
    if (backgroundNoticeTimerRef.current !== null) {
      window.clearTimeout(backgroundNoticeTimerRef.current);
      backgroundNoticeTimerRef.current = null;
    }
    setBackgroundNotice(null);
  }

  function showBackgroundNotice(
    noticeState: ChatBackgroundNoticeState,
  ) {
    window.clearTimeout(noticeTimerRef.current ?? undefined);
    noticeTimerRef.current = null;
    setNotice(null);
    setBackgroundNotice(noticeState);
    if (backgroundNoticeTimerRef.current !== null) {
      window.clearTimeout(backgroundNoticeTimerRef.current);
    }
    backgroundNoticeTimerRef.current = window.setTimeout(() => {
      setBackgroundNotice(null);
      backgroundNoticeTimerRef.current = null;
    }, 7000);
  }

  function showWorkspaceFailure(message: string) {
    const now = Date.now();
    if (now - workspaceNoticeAtRef.current < 4000) return;
    workspaceNoticeAtRef.current = now;
    showNotice(message, 'error');
  }

  function clearWorkspaceDebounce(projectId: string) {
    const debounce = workspaceSaveTimersRef.current.get(projectId);
    if (debounce !== undefined) {
      window.clearTimeout(debounce);
      workspaceSaveTimersRef.current.delete(projectId);
    }
  }

  function clearWorkspaceMaximum(projectId: string) {
    const maximum = workspaceMaxTimersRef.current.get(projectId);
    if (maximum !== undefined) {
      window.clearTimeout(maximum);
      workspaceMaxTimersRef.current.delete(projectId);
    }
  }

  function clearWorkspaceTimer(projectId: string) {
    clearWorkspaceDebounce(projectId);
    clearWorkspaceMaximum(projectId);
  }

  function enqueueProjectWorkspaceSave(
    projectId: string,
    options: WorkspaceSaveOptions = {},
  ): Promise<string | null> {
    if (
      !workspaceCapabilities ||
      !workspaceHydratedRef.current.has(projectId) ||
      workspaceBlockedRef.current.has(projectId)
    ) {
      return Promise.resolve(
        workspaceBlockedRef.current.has(projectId)
          ? '项目工作区恢复失败，原记录已保护，无法提交新的最终状态。'
          : null,
      );
    }
    const previous =
      workspaceSaveQueuesRef.current.get(projectId) ??
      Promise.resolve(null);
    const next = previous
      .catch(() => null)
      .then(async (): Promise<string | null> => {
        if (
          !workspaceCapabilities ||
          !mountedRef.current ||
          !workspaceHydratedRef.current.has(projectId) ||
          workspaceBlockedRef.current.has(projectId)
        ) {
          return null;
        }
        const latest = dataRef.current.sessions[projectId];
        if (!latest) return null;
        const sourceSession = options.closeIdentity
          ? sessionReducer(latest, {
              type: 'close-document',
              identity: options.closeIdentity,
            })
          : latest;
        const snapshot =
          options.snapshot ??
          workspaceSnapshotFromSession(sourceSession, {
            includeDrafts: options.includeDrafts !== false,
          });
        const expectedRevision =
          workspaceRevisionRef.current.get(projectId) ?? 0;
        const result = await safely(
          () =>
            workspaceCapabilities!.saveProjectWorkspace({
              projectId,
              snapshot,
              expectedRevision,
            }),
          '工作区状态保存失败。',
        );
        if (result.status === 'success') {
          workspaceRevisionRef.current.set(
            projectId,
            result.value.revision,
          );
          return null;
        }
        const message =
          result.status === 'error'
            ? result.message
            : '工作区状态保存已取消。';
        showWorkspaceFailure(message);
        return message;
      });
    workspaceSaveQueuesRef.current.set(projectId, next);
    void next.finally(() => {
      if (workspaceSaveQueuesRef.current.get(projectId) === next) {
        workspaceSaveQueuesRef.current.delete(projectId);
      }
    });
    return next;
  }

  function scheduleProjectWorkspaceSave(projectId: string) {
    if (
      !workspaceCapabilities ||
      !workspaceHydratedRef.current.has(projectId) ||
      workspaceBlockedRef.current.has(projectId)
    ) {
      return;
    }
    clearWorkspaceDebounce(projectId);
    if (!workspaceMaxTimersRef.current.has(projectId)) {
      // The maximum is anchored to the first change in this round. Only a
      // completed save or an explicit flush starts a new round.
      workspaceMaxTimersRef.current.set(
        projectId,
        window.setTimeout(() => {
          workspaceMaxTimersRef.current.delete(projectId);
          void flushProjectWorkspace(projectId);
        }, 2000),
      );
    }
    workspaceSaveTimersRef.current.set(
      projectId,
      window.setTimeout(() => {
        workspaceSaveTimersRef.current.delete(projectId);
        void flushProjectWorkspace(projectId);
      }, 500),
    );
  }

  async function flushProjectWorkspace(
    projectId: string,
    options: WorkspaceSaveOptions = {},
  ): Promise<string | null> {
    clearWorkspaceTimer(projectId);
    return enqueueProjectWorkspaceSave(projectId, options);
  }

  function retryProjectFileSync(projectId: string): void {
    void flushProjectFileSync(projectId).then((error) => {
      if (!mountedRef.current) return;
      if (error) {
        showNotice(`项目文件同步仍然失败：${error}`, 'error', {
          persistent: true,
          actionLabel: '重试同步',
          syncFailure: true,
          onAction: () => retryProjectFileSync(projectId),
        });
      } else {
        dismissNotice();
      }
    });
  }

  async function loadProjectAvailability(
    projectId: string,
  ): Promise<ProjectAvailability | null> {
    if (!capabilities?.getProjectAvailability) return null;
    const result = await safely(
      () => capabilities!.getProjectAvailability!({ projectId }),
      '无法检查项目目录状态。',
    );
    return result.status === 'success' ? result.value : null;
  }

  async function flushProjectFileSync(
    projectId: string,
  ): Promise<string | null> {
    if (!capabilities?.flushProjectSync) return null;
    const result = await safely(
      () => capabilities!.flushProjectSync!({ projectId }),
      '最终文件同步失败。',
    );
    return result.status === 'success'
      ? null
      : result.status === 'error'
        ? result.message
        : '最终文件同步已取消。';
  }

  function enqueueLayoutSave(): Promise<string | null> {
    if (layoutBlockedRef.current) {
      return Promise.resolve(
        '全局布局恢复失败，原记录已保护，无法提交新的最终状态。',
      );
    }
    if (
      !workspaceCapabilities ||
      !layoutHydratedRef.current
    ) {
      return Promise.resolve(null);
    }
    const snapshot = layoutSnapshotFromState(layoutRef.current);
    const previous = layoutSaveQueueRef.current;
    const next = previous.catch(() => null).then(async () => {
      if (
        !workspaceCapabilities ||
        !mountedRef.current ||
        !layoutHydratedRef.current ||
        layoutBlockedRef.current
      ) {
        return null;
      }
      const result = await safely(
        () =>
          workspaceCapabilities!.saveLayout({
            snapshot,
            expectedRevision: layoutRevisionRef.current,
          }),
        '全局布局保存失败。',
      );
      if (result.status === 'success') {
        layoutRevisionRef.current = result.value.revision;
        return null;
      }
      const message =
        result.status === 'error'
          ? result.message
          : '全局布局保存已取消。';
      showWorkspaceFailure(message);
      return message;
    });
    layoutSaveQueueRef.current = next;
    return next;
  }

  function scheduleLayoutSave() {
    if (
      !workspaceCapabilities ||
      !layoutHydratedRef.current ||
      layoutBlockedRef.current
    ) {
      return;
    }
    if (layoutSaveTimerRef.current !== null) {
      window.clearTimeout(layoutSaveTimerRef.current);
    }
    layoutSaveTimerRef.current = window.setTimeout(() => {
      layoutSaveTimerRef.current = null;
      if (layoutMaxTimerRef.current !== null) {
        window.clearTimeout(layoutMaxTimerRef.current);
        layoutMaxTimerRef.current = null;
      }
      void enqueueLayoutSave();
    }, 500);
    if (layoutMaxTimerRef.current === null) {
      layoutMaxTimerRef.current = window.setTimeout(() => {
        layoutMaxTimerRef.current = null;
        if (layoutSaveTimerRef.current !== null) {
          window.clearTimeout(layoutSaveTimerRef.current);
          layoutSaveTimerRef.current = null;
        }
        void enqueueLayoutSave();
      }, 2000);
    }
  }

  async function flushLayoutState(): Promise<string | null> {
    if (layoutSaveTimerRef.current !== null) {
      window.clearTimeout(layoutSaveTimerRef.current);
      layoutSaveTimerRef.current = null;
    }
    if (layoutMaxTimerRef.current !== null) {
      window.clearTimeout(layoutMaxTimerRef.current);
      layoutMaxTimerRef.current = null;
    }
    const error = await enqueueLayoutSave();
    return error;
  }
  function observeChatRunStatus(
    projectId: string,
    run: ChatRun,
  ): {
    accepted: boolean;
    previous: { status: ChatRunStatus; revision: number } | null;
  } {
    const key = `${projectId}:${run.id}`;
    const previous = chatRunStatusRef.current.get(key) ?? null;
    if (!isAcceptedRunUpdate(previous, run)) {
      return { accepted: false, previous };
    }
    chatRunStatusRef.current.set(key, {
      status: run.status,
      revision: run.revision,
    });
    return { accepted: true, previous };
  }

  function maybeNotifyChatRun(projectId: string, run: ChatRun) {
    const observed = observeChatRunStatus(projectId, run);
    if (
      !observed.accepted ||
      !observed.previous ||
      observed.previous.status === run.status ||
      isTerminalRun(observed.previous.status) ||
      !isTerminalRun(run.status) ||
      !hasTaskExecution(run)
    ) {
      return;
    }
    const current = dataRef.current;
    if (
      !current.currentProjectId ||
      current.currentProjectId !== projectId
    ) {
      return;
    }
    const conversation = chatConversationState(
      projectId,
      run.conversationId,
    );
    const activeId =
      current.chat.projects[projectId]?.activeId ?? null;
    const visible =
      activeId === run.conversationId &&
      layoutRef.current.rightVisible;
    if (visible) return;
    const title = conversation?.summary.title ?? 'Agent 任务';
    const message =
      run.status === 'failed'
        ? '运行失败'
        : run.status === 'stopped'
          ? '已停止'
          : '已完成';
    showBackgroundNotice({
      projectId,
      conversationId: run.conversationId,
      title,
      message,
      tone:
        run.status === 'failed'
          ? 'error'
          : run.status === 'stopped'
            ? 'stopped'
            : 'success',
    });
  }

  function scheduleChatReconnectSync(projectId: string) {
    const generation =
      (chatReconnectGenerationRef.current.get(projectId) ?? 0) + 1;
    chatReconnectGenerationRef.current.set(projectId, generation);
    if (chatReconnectSyncRef.current.has(projectId)) {
      chatReconnectQueuedRef.current.set(projectId, generation);
      return;
    }
    chatReconnectQueuedRef.current.delete(projectId);
    void reconcileChatAfterReconnect(projectId, generation);
  }

  async function reconcileChatAfterReconnect(
    projectId: string,
    generation: number,
    background = false,
  ) {
    if (
      !chatCapabilities ||
      chatReconnectSyncRef.current.has(projectId) ||
      (!background &&
        dataRef.current.currentProjectId !== projectId)
    ) {
      if (
        chatCapabilities &&
        chatReconnectSyncRef.current.has(projectId)
      ) {
        chatReconnectQueuedRef.current.set(projectId, generation);
      }
      return;
    }
    const project = chatProjectState(projectId);
    if (!project) return;
    const conversationIds = [
      ...new Set([...project.order, ...Object.keys(project.conversations)]),
    ].filter((conversationId) => {
      const conversation = project.conversations[conversationId];
      if (!conversation) return false;
      return Boolean(
        unsettledRunForConversation(conversation) ||
          conversation.summary.status === 'running' ||
          conversation.summary.status === 'unknown' ||
          conversation.summary.activeRunId,
      );
    });
    if (conversationIds.length === 0) return;
    chatReconnectSyncRef.current.add(projectId);
    try {
      const results = await Promise.all(
        conversationIds.map(async (conversationId) => ({
          conversationId,
          result: await refreshChatConversation(
            projectId,
            conversationId,
          ),
        })),
      );
      if (
        !mountedRef.current ||
        dataRef.current.currentProjectId !== projectId
      ) {
        return;
      }
      const errors = results
        .map(({ result }) =>
          result?.status === 'error' ? result.message : '',
        )
        .filter(Boolean);
      if (errors.length > 0) {
        showNotice(
          `连接已恢复，但对话状态核实失败：${errors[0]} 本地内容已保留。`,
          'error',
        );
      }
    } catch {
      if (
        mountedRef.current &&
        dataRef.current.currentProjectId === projectId
      ) {
        showNotice(
          '连接已恢复，但对话状态核实失败；本地内容已保留。',
          'error',
        );
      }
    } finally {
      chatReconnectSyncRef.current.delete(projectId);
      const queued = chatReconnectQueuedRef.current.get(projectId);
      if (queued !== undefined && queued > generation) {
        chatReconnectQueuedRef.current.delete(projectId);
        if (
          mountedRef.current &&
          chatConnectionRef.current === 'connected'
        ) {
          void reconcileChatAfterReconnect(
            projectId,
            queued,
            dataRef.current.currentProjectId !== projectId,
          );
        }
      } else if (queued !== undefined && queued <= generation) {
        chatReconnectQueuedRef.current.delete(projectId);
      }
    }
  }

  function releaseHtmlHandle(
    projectId: string,
    identity: string,
    handle: string,
  ) {
    if (!capabilities?.releaseHtmlPreview) return;
    void safely(
      () =>
        capabilities.releaseHtmlPreview?.({
          projectId,
          fileIdentity: identity,
          handle,
        }) ?? Promise.resolve({ status: 'success' as const, value: null }),
      '释放网页预览失败。',
    );
  }

  function dispatchChat(
    action: import('./features/chat/chat-state').ChatAction,
  ) {
    if ('projectId' in action && retiredProjectIdsRef.current.has(action.projectId)) return;
    // Promise queues can continue before React commits the dispatched action.
    // Keep their payload/revision reads in the same order as the reducer queue.
    dataRef.current = appDataReducer(dataRef.current, { type: 'chat', action });
    dispatchData({ type: 'chat', action });
  }

  function chatProjectState(projectId: string): ChatProjectState | null {
    return dataRef.current.chat.projects[projectId] ?? null;
  }

  function chatConversationState(
    projectId: string,
    conversationId: string,
  ): ChatConversationState | null {
    return (
      chatProjectState(projectId)?.conversations[conversationId] ??
      null
    );
  }

  async function ensureChatContext(force = false, refresh = force) {
    if (!chatCapabilities) return;
    if (chatContextRequestRef.current && !force) return;
    const generation = ++chatContextGenerationRef.current;
    dispatchChat({ type: 'context-loading' });
    const request = safely(
      () => chatCapabilities.getContext({ refresh }),
      '无法获取对话能力。',
    );
    chatContextRequestRef.current = request;
    const result = await request;
    if (chatContextRequestRef.current === request) {
      chatContextRequestRef.current = null;
    }
    if (
      !mountedRef.current ||
      generation !== chatContextGenerationRef.current
    ) {
      return;
    }
    if (result.status === 'success') {
      if (!acceptChatContext(result.value)) return;
      chatConnectionRef.current = result.value.connection;
      dispatchChat({ type: 'context-ready', context: result.value });
    } else {
      dispatchChat({
        type: 'context-error',
        message:
          result.status === 'error'
            ? result.message
            : '对话能力获取已取消。',
      });
    }
  }

  async function refreshChatProjectState(projectId: string) {
    if (!chatCapabilities?.getProjectState) return;
    const result = await safely(
      () =>
        chatCapabilities!.getProjectState!({
          projectId,
        }),
      '无法恢复项目对话状态。',
    );
    if (!mountedRef.current || result.status !== 'success') return;
    chatProjectStateRevisionRef.current.set(
      projectId,
      result.value.revision,
    );
    // A slower project-state response must not override a conversation the user
    // already selected while the request was in flight.
    const localIntent = chatActiveIntentRef.current.get(projectId);
    dispatchChat({
      type: 'project-state',
      projectId,
      activeConversationId:
        localIntent?.conversationId ?? result.value.activeConversationId,
    });
  }

  function noteChatActiveConversation(
    projectId: string,
    conversationId: string,
  ): void {
    const current = chatActiveIntentRef.current.get(projectId);
    if (current?.conversationId === conversationId) return;
    chatActiveTokenRef.current += 1;
    chatActiveIntentRef.current.set(projectId, {
      conversationId,
      token: chatActiveTokenRef.current,
    });
  }

  /**
   * Serializes active-conversation writes for one project. Each task writes the
   * *latest* intent (not the id captured when it was queued), so a late write or
   * a stale retry can never restore an older selection. The latest intent wins
   * even if an earlier write completes after it.
   */
  function enqueueActiveChatPersist(
    projectId: string,
    options: { silent?: boolean; notifySuccess?: boolean } = {},
  ): Promise<string | null> {
    if (!chatCapabilities?.setActiveConversation || retiredProjectIdsRef.current.has(projectId)) {
      return Promise.resolve(null);
    }
    const previous =
      chatActivePersistQueuesRef.current.get(projectId) ?? Promise.resolve();
    const next: Promise<string | null> = previous
      .catch(() => undefined)
      .then(async () => {
        if (!mountedRef.current) return null;
        const intent = chatActiveIntentRef.current.get(projectId);
        if (!intent) return null;
        return writeActiveChatIntent(projectId, intent, options);
      })
      .finally(() => {
        if (chatActivePersistQueuesRef.current.get(projectId) === next) {
          chatActivePersistQueuesRef.current.delete(projectId);
        }
      });
    chatActivePersistQueuesRef.current.set(projectId, next);
    return next;
  }

  async function writeActiveChatIntent(
    projectId: string,
    intent: { conversationId: string; token: number },
    options: { silent?: boolean; notifySuccess?: boolean },
  ): Promise<string | null> {
    const setActive = chatCapabilities?.setActiveConversation;
    if (!setActive) return null;
    let revision =
      chatProjectStateRevisionRef.current.get(projectId) ?? 0;
    let lastMessage = '无法保存当前对话选择，重启后可能无法恢复上次会话。';
    const isCurrentIntent = () => {
      const latest = chatActiveIntentRef.current.get(projectId);
      return Boolean(
        latest &&
          latest.token === intent.token &&
          latest.conversationId === intent.conversationId,
      );
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!isCurrentIntent()) return null;
      const result = await safely(
        () =>
          setActive({
            projectId,
            conversationId: intent.conversationId,
            expectedRevision: revision,
          }),
        '无法保存当前对话选择。',
      );
      if (!mountedRef.current) return null;
      if (result.status === 'success') {
        chatProjectStateRevisionRef.current.set(
          projectId,
          result.value.revision,
        );
        if (!isCurrentIntent()) {
          // A newer selection arrived while this write was in flight. Its own
          // queued task writes it next; this older result must not be reported.
          return null;
        }
        const hadFailure = chatActivePersistFailuresRef.current.delete(
          projectId,
        );
        if (
          !options.silent &&
          (hadFailure || options.notifySuccess) &&
          dataRef.current.currentProjectId === projectId
        ) {
          showNotice('已保存当前对话选择。', 'success');
        }
        return null;
      }
      lastMessage =
        result.status === 'error'
          ? result.message
          : '无法保存当前对话选择，重启后可能无法恢复上次会话。';
      if (result.status !== 'error' || !chatCapabilities?.getProjectState) {
        break;
      }
      const state = await safely(
        () =>
          chatCapabilities!.getProjectState!({
            projectId,
          }),
        '无法恢复项目对话状态。',
      );
      if (!mountedRef.current) return null;
      if (state.status !== 'success') break;
      revision = state.value.revision;
      chatProjectStateRevisionRef.current.set(projectId, revision);
    }
    if (!isCurrentIntent()) return null;
    chatActivePersistFailuresRef.current.add(projectId);
    if (
      !options.silent &&
      dataRef.current.currentProjectId === projectId
    ) {
      showNotice(lastMessage, 'error', {
        actionLabel: '重试',
        onAction: () => retryActiveChatPersistence(projectId),
        persistent: true,
      });
    }
    return lastMessage;
  }

  /**
   * A retry is bound to the project, never to the conversation captured when an
   * old failure notice was created. It persists whatever the user has selected
   * now; an obsolete retry therefore cannot move the database back to an older
   * conversation.
   */
  function retryActiveChatPersistence(projectId: string) {
    if (!chatActiveIntentRef.current.has(projectId)) return;
    void enqueueActiveChatPersist(projectId, { notifySuccess: true });
  }

  async function ensureChatList(projectId: string) {
    if (!chatCapabilities) return;
    if (chatListRequestRef.current.has(projectId)) return;
    dispatchChat({ type: 'list-loading', projectId });
    const request = safely(
      () => chatCapabilities.listConversations({ projectId }),
      '无法加载历史对话。',
    );
    chatListRequestRef.current.set(projectId, request);
    const result = await request;
    if (chatListRequestRef.current.get(projectId) === request) {
      chatListRequestRef.current.delete(projectId);
    }
    if (!mountedRef.current) return;
    if (result.status === 'success') {
      for (const summary of result.value) {
        if (summary.activeRunId) {
          const key = `${projectId}:${summary.activeRunId}`;
          if (!chatRunStatusRef.current.has(key)) {
            chatRunStatusRef.current.set(key, {
              status: 'running',
              revision: -1,
            });
          }
        }
      }
      dispatchChat({
        type: 'list-ready',
        projectId,
        summaries: result.value,
      });
      void refreshChatProjectState(projectId);
    } else {
      dispatchChat({
        type: 'list-error',
        projectId,
        message:
          result.status === 'error'
            ? result.message
            : '历史对话加载已取消。',
      });
    }
  }

  async function loadChatConversationRequest(
    projectId: string,
    conversationId: string,
  ): Promise<ServiceResult<ChatConversationSnapshot> | null> {
    if (!chatCapabilities) return null;
    const key = `${projectId}\u0000${conversationId}`;
    const existing = chatConversationRequestsRef.current.get(key);
    if (existing) return existing;
    const request = safely(
      () =>
        chatCapabilities.loadConversation({
          projectId,
          conversationId,
        }),
      '无法加载对话内容。',
    );
    chatConversationRequestsRef.current.set(key, request);
    const result = await request;
    if (chatConversationRequestsRef.current.get(key) === request) {
      chatConversationRequestsRef.current.delete(key);
    }
    return result;
  }

  function reconcilePendingFromRuns(
    projectId: string,
    conversationId: string,
    runs: readonly ChatRun[],
    backendStillPending = false,
  ) {
    const conversation = chatConversationState(
      projectId,
      conversationId,
    );
    const pending = conversation?.pendingSubmission;
    if (
      !pending ||
      backendStillPending ||
      !runs.some(
        (run) => run.submissionId === pending.submissionId,
      )
    ) {
      return;
    }
    dispatchChat({
      type: 'send-reconciled',
      projectId,
      conversationId,
      submissionId: pending.submissionId,
    });
    scheduleChatSave(projectId, conversationId);
  }

  function applyChatSnapshot(
    projectId: string,
    snapshot: ChatConversationSnapshot,
  ) {
    if (retiredProjectIdsRef.current.has(projectId)) return;
    // Snapshots are reconciliation input, not live terminal notifications.
    for (const run of snapshot.runs) {
      observeChatRunStatus(projectId, run);
    }
    dispatchChat({
      type: 'conversation-snapshot',
      projectId,
      snapshot,
    });
    reconcilePendingFromRuns(
      projectId,
      snapshot.id,
      snapshot.runs,
      Boolean(snapshot.pendingSubmission),
    );
  }

  async function ensureChatConversation(
    projectId: string,
    conversationId: string,
  ) {
    if (!chatCapabilities) return;
    const key = `${projectId}\u0000${conversationId}`;
    if (chatConversationRequestsRef.current.has(key)) return;
    const current = chatConversationState(projectId, conversationId);
    if (!current || current.loadStatus === 'ready') return;
    dispatchChat({
      type: 'conversation-loading',
      projectId,
      conversationId,
    });
    const result = await loadChatConversationRequest(
      projectId,
      conversationId,
    );
    if (!mountedRef.current || !result) return;
    if (result.status === 'success') {
      applyChatSnapshot(projectId, result.value);
    } else {
      dispatchChat({
        type: 'conversation-error',
        projectId,
        conversationId,
        message:
          result.status === 'error'
            ? result.message
            : '对话加载已取消。',
      });
    }
  }

  async function refreshChatConversation(
    projectId: string,
    conversationId: string,
  ): Promise<ServiceResult<ChatConversationSnapshot> | null> {
    if (!chatCapabilities) return null;
    const current = chatConversationState(projectId, conversationId);
    if (!current) return null;
    if (current.loadStatus !== 'ready') {
      dispatchChat({
        type: 'conversation-loading',
        projectId,
        conversationId,
      });
    }
    const result = await loadChatConversationRequest(
      projectId,
      conversationId,
    );
    if (!mountedRef.current || !result) return null;
    if (result.status === 'success') {
      applyChatSnapshot(projectId, result.value);
    } else if (current.loadStatus !== 'ready') {
      dispatchChat({
        type: 'conversation-error',
        projectId,
        conversationId,
        message:
          result.status === 'error'
            ? result.message
            : '对话加载已取消。',
      });
    }
    return result;
  }

  function conversationStatePayload(
    conversation: ChatConversationState,
  ): import('./services/capabilities').SaveChatConversationStateInput {
    return {
      projectId: conversation.summary.projectId,
      conversationId: conversation.summary.id,
      draft: conversation.draft,
      references: conversation.references,
      settings: conversation.settings,
      ui: conversation.ui,
    };
  }

  function enqueueChatSave(projectId: string, conversationId: string) {
    if (!chatCapabilities || retiredProjectIdsRef.current.has(projectId)) return;
    const key = `${projectId}\u0000${conversationId}`;
    const previous =
      chatSaveQueuesRef.current.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!chatCapabilities || !mountedRef.current || retiredProjectIdsRef.current.has(projectId)) return;
        // Acceptance can clear the server draft. Defer writes until its
        // receipt/snapshot has supplied the corresponding user-state revision.
        if (
          chatSendLocksRef.current.has(key) ||
          chatReconcileLocksRef.current.has(key)
        ) return;
        // Read the latest state when the queued save actually runs. Capturing
        // the payload at schedule time would let an old draft overwrite the
        // cleared draft after a send acceptance.
        const conversation = chatConversationState(
          projectId,
          conversationId,
        );
        if (!conversation || conversation.loadStatus !== 'ready') return;
        const payload = {
          ...conversationStatePayload(conversation),
          expectedStateRevision: conversation.stateRevision,
        };
        const result = await safely(
          () => chatCapabilities.saveConversationState(payload),
          '对话状态保存失败。',
        );
        if (retiredProjectIdsRef.current.has(projectId)) return;
        if (
          mountedRef.current &&
          result.status === 'success'
        ) {
          chatSaveFailuresRef.current.delete(key);
          dispatchChat({
            type: 'state-saved',
            projectId,
            conversationId,
            stateRevision: result.value.stateRevision,
          });
          return;
        }
        if (mountedRef.current) {
          const failure =
            result.status === 'error'
              ? result.message
              : '对话状态保存已取消。';
          chatSaveFailuresRef.current.set(key, failure);
          if (dataRef.current.currentProjectId === projectId) {
            showNotice(failure, 'error');
          }
          // A revision conflict is recoverable without overwriting local
          // content: merge the server revision while preserving draft,
          // references, settings and reading position.
          void refreshChatConversation(projectId, conversationId);
        }
      })
      .finally(() => {
        if (chatSaveQueuesRef.current.get(key) === next) {
          chatSaveQueuesRef.current.delete(key);
        }
      });
    chatSaveQueuesRef.current.set(key, next);
  }

  function scheduleChatSave(projectId: string, conversationId: string) {
    if (!chatCapabilities) return;
    const key = `${projectId}\u0000${conversationId}`;
    const pending = chatSaveTimersRef.current.get(key);
    if (pending !== undefined) window.clearTimeout(pending);
    const timer = window.setTimeout(() => {
      chatSaveTimersRef.current.delete(key);
      enqueueChatSave(projectId, conversationId);
    }, 280);
    chatSaveTimersRef.current.set(key, timer);
  }

  function flushChatSave(projectId: string, conversationId: string) {
    const key = `${projectId}\u0000${conversationId}`;
    const timer = chatSaveTimersRef.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      chatSaveTimersRef.current.delete(key);
    }
    enqueueChatSave(projectId, conversationId);
  }

  function flushAllChatSaves() {
    const pending = [...chatSaveTimersRef.current.entries()];
    chatSaveTimersRef.current.clear();
    for (const [key] of pending) {
      const separator = key.indexOf('\u0000');
      const projectId = key.slice(0, separator);
      const conversationId = key.slice(separator + 1);
      enqueueChatSave(projectId, conversationId);
    }
  }

  async function flushAllChatSavesAndWait(): Promise<string | null> {
    if (!chatCapabilities) return null;
    for (const timer of chatSaveTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    chatSaveTimersRef.current.clear();
    chatSaveFailuresRef.current.clear();
    for (const [projectId, project] of Object.entries(
      dataRef.current.chat.projects,
    )) {
      for (const conversation of Object.values(project.conversations)) {
        if (
          conversation.loadStatus === 'ready' &&
          conversation.hasLoadedState
        ) {
          enqueueChatSave(projectId, conversation.summary.id);
        }
      }
    }
    // Wait for the saves scheduled by this flush. A conflict recovery may
    // enqueue no further save, so two drained rounds are sufficient.
    for (let round = 0; round < 2; round += 1) {
      const queues = [...chatSaveQueuesRef.current.values()];
      if (queues.length === 0) break;
      await Promise.all(queues.map((queue) => queue.catch(() => undefined)));
    }
    // Wait for active-conversation writes already scheduled; then write the
    // latest intent for every project so a quit cannot persist an older value.
    for (let round = 0; round < 2; round += 1) {
      const activeQueues = [
        ...chatActivePersistQueuesRef.current.values(),
      ];
      if (activeQueues.length === 0) break;
      await Promise.all(
        activeQueues.map((queue) => queue.catch(() => undefined)),
      );
    }
    let activeFailure: string | null = null;
    for (const projectId of [...chatActiveIntentRef.current.keys()]) {
      const error = await enqueueActiveChatPersist(projectId, {
        silent: true,
        notifySuccess: false,
      });
      if (error) activeFailure = error;
    }
    return chatSaveFailuresRef.current.values().next().value ?? activeFailure;
  }

  /**
   * A cheap editable-state fingerprint used only at close/quit boundaries.
   * The final save is built from a snapshot; if the user changes content while
   * that save is in flight, the snapshot no longer covers the latest edit and
   * the boundary must either save again or ask for confirmation.
   */
  function workspaceEditSignature(): string {
    const data = dataRef.current;
    const sessions = Object.keys(data.sessions)
      .sort()
      .map((projectId) => {
        const session = data.sessions[projectId]!;
        return {
          projectId,
          active: session.activeIdentity,
          tabs: session.tabs.map((document) => ({
            identity: document.identity,
            instanceId: document.instanceId,
            content: document.content,
            savedContent: document.savedContent,
            dirty: document.dirty,
            missing: document.missing,
          })),
        };
      });
    const chats = Object.keys(data.chat.projects)
      .sort()
      .map((projectId) => {
        const project = data.chat.projects[projectId]!;
        return {
          projectId,
          active: project.activeId,
          drafts: Object.values(project.conversations)
            .map((conversation) => ({
              id: conversation.summary.id,
              draft: conversation.draft,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        };
      });
    return JSON.stringify({
      currentProjectId: data.currentProjectId,
      sessions,
      chats,
    });
  }

  function currentChatProjectId(): string | null {
    return dataRef.current.currentProjectId;
  }

  /**
   * Switches the active conversation and persists the selection. History
   * selection and the background-notice "view" action share this path so both
   * flush the previous conversation, save the new active id and load content
   * with identical error handling.
   */
  function activateChatConversation(
    projectId: string,
    conversationId: string,
  ): boolean {
    const project = chatProjectState(projectId);
    if (!project || !project.conversations[conversationId]) return false;
    if (project.activeId === conversationId) return true;
    if (project.activeId) {
      flushChatSave(projectId, project.activeId);
    }
    dispatchChat({
      type: 'select-conversation',
      projectId,
      conversationId,
    });
    noteChatActiveConversation(projectId, conversationId);
    void enqueueActiveChatPersist(projectId);
    const target = project.conversations[conversationId];
    if (target.loadStatus === 'summary') {
      void ensureChatConversation(projectId, conversationId);
    }
    return true;
  }

  function handleSelectChatConversation(conversationId: string) {
    const projectId = currentChatProjectId();
    if (!projectId) return;
    if (!activateChatConversation(projectId, conversationId)) return;
    if (
      backgroundNotice?.projectId === projectId &&
      backgroundNotice.conversationId === conversationId
    ) {
      dismissBackgroundNotice();
    }
  }

  async function handleNewChatConversation() {
    const projectId = currentChatProjectId();
    if (
      !chatCapabilities ||
      !projectId ||
      chatCreateLockRef.current
    ) {
      return;
    }
    const context = dataRef.current.chat.context;
    const preferred =
      context?.services?.find(
        (service) =>
          service.serviceId === context.serviceId &&
          service.connection === 'connected',
      ) ??
      context?.services?.find(
        (service) => service.connection === 'connected',
      );
    const previousActive = chatProjectState(projectId)?.activeId;
    if (previousActive) flushChatSave(projectId, previousActive);
    chatCreateLockRef.current = true;
    dispatchChat({ type: 'create-start', projectId });
    const result = await safely(
      () =>
        chatCapabilities.createConversation({
          projectId,
          ...(preferred
            ? { serviceId: preferred.serviceId }
            : {}),
        }),
      '新建对话失败。',
    );
    chatCreateLockRef.current = false;
    if (!mountedRef.current) return;
    if (result.status !== 'success') {
      dispatchChat({
        type: 'create-error',
        projectId,
        message:
          result.status === 'error'
            ? result.message
            : '新建对话已取消。',
      });
      return;
    }
    dispatchChat({
      type: 'conversation-snapshot',
      projectId,
      snapshot: result.value,
    });
    dispatchChat({
      type: 'select-conversation',
      projectId,
      conversationId: result.value.id,
    });
    noteChatActiveConversation(projectId, result.value.id);
    void enqueueActiveChatPersist(projectId);
  }

  /**
   * A different service is never silently rebound onto the open conversation.
   * Save the old conversation first, then create a fresh conversation bound to
   * the requested service/model. Drafts and references stay with their owner.
   */
  async function handleChatServiceSwitch(
    serviceId: string,
    modelId: string,
  ) {
    const projectId = currentChatProjectId();
    if (
      !chatCapabilities ||
      !projectId ||
      chatCreateLockRef.current
    ) {
      return;
    }
    const context = dataRef.current.chat.context;
    const target = context?.services?.find(
      (service) => service.serviceId === serviceId,
    );
    if (!target || target.connection !== 'connected') {
      showNotice(
        target?.connectionMessage ??
          '目标模型服务当前不可用，未切换。',
        'error',
      );
      return;
    }
    const active = chatConversation;
    const activeId = active?.summary.id ?? null;
    const switchSequence = ++chatSwitchSequenceRef.current;
    // The switch is protected from the moment it starts, including the save of
    // the old conversation. Until the new conversation exists, the composer
    // must not accept input or send to the old service.
    chatCreateLockRef.current = true;
    dispatchChat({ type: 'create-start', projectId });
    try {
      if (active) {
        const key = `${projectId}\u0000${active.summary.id}`;
        flushChatSave(projectId, active.summary.id);
        await chatSaveQueuesRef.current.get(key)?.catch(() => undefined);
        if (
          !mountedRef.current ||
          chatSwitchSequenceRef.current !== switchSequence
        ) {
          return;
        }
      }
      const result = await safely(
        () =>
          chatCapabilities!.createConversation({
            projectId,
            serviceId,
            modelId,
          }),
        '切换模型服务失败。',
      );
      if (
        !mountedRef.current ||
        chatSwitchSequenceRef.current !== switchSequence
      ) {
        return;
      }
      const projectNow = dataRef.current.chat.projects[projectId];
      if (dataRef.current.currentProjectId !== projectId) {
        dispatchChat({
          type: 'create-error',
          projectId,
          message: '切换模型服务期间项目已改变，未切换。',
        });
        return;
      }
      if ((projectNow?.activeId ?? null) !== activeId) {
        // A late result must not take over a conversation the user selected
        // while the switch was still pending.
        dispatchChat({
          type: 'create-error',
          projectId,
          message: '切换模型服务期间对话已改变，未切换。',
        });
        return;
      }
      if (result.status !== 'success') {
        dispatchChat({
          type: 'create-error',
          projectId,
          message:
            result.status === 'error'
              ? result.message
              : '切换模型服务已取消。',
        });
        if (
          result.status === 'error' &&
          result.code === 'chat-model-unavailable'
        ) {
          // createConversation already refreshed the service catalog before
          // rejecting the stale model. Re-read the cached context (without a
          // second discovery) so the menu offers the current valid models.
          void ensureChatContext(true, false);
        }
        return;
      }
      dispatchChat({
        type: 'conversation-snapshot',
        projectId,
        snapshot: result.value,
      });
      dispatchChat({
        type: 'select-conversation',
        projectId,
        conversationId: result.value.id,
      });
      noteChatActiveConversation(projectId, result.value.id);
      void enqueueActiveChatPersist(projectId);
    } finally {
      // A newer request owns the lock if the sequence moved on.
      if (chatSwitchSequenceRef.current === switchSequence) {
        chatCreateLockRef.current = false;
      }
    }
  }

  function handleChatDraftChange(draft: string) {
    const projectId = currentChatProjectId();
    const conversation = chatConversation;
    if (!projectId || !conversation) return;
    if (dataRef.current.chat.projects[projectId]?.creating) return;
    dispatchChat({
      type: 'draft',
      projectId,
      conversationId: conversation.summary.id,
      draft,
    });
    scheduleChatSave(projectId, conversation.summary.id);
  }

  function handleChatReferencesChange(
    references: readonly ChatReference[],
  ) {
    const projectId = currentChatProjectId();
    const conversation = chatConversation;
    if (!projectId || !conversation) return;
    if (dataRef.current.chat.projects[projectId]?.creating) return;
    dispatchChat({
      type: 'references',
      projectId,
      conversationId: conversation.summary.id,
      references,
    });
    scheduleChatSave(projectId, conversation.summary.id);
  }

  function handleChatSettingsChange(
    settings: ChatConversationSettings,
  ) {
    const projectId = currentChatProjectId();
    const conversation = chatConversation;
    if (!projectId || !conversation) return;
    if (dataRef.current.chat.projects[projectId]?.creating) return;
    dispatchChat({
      type: 'settings',
      projectId,
      conversationId: conversation.summary.id,
      settings,
    });
    scheduleChatSave(projectId, conversation.summary.id);
  }

  function handleChatUiChange(
    patch: Partial<ChatConversationUiState>,
  ) {
    const projectId = currentChatProjectId();
    const conversation = chatConversation;
    if (!projectId || !conversation) return;
    dispatchChat({
      type: 'ui-state',
      projectId,
      conversationId: conversation.summary.id,
      patch,
    });
    scheduleChatSave(projectId, conversation.summary.id);
  }

  async function handleAddChatAttachment(
    kind: ChatAttachmentKind,
  ) {
    const projectId = currentChatProjectId();
    const conversation = chatConversation;
    if (
      !chatCapabilities ||
      !projectId ||
      !conversation ||
      conversation.loadStatus !== 'ready' ||
      conversation.attachmentBusy
    ) {
      return;
    }
    if (dataRef.current.chat.projects[projectId]?.creating) return;
    const conversationId = conversation.summary.id;
    const boundService = data.chat.context?.services?.find(
      (service) =>
        service.serviceId === conversation.summary.serviceId,
    );
    if (
      boundService &&
      boundService.connection !== 'connected'
    ) {
      showNotice(
        boundService.connectionMessage ??
          '服务未连接，暂不能添加附件。',
        'error',
      );
      return;
    }
    dispatchChat({
      type: 'attachment-busy',
      projectId,
      conversationId,
      busy: true,
    });
    const result = await safely(
      () =>
        chatCapabilities.selectAttachment({
          projectId,
          conversationId,
          kind,
        }),
      '附件选择失败。',
    );
    if (!mountedRef.current) return;
    const origin = chatConversationState(projectId, conversationId);
    if (origin) {
      dispatchChat({
        type: 'attachment-busy',
        projectId,
        conversationId,
        busy: false,
      });
    }
    if (result.status !== 'success') {
      if (result.status === 'error') {
        showNotice(result.message, 'error');
      }
      return;
    }
    const attachment = result.value;
    const reference: ChatReference = {
      id: `attachment:${attachment.id}`,
      kind: 'attachment',
      name: attachment.name,
      displayPath:
        attachment.displayPath ?? attachment.name,
      attachmentId: attachment.id,
      mime: attachment.mime,
      preview:
        attachment.previewUrl || attachment.previewToken
          ? {
              url: attachment.previewUrl ?? '',
              token: attachment.previewToken,
            }
          : undefined,
    };
    const target = chatConversationState(projectId, conversationId);
    if (!target) return;
    const exists = target.references.some(
      (item) => item.id === reference.id,
    );
    const references = exists
      ? target.references.map((item) =>
          item.id === reference.id ? reference : item,
        )
      : [...target.references, reference];
    dispatchChat({
      type: 'references',
      projectId,
      conversationId,
      references,
    });
    scheduleChatSave(projectId, conversationId);
  }

  async function sendChatRequest(
    input: SendChatMessageInput,
  ): Promise<ChatSendResult> {
    if (!chatCapabilities) {
      return {
        status: 'error',
        message: '对话能力不可用。',
        acceptance: 'not-sent',
      };
    }
    try {
      return await chatCapabilities.sendMessage(input);
    } catch {
      // A thrown capability call may have reached the backend. Treat it as
      // unknown instead of creating a second submission on retry.
      return {
        status: 'error',
        message:
          '发送结果未知，请先核实。',
        acceptance: 'unknown',
      };
    }
  }

  function acceptChatSend(
    projectId: string,
    conversationId: string,
    receipt: ChatSendReceipt,
    submittedDraft: string,
    submittedReferences: readonly ChatReference[],
  ) {
    dispatchChat({
      type: 'send-accepted',
      projectId,
      conversationId,
      submissionId: receipt.submissionId,
      stateRevision: receipt.stateRevision,
      userMessage: receipt.userMessage,
      run: receipt.run,
      submittedDraft,
      submittedReferences,
    });
    maybeNotifyChatRun(projectId, receipt.run);
    if (receipt.summary) {
      dispatchChat({
        type: 'conversation-summary',
        projectId,
        summary: receipt.summary,
      });
    }
    scheduleChatSave(projectId, conversationId);
  }

  async function reconcilePendingChatSend(
    projectId: string,
    conversationId: string,
    retrySubmission: boolean,
    pendingOverride?: ChatPendingSubmission,
  ) {
    const conversation = chatConversationState(
      projectId,
      conversationId,
    );
    const pending =
      pendingOverride ?? conversation?.pendingSubmission;
    if (!pending) return;
    const key = `${projectId}\u0000${conversationId}`;
    if (chatReconcileLocksRef.current.has(key)) return;
    chatReconcileLocksRef.current.add(key);
    dispatchChat({
      type: 'send-verifying',
      projectId,
      conversationId,
    });
    let loadError = '';
    try {
      const loaded = await refreshChatConversation(
        projectId,
        conversationId,
      );
      if (!mountedRef.current) return;
      if (loaded?.status === 'success') {
        const acceptedRun = loaded.value.runs.find(
          (run) =>
            run.submissionId === pending.submissionId &&
            (run.status === 'completed' ||
              run.status === 'failed' ||
              run.status === 'stopped'),
        );
        if (acceptedRun && !loaded.value.pendingSubmission) {
          dispatchChat({
            type: 'send-reconciled',
            projectId,
            conversationId,
            submissionId: pending.submissionId,
          });
          scheduleChatSave(projectId, conversationId);
          if (dataRef.current.currentProjectId === projectId) {
            showNotice('已核实上次发送。', 'success');
          }
          return;
        }
      } else if (loaded?.status === 'error') {
        loadError = loaded.message;
      }
      if (!retrySubmission) {
        dispatchChat({
          type: 'send-reconcile-error',
          projectId,
          conversationId,
          message: loadError
            ? `上次发送结果仍待核实：${loadError}`
            : '上次发送结果仍待核实，请重试核实。',
        });
        return;
      }
      // Re-read the binding immediately before the retry call. A service
      // switch may have happened while the verification load was pending.
      const retryConversation = chatConversationState(
        projectId,
        conversationId,
      );
      const retryContext = dataRef.current.chat.context;
      if (
        !retryConversation?.pendingSubmission ||
        retryConversation.pendingSubmission.submissionId !==
          pending.submissionId
      ) {
        return;
      }
      const retryService = retryContext?.services?.find(
        (service) =>
          service.serviceId === retryConversation.summary.serviceId,
      );
      if (
        !retryContext ||
        !retryService ||
        retryService.connection !== 'connected'
      ) {
        dispatchChat({
          type: 'send-reconcile-error',
          projectId,
          conversationId,
          message:
            '服务未连接，请恢复连接后核实上次发送。',
        });
        return;
      }
      // Retry is safe only because it reuses the original submission id and
      // immutable input snapshot; the service must deduplicate this id.
      const result = await sendChatRequest(pending.input);
      if (!mountedRef.current) return;
      if (result.status === 'success') {
        acceptChatSend(
          projectId,
          conversationId,
          result.value,
          pending.submittedDraft,
          pending.submittedReferences,
        );
        if (dataRef.current.currentProjectId === projectId) {
          showNotice('已核实上次发送。', 'success');
        }
        return;
      }
      // This attempt may have failed before reaching the service. That does
      // not prove the original unknown submission was not accepted, so keep
      // its id and immutable input snapshot for the next reconciliation.
      const message =
        result.status === 'cancelled'
          ? '核实已取消，原提交仍待核实。'
          : result.message;
      dispatchChat({
        type: 'send-reconcile-error',
        projectId,
        conversationId,
        message,
      });
      if (dataRef.current.currentProjectId === projectId) {
        showNotice(message, 'error');
      }
    } finally {
      chatReconcileLocksRef.current.delete(key);
      scheduleChatSave(projectId, conversationId);
    }
  }

  async function requestChatSend() {
    const projectId = currentChatProjectId();
    const conversation = chatConversation;
    const context = dataRef.current.chat.context;
    if (
      !chatCapabilities ||
      !projectId ||
      !conversation ||
      conversation.loadStatus !== 'ready' ||
      !context
    ) {
      return;
    }
    if (
      chatCreateLockRef.current ||
      dataRef.current.chat.projects[projectId]?.creating
    ) {
      showNotice(
        '正在准备对话，请稍候。',
        'error',
      );
      return;
    }
    const service =
      context.services?.find(
        (candidate) =>
          candidate.serviceId === conversation.summary.serviceId,
      ) ??
      (context.serviceId === conversation.summary.serviceId
        ? {
            serviceId: context.serviceId,
            serviceName: context.serviceName,
            connection: context.connection,
            connectionMessage: context.connectionMessage,
            models: context.models,
            defaultModelId: context.defaultModelId ?? null,
          }
        : null);
    if (!service || service.connection !== 'connected') {
      return;
    }
    if (conversation.pendingSubmission) {
      await reconcilePendingChatSend(
        projectId,
        conversation.summary.id,
        true,
      );
      return;
    }
    const key = `${projectId}\u0000${conversation.summary.id}`;
    if (
      chatSendLocksRef.current.has(key) ||
      unsettledRunForConversation(conversation)
    ) {
      return;
    }
    const model = service.models.find(
      (item) =>
        item.modelId === conversation.settings.modelId &&
        item.serviceId === service.serviceId,
    );
    if (!model?.available) {
      showNotice(
        model?.reason ?? '当前模型不可用，请选择其他模型。',
        'error',
      );
      return;
    }
    const text = conversation.draft.trim();
    if (!text && conversation.references.length === 0) return;
    const submittedDraft = conversation.draft;
    const submittedReferences = conversation.references.map(
      (reference) => ({ ...reference }),
    );
    const supportedEffort = model.efforts?.find(
      (effort) => effort.id === conversation.settings.effortId,
    );
    const supportedPermission = context.permissions.find(
      (permission) =>
        permission.id === conversation.settings.permissionId &&
        permission.available,
    );
    if (!supportedPermission) {
      showNotice('当前权限模式不可用，请重新选择。', 'error');
      return;
    }
    const settings: ChatConversationSettings = {
      ...conversation.settings,
      modelLabel: model.label,
      effortId: supportedEffort?.id ?? null,
      effortLabel: supportedEffort?.label,
      permissionId: supportedPermission.id,
      permissionLabel: supportedPermission.label,
    };
    const submissionId = `submission-${Date.now()}-${++chatSubmissionRef.current}`;
    const input: SendChatMessageInput = {
      projectId,
      conversationId: conversation.summary.id,
      submissionId,
      text: submittedDraft.trim(),
      references: submittedReferences,
      settings,
      serviceId: service.serviceId,
      serviceName: service.serviceName,
    };
    chatSendLocksRef.current.add(key);
    await chatSaveQueuesRef.current.get(key)?.catch(() => undefined);
    dispatchChat({
      type: 'send-start',
      projectId,
      conversationId: conversation.summary.id,
    });
    const result = await sendChatRequest(input);
    chatSendLocksRef.current.delete(key);
    scheduleChatSave(projectId, conversation.summary.id);
    if (!mountedRef.current) return;
    if (result.status === 'error' && result.acceptance === 'unknown') {
      showNotice(result.message, 'error');
      const pending: ChatPendingSubmission = {
        submissionId,
        input,
        submittedDraft,
        submittedReferences,
      };
      dispatchChat({
        type: 'send-unknown',
        projectId,
        conversationId: conversation.summary.id,
        message: result.message,
        pending,
      });
      const latest = chatConversationState(
        projectId,
        conversation.summary.id,
      );
      const known = latest
        ? Object.values(latest.runs).some(
            (run) => run.submissionId === submissionId,
          )
        : false;
      if (known) {
        dispatchChat({
          type: 'send-reconciled',
          projectId,
          conversationId: conversation.summary.id,
          submissionId,
        });
        scheduleChatSave(projectId, conversation.summary.id);
        showNotice('已核实上次发送。', 'success');
      } else {
        void reconcilePendingChatSend(
          projectId,
          conversation.summary.id,
          false,
          pending,
        );
      }
      return;
    }
    if (result.status !== 'success') {
      const message =
        result.status === 'error'
          ? result.message
          : '发送已取消，草稿已保留。';
      dispatchChat({
        type: 'send-error',
        projectId,
        conversationId: conversation.summary.id,
        message,
      });
      showNotice(message, 'error');
      return;
    }
    acceptChatSend(
      projectId,
      conversation.summary.id,
      result.value,
      submittedDraft,
      submittedReferences,
    );
  }

  async function requestChatStop() {
    const projectId = currentChatProjectId();
    const conversation = chatConversation;
    if (
      !chatCapabilities ||
      !projectId ||
      !conversation ||
      conversation.stopPending
    ) {
      return;
    }
    const run = activeRunForConversation(conversation);
    if (!run) return;
    const key = `${projectId}\u0000${conversation.summary.id}`;
    if (chatStopLocksRef.current.has(key)) return;
    chatStopLocksRef.current.add(key);
    dispatchChat({
      type: 'stop-start',
      projectId,
      conversationId: conversation.summary.id,
    });
    const result = await safely(
      () =>
        chatCapabilities.stopRun({
          projectId,
          conversationId: conversation.summary.id,
          runId: run.id,
        }),
      '停止请求失败。',
    );
    chatStopLocksRef.current.delete(key);
    if (!mountedRef.current) return;
    if (result.status === 'success') {
      dispatchChat({
        type: 'stop-accepted',
        projectId,
        conversationId: conversation.summary.id,
      });
      const current = dataRef.current;
      const visible =
        current.currentProjectId === projectId &&
        current.chat.projects[projectId]?.activeId === conversation.summary.id &&
        layoutRef.current.rightVisible;
      if (!visible) showNotice('正在停止…');
    } else {
      const message =
        result.status === 'error'
          ? result.message
          : '停止请求已取消。';
      dispatchChat({
        type: 'stop-error',
        projectId,
        conversationId: conversation.summary.id,
        message,
      });
      showNotice(message, 'error');
    }
  }

  function handleAddTreeToChat(entry: FileTreeEntry) {
    const projectId = currentChatProjectId();
    const conversation = chatConversation;
    if (!projectId || !conversation) {
      showNotice('请先新建或选择一段对话。', 'error');
      return;
    }
    if (conversation.loadStatus !== 'ready') {
      showNotice('对话内容尚未加载完成。');
      return;
    }
    const projectPath = session?.project.path ?? '';
    const displayPath =
      projectPath && entry.path.startsWith(`${projectPath}\\`)
        ? entry.path.slice(projectPath.length + 1)
        : entry.path;
    const reference: ChatReference =
      entry.kind === 'file'
        ? {
            id: `file:${entry.fileIdentity ?? entry.id}`,
            kind: 'file',
            name: entry.name,
            displayPath,
            fileIdentity: entry.fileIdentity,
          }
        : {
            id: `folder:${entry.id}`,
            kind: 'folder',
            name: entry.name,
            displayPath,
            directoryId: entry.id,
          };
    if (
      conversation.references.some(
        (item) => item.id === reference.id,
      )
    ) {
      showNotice('已添加此引用。');
      return;
    }
    dispatchChat({
      type: 'references',
      projectId,
      conversationId: conversation.summary.id,
      references: [...conversation.references, reference],
    });
    scheduleChatSave(projectId, conversation.summary.id);

  }

  /**
   * Context reads carry the backend's monotonically increasing request id.
   * Events and responses share the same identity, so a late event/result from
   * an older read cannot replace a newer directory.
   */
  function acceptChatContext(context: ChatCapabilityContext): boolean {
    const requestId = context.contextRequestId;
    if (typeof requestId !== 'number') return true;
    if (requestId < chatContextRequestIdRef.current) return false;
    chatContextRequestIdRef.current = requestId;
    return true;
  }

  function handleChatUpdate(update: ChatUpdate) {
    if ('projectId' in update && retiredProjectIdsRef.current.has(update.projectId)) return;
    if (update.type === 'context') {
      if (!acceptChatContext(update.context)) return;
      chatContextGenerationRef.current += 1;
      chatContextRequestRef.current = null;
      const previousConnection = chatConnectionRef.current;
      chatConnectionRef.current = update.context.connection;
      dispatchChat({ type: 'context-ready', context: update.context });
      const projectId = dataRef.current.currentProjectId;
      if (
        previousConnection !== null &&
        previousConnection !== 'connected' &&
        update.context.connection === 'connected' &&
        projectId
      ) {
        scheduleChatReconnectSync(projectId);
      }
      return;
    }
    if (update.type === 'snapshot') {
      applyChatSnapshot(update.projectId, update.snapshot);
      return;
    }
    dispatchChat({
      type: 'update',
      projectId: update.projectId,
      update,
    });
    if (update.type === 'run') {
      reconcilePendingFromRuns(update.projectId, update.run.conversationId, [
        update.run,
      ]);
      maybeNotifyChatRun(update.projectId, update.run);
    }
  }

  /**
   * Applies an Agent-caused disk change to the already-open project session.
   * The tree, tab names/paths and references are updated in place; the project
   * is never re-opened and the active tab is not changed. Each changed file
   * owns its read sequence, so a slow read for one file cannot be cancelled by
   * an unrelated file update.
   */
  /**
   * Project sync only bumps the changed file's own document. A Markdown
   * preview is a consumer of referenced local images, so a changed asset must
   * invalidate that document's resource cache even though its own text did not
   * change. The match is path-based and limited to open Markdown documents.
   */
  function normalizeAssetPath(value: string): string {
    return value
      .replace(/\//g, '\\')
      .replace(/\\+/g, '\\')
      .toLowerCase();
  }

  function resolveMarkdownAssetPath(
    documentPath: string,
    source: string,
  ): string | null {
    let decoded = source.trim();
    if (!decoded) return null;
    if (
      /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(decoded) ||
      decoded.startsWith('/') ||
      decoded.startsWith('\\') ||
      /^[a-zA-Z]:[\\/]/.test(decoded)
    ) {
      return null;
    }
    // Strip an unencoded query/fragment before decoding, as the backend does.
    // A percent-encoded %23 or %3F is part of the file name, not a delimiter.
    decoded = decoded.split(/[?#]/, 1)[0] ?? '';
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep the literal source if it is not valid percent-encoded text.
    }
    if (!decoded) return null;
    const parts = documentPath.replace(/\//g, '\\').split('\\');
    parts.pop();
    for (const segment of decoded.replace(/\//g, '\\').split('\\')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (parts.length > 1) parts.pop();
        continue;
      }
      parts.push(segment);
    }
    return normalizeAssetPath(parts.join('\\'));
  }

  function markdownReferencesAsset(
    document: OpenDocument,
    assetPath: string,
  ): boolean {
    const target = normalizeAssetPath(assetPath);
    return markdownImageSources(document.content).some(
      (source) =>
        resolveMarkdownAssetPath(document.path, source) === target,
    );
  }

  function handleProjectTreeUpdate(update: ProjectTreeUpdate) {
    const projectSession = dataRef.current.sessions[update.projectId];
    if (!projectSession) {
      removeProjectExternalFailures(update.projectId);
      return;
    }
    dispatchData({
      type: 'session',
      projectId: update.projectId,
      action: {
        type: 'sync-project',
        snapshot: {
          project: projectSession.project,
          tree: update.tree,
        },
        changedFileIdentities: update.changedFileIdentities,
        deletedFileIdentities: update.deletedFileIdentities,
      },
    });
    const changed = new Set(update.changedFileIdentities);
    for (const identity of update.deletedFileIdentities) {
      removeExternalFailure(externalReadKey(update.projectId, identity));
    }
    const assetPaths = new Set<string>();
    for (const identity of update.changedFileIdentities) {
      const oldPath = findFileByIdentity(projectSession.tree, identity)?.path;
      const newPath = findFileByIdentity(update.tree, identity)?.path;
      if (oldPath) assetPaths.add(oldPath);
      if (newPath) assetPaths.add(newPath);
    }
    for (const identity of update.deletedFileIdentities) {
      const deletedPath = findFileByIdentity(projectSession.tree, identity)?.path;
      if (deletedPath) assetPaths.add(deletedPath);
    }
    const previousFiles = new Set(
      liveFileEntries(projectSession.tree)
        .map((entry) => entry.fileIdentity)
        .filter((identity): identity is string => Boolean(identity)),
    );
    for (const entry of liveFileEntries(update.tree)) {
      if (entry.fileIdentity && !previousFiles.has(entry.fileIdentity)) {
        // A deleted image that reappears gets a new identity, while sync only
        // reports deletion plus the rebuilt tree. A Markdown consumer still
        // needs to read the newly available resource.
        assetPaths.add(entry.path);
      }
    }
    if (assetPaths.size > 0) {
      const paths = [...assetPaths];
      for (const document of projectSession.tabs) {
        if (
          document.viewerKind !== 'markdown' ||
          !paths.some((assetPath) =>
            markdownReferencesAsset(document, assetPath),
          )
        ) {
          continue;
        }
        dispatchData({
          type: 'session',
          projectId: update.projectId,
          action: {
            type: 'invalidate-document-resources',
            identity: document.identity,
            instanceId: document.instanceId,
          },
        });
      }
    }
    if (changed.size === 0) return;
    for (const document of projectSession.tabs) {
      if (
        !changed.has(document.identity) ||
        document.dirty ||
        (document.viewerKind !== 'text' &&
          document.viewerKind !== 'markdown' &&
          document.viewerKind !== 'csv')
      ) {
        continue;
      }
      scheduleExternalRead(
        update.projectId,
        document.identity,
        document.instanceId,
        0,
      );
    }
  }

  function externalReadKey(projectId: string, identity: string): string {
    return `${projectId}\u0000${identity}`;
  }

  function clearExternalReadTimer(key: string): void {
    const timer = externalReadTimersRef.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      externalReadTimersRef.current.delete(key);
    }
  }

  function showExternalFailureNotice(): void {
    const failures = [...externalReadFailuresRef.current.values()];
    if (failures.length === 0) {
      if (externalFailureNoticeRef.current) dismissNotice();
      return;
    }
    const message = failures.length === 1
      ? `「${failures[0]!.name}」更新失败：${failures[0]!.message}`
      : `${failures.length} 个文件更新失败：${failures
          .map((failure) => `${failure.name}：${failure.message}`)
          .join('；')}`;
    showNotice(
      message,
      'error',
      {
        persistent: true,
        actionLabel: EXTERNAL_SYNC_RETRY_LABEL,
        externalFailure: true,
        onAction: () => {
          for (const failure of [
            ...externalReadFailuresRef.current.values(),
          ]) {
            const key = externalReadKey(
              failure.projectId,
              failure.identity,
            );
            externalReadAttemptsRef.current.delete(key);
            scheduleExternalRead(
              failure.projectId,
              failure.identity,
              failure.instanceId,
              0,
            );
          }
        },
      },
    );
  }

  function removeExternalFailure(key: string): void {
    if (!externalReadFailuresRef.current.delete(key)) return;
    showExternalFailureNotice();
  }

  function removeProjectExternalFailures(projectId: string): void {
    let changed = false;
    for (const [key, failure] of externalReadFailuresRef.current) {
      if (failure.projectId !== projectId) continue;
      externalReadFailuresRef.current.delete(key);
      changed = true;
    }
    if (changed) showExternalFailureNotice();
  }

  function scheduleExternalRead(
    projectId: string,
    identity: string,
    instanceId: string,
    attempt: number,
  ): void {
    if (!capabilities || !mountedRef.current) return;
    if (!dataRef.current.sessions[projectId]) return;
    const key = externalReadKey(projectId, identity);
    clearExternalReadTimer(key);
    const sequence = (externalReadSequenceRef.current.get(key) ?? 0) + 1;
    externalReadSequenceRef.current.set(key, sequence);
    externalReadAttemptsRef.current.set(key, attempt);
    const currentDocument = () =>
      dataRef.current.sessions[projectId]?.tabs.find(
        (item) =>
          item.identity === identity && item.instanceId === instanceId,
      );
    const before = currentDocument();
    if (!before || before.dirty || before.missing) {
      removeExternalFailure(key);
      return;
    }
    // The read result describes the disk at the moment this request was
    // scheduled. A save (or any other file-version change) while it is in
    // flight makes that result older than the already-confirmed state; dirty
    // alone is not enough because a successful save clears dirty.
    const readSnapshot = {
      content: before.content,
      savedContent: before.savedContent,
      version: before.version,
      saveVersion: saveVersionsRef.current.get(documentKey(projectId, identity)),
    };
    void (async () => {
      const result = await safely(
        () =>
          capabilities!.readFile({
            projectId,
            fileIdentity: identity,
          }),
        '读取外部更新的文件失败。',
      );
      if (!mountedRef.current) return;
      if (externalReadSequenceRef.current.get(key) !== sequence) return;
      const latest = currentDocument();
      if (!latest || latest.dirty || latest.missing) {
        removeExternalFailure(key);
        return;
      }
      if (
        latest.content !== readSnapshot.content ||
        latest.savedContent !== readSnapshot.savedContent ||
        latest.version !== readSnapshot.version ||
        saveVersionsRef.current.get(documentKey(projectId, identity)) !==
          readSnapshot.saveVersion
      ) {
        // A later save/version is authoritative. Do not let a read that
        // started before that save roll the editor or a future save back.
        removeExternalFailure(key);
        return;
      }
      if (!dataRef.current.sessions[projectId]) {
        removeExternalFailure(key);
        return;
      }
      if (result.status === 'success') {
        externalReadAttemptsRef.current.delete(key);
        removeExternalFailure(key);
        // The clean buffer and the next write must use the same accepted
        // disk version. A previous save's cached version is now obsolete.
        if (result.value.version) {
          saveVersionsRef.current.set(
            documentKey(projectId, identity),
            result.value.version,
          );
        }
        dispatchData({
          type: 'session',
          projectId,
          action: {
            type: 'apply-external-content',
            identity,
            instanceId,
            content: result.value.content,
            ...(result.value.version !== undefined
              ? { version: result.value.version }
              : {}),
            ...(result.value.bom !== undefined
              ? { bom: result.value.bom }
              : {}),
            ...(result.value.newline !== undefined
              ? { newline: result.value.newline }
              : {}),
          },
        });
        return;
      }
      const nextAttempt = attempt + 1;
      if (nextAttempt <= 2) {
        // Bounded automatic recovery for a transient lock/partial write.
        const timer = window.setTimeout(() => {
          externalReadTimersRef.current.delete(key);
          scheduleExternalRead(projectId, identity, instanceId, nextAttempt);
        }, 600 * nextAttempt);
        externalReadTimersRef.current.set(key, timer);
        return;
      }
      externalReadFailuresRef.current.set(key, {
        projectId,
        identity,
        instanceId,
        name: latest.path.split(/[\\/]/).pop() ?? latest.name,
        message:
          result.status === 'error' ? result.message : '读取已取消',
      });
      showExternalFailureNotice();
    })();
  }

  function handleViewBackgroundNotice() {
    if (!backgroundNotice) return;
    const notice = backgroundNotice;
    dismissBackgroundNotice();
    if (dataRef.current.currentProjectId !== notice.projectId) return;
    if (!layoutRef.current.rightVisible) {
      dispatchLayout({ type: 'toggle-panel', side: 'right' });
    }
    // The notice action must persist the new active conversation exactly like
    // a history selection, otherwise a quit/restart restores the old one.
    activateChatConversation(notice.projectId, notice.conversationId);
  }

  async function requestHtmlPreview(
    projectId: string,
    identity: string,
    instanceId: string,
    refresh: boolean,
  ) {
    if (!capabilities) return;
    const getHtmlPreviewUrl = capabilities.getHtmlPreviewUrl;
    if (!getHtmlPreviewUrl) {
      dispatchData({
        type: 'session',
        projectId,
        action: {
          type: 'update-html-view',
          identity,
          instanceId,
          patch: {
            status: 'error',
            error: '当前版本尚未接入 HTML 资源服务。',
            refreshLoading: false,
            refreshError: '',
          },
        },
      });
      return;
    }
    const key = `${projectId}\u0000${instanceId}`;
    if (htmlPreviewInFlightRef.current.has(key)) return;
    const current = dataRef.current.sessions[projectId]?.tabs.find(
      (document) =>
        document.identity === identity &&
        document.instanceId === instanceId,
    );
    if (!current || current.viewerKind !== 'html') return;
    const hadUrl = refresh && Boolean(current.htmlView.previewUrl);
    htmlPreviewInFlightRef.current.add(key);
    const generation =
      (htmlPreviewGenerationRef.current.get(key) ?? 0) + 1;
    htmlPreviewGenerationRef.current.set(key, generation);
    dispatchData({
      type: 'session',
      projectId,
      action: {
        type: 'update-html-view',
        identity,
        instanceId,
        patch: {
          status: hadUrl ? 'ready' : 'loading',
          error: hadUrl ? current.htmlView.error : '',
          refreshLoading: hadUrl,
          refreshError: '',
          generation,
        },
      },
    });

    try {
      const result = await safely(
        () =>
          getHtmlPreviewUrl.call(capabilities, {
            projectId,
            fileIdentity: identity,
          }),
        '无法获取网页预览入口。',
      );
      if (!mountedRef.current) {
        if (result.status === 'success' && result.value.handle) {
          releaseHtmlHandle(projectId, identity, result.value.handle);
        }
        return;
      }
      const latest = dataRef.current.sessions[projectId]?.tabs.find(
        (document) =>
          document.identity === identity &&
          document.instanceId === instanceId,
      );
      if (
        !latest ||
        latest.viewerKind !== 'html' ||
        htmlPreviewGenerationRef.current.get(key) !== generation
      ) {
        if (result.status === 'success' && result.value.handle) {
          releaseHtmlHandle(projectId, identity, result.value.handle);
        }
        return;
      }

      if (result.status === 'success') {
        dispatchData({
          type: 'session',
          projectId,
          action: {
            type: 'update-html-view',
            identity,
            instanceId,
            patch: {
              previewUrl: result.value.url,
              previewHandle: result.value.handle ?? null,
              previewRevision:
                latest.htmlView.previewRevision + 1,
              status: 'ready',
              error: '',
              refreshLoading: false,
              refreshError: '',
              generation,
            },
          },
        });
        dispatchData({
          type: 'session',
          projectId,
          action: {
            type: 'clear-external-update',
            identity,
            instanceId,
          },
        });
        return;
      }

      const message =
        result.status === 'error'
          ? result.message
          : '网页预览入口获取已取消。';
      if (hadUrl) {
        dispatchData({
          type: 'session',
          projectId,
          action: {
            type: 'update-html-view',
            identity,
            instanceId,
            patch: {
              status: 'ready',
              refreshLoading: false,
              refreshError: message,
              generation,
            },
          },
        });
        if (dataRef.current.currentProjectId === projectId) {
          showNotice(`刷新网页失败：${message}`, 'error');
        }
      } else {
        dispatchData({
          type: 'session',
          projectId,
          action: {
            type: 'update-html-view',
            identity,
            instanceId,
            patch: {
              status: 'error',
              error: message,
              refreshLoading: false,
              refreshError: '',
              generation,
            },
          },
        });
      }
    } finally {
      htmlPreviewInFlightRef.current.delete(key);
    }
  }

  async function handleCopyViewerValue(value: string) {
    if (!capabilities) return;
    if (value === '') {
      showNotice('当前单元格为空。');
      return;
    }
    const result = await safely(
      () => capabilities.copyText(value),
      '复制单元格失败。',
    );
    if (!mountedRef.current) return;
    if (result.status === 'success') {
      showNotice('已复制', 'success');
    } else {
      showNotice(
        resultMessage(result, '复制单元格失败。'),
        'error',
      );
    }
  }

  useEffect(() => {
    if (!workspaceCapabilities) {
      layoutHydratedRef.current = true;
      return;
    }
    let active = true;
    layoutHydratedRef.current = false;
    void safely(
      () => workspaceCapabilities.loadLayout(),
      '无法加载全局布局。',
    ).then((result) => {
      if (!active) return;
      if (result.status === 'success') {
        layoutRevisionRef.current = result.value.revision;
        if (result.value.snapshot) {
          dispatchLayout({
            type: 'restore-layout',
            snapshot: result.value.snapshot,
          });
        }
        layoutHydratedRef.current = true;
      } else {
        layoutBlockedRef.current = true;
        layoutHydratedRef.current = true;
        showWorkspaceFailure(
          result.status === 'error'
            ? result.message
            : '全局布局加载已取消。',
        );
      }
    });
    return () => {
      active = false;
    };
    // The layout is loaded once per capability instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceCapabilities]);

  useEffect(() => {
    if (!layoutHydratedRef.current) return;
    scheduleLayoutSave();
    // Layout changes are intentionally debounced; the maximum timer ensures
    // continuous dragging cannot postpone persistence indefinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, workspaceCapabilities]);

  useEffect(() => {
    if (!session) return;
    scheduleProjectWorkspaceSave(session.project.id);
    // Any persisted session projection change schedules a coalesced snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, workspaceCapabilities]);

  useEffect(() => {
    if (!workspaceCapabilities) return;
    const unsubscribe = workspaceCapabilities.onQuitRequested(() => {
      void handleQuitRequest();
    });
    void workspaceCapabilities.markQuitReady();
    return unsubscribe;
    // Quit requests are handled by the current App lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceCapabilities]);

  useEffect(() => {
    for (const [projectId, projectSession] of Object.entries(
      data.sessions,
    )) {
      for (const document of projectSession.tabs) {
        if (
          document.viewerKind === 'html' &&
          document.htmlView.status === 'idle'
        ) {
          void requestHtmlPreview(
            projectId,
            document.identity,
            document.instanceId,
            false,
          );
        }
      }
    }
    // HTML documents request their preview entry on first encounter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.sessions]);

  useEffect(() => {
    const next = new Map<
      string,
      { projectId: string; identity: string; handle: string }
    >();
    for (const [projectId, projectSession] of Object.entries(
      data.sessions,
    )) {
      for (const document of projectSession.tabs) {
        if (
          document.viewerKind === 'html' &&
          document.htmlView.previewHandle
        ) {
          next.set(`${projectId}\u0000${document.instanceId}`, {
            projectId,
            identity: document.identity,
            handle: document.htmlView.previewHandle,
          });
        }
      }
    }
    for (const [key, previous] of htmlPreviewHandlesRef.current) {
      const currentEntry = next.get(key);
      if (currentEntry?.handle === previous.handle) continue;
      releaseHtmlHandle(
        previous.projectId,
        previous.identity,
        previous.handle,
      );
    }
    htmlPreviewHandlesRef.current = next;
    // Handle release is an effect of the session map, not a render input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.sessions]);

  useEffect(() => {
    return () => {
      for (const entry of htmlPreviewHandlesRef.current.values()) {
        releaseHtmlHandle(
          entry.projectId,
          entry.identity,
          entry.handle,
        );
      }
      htmlPreviewHandlesRef.current.clear();
    };
    // Release any preview handles when the whole application unmounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const saveTimers = chatSaveTimersRef.current;
    const workspaceSaveTimers = workspaceSaveTimersRef.current;
    const workspaceMaxTimers = workspaceMaxTimersRef.current;
    const externalReadTimers = externalReadTimersRef.current;
    function handleResize() {
      dispatchLayout({
        type: 'viewport-resize',
        viewportWidth: viewportWidth(),
      });
    }
    window.addEventListener('resize', handleResize);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('resize', handleResize);
      window.clearTimeout(noticeTimerRef.current ?? undefined);
      window.clearTimeout(
        backgroundNoticeTimerRef.current ?? undefined,
      );
      backgroundNoticeTimerRef.current = null;
      for (const timer of externalReadTimers.values()) {
        window.clearTimeout(timer);
      }
      externalReadTimers.clear();
      for (const timer of saveTimers.values()) {
        window.clearTimeout(timer);
      }
      saveTimers.clear();
      for (const timer of workspaceSaveTimers.values()) {
        window.clearTimeout(timer);
      }
      for (const timer of workspaceMaxTimers.values()) {
        window.clearTimeout(timer);
      }
      workspaceSaveTimers.clear();
      workspaceMaxTimers.clear();
      if (layoutSaveTimerRef.current !== null) {
        window.clearTimeout(layoutSaveTimerRef.current);
        layoutSaveTimerRef.current = null;
      }
      if (layoutMaxTimerRef.current !== null) {
        window.clearTimeout(layoutMaxTimerRef.current);
        layoutMaxTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    function handleSaveShortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 's') return;
      if (!dataRef.current.currentProjectId) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      manualSaveRef.current();
    }
    window.addEventListener('keydown', handleSaveShortcut);
    return () =>
      window.removeEventListener('keydown', handleSaveShortcut);
  }, []);

  useEffect(() => {
    if (!capabilities) {
      dispatchData({
        type: 'set-recent-projects',
        recentProjects: [],
      });
      setRecentError('');
      return;
    }
    let active = true;
    void safely(
      () => capabilities.loadRecentProjects(),
      '无法加载最近项目。',
    ).then((result) => {
      if (!active) return;
      if (result.status === 'success') {
        dispatchData({
          type: 'set-recent-projects',
          recentProjects: result.value,
        });
        setRecentError('');
      } else if (result.status === 'error') {
        setRecentError(result.message);
      }
    });
    return () => {
      active = false;
    };
  }, [capabilities]);

  useEffect(() => {
    if (!chatCapabilities) return;
    void ensureChatContext();
    // Context is fetched once per capability instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatCapabilities]);

  useEffect(() => {
    const projectId = data.currentProjectId;
    if (!chatCapabilities || !projectId) return;
    dispatchChat({ type: 'ensure-project', projectId });
    // Reuse the cached per-service catalog; explicit refreshes happen after
    // settings/auth changes and when a service connection fails.
    void ensureChatContext();
    void ensureChatList(projectId);
    // A project (re)activation refreshes its summary list; conversation
    // switching does not re-run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatCapabilities, data.currentProjectId]);

  useEffect(() => {
    const projectId = data.currentProjectId;
    if (!chatCapabilities || !projectId) return;
    const unsubscribe =
      chatCapabilities.subscribeUpdates(handleChatUpdate);
    return unsubscribe;
    // One subscription per open project; StrictMode cleans it up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatCapabilities, data.currentProjectId]);

  useEffect(() => {
    if (!capabilities?.subscribeProjectUpdates) return;
    return capabilities.subscribeProjectUpdates((update) => {
      if (!mountedRef.current) return;
      handleProjectTreeUpdate(update);
    });
    // One backend subscription per capability instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities]);

  useEffect(() => {
    const projectId = data.currentProjectId;
    if (!projectId || !capabilities?.flushProjectSync) return;
    let stopped = false;
    let running = false;
    let timer: number | undefined;
    const reconcile = async () => {
      if (stopped || running) return;
      running = true;
      if (timer !== undefined) window.clearTimeout(timer);
      try {
        // Reuse the existing bounded scanner and its update/failure events.
        const result = await safely(
          () => capabilities!.flushProjectSync!({ projectId }),
          '项目文件同步失败。',
        );
        if (!stopped && result.status === 'error') {
          showNotice(`项目文件同步失败：${result.message}`, 'error', {
            persistent: true,
            actionLabel: '重试同步',
            syncFailure: true,
            onAction: () => retryProjectFileSync(projectId),
          });
        } else if (!stopped && syncFailureNoticeRef.current) {
          // A missing directory now resolves without a scan. Clear the old
          // failure prompt instead of leaving it below the workspace.
          dismissNotice();
        }
      } finally {
        running = false;
        if (!stopped) timer = window.setTimeout(() => void reconcile(), 2500);
      }
    };
    const onFocus = () => void reconcile();
    window.addEventListener('focus', onFocus);
    void reconcile();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
    // The lifecycle follows the capability and open project, not render callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities, data.currentProjectId]);

  useEffect(() => {
    if (!capabilities?.subscribeProjectSyncFailures) return;
    return capabilities.subscribeProjectSyncFailures((failure) => {
      if (!mountedRef.current || retiredProjectIdsRef.current.has(failure.projectId)) return;
      showNotice(
        `项目文件同步失败：${failure.message}`,
        'error',
        {
          persistent: true,
          actionLabel: '重试同步',
          syncFailure: true,
          onAction: () => retryProjectFileSync(failure.projectId),
        },
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities]);

  useEffect(() => {
    if (
      !chatCapabilities ||
      !data.currentProjectId ||
      !chatConversation ||
      chatConversation.loadStatus !== 'summary'
    ) {
      return;
    }
    void ensureChatConversation(
      data.currentProjectId,
      chatConversation.summary.id,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatCapabilities,
    chatConversation?.loadStatus,
    chatConversation?.summary.id,
    data.currentProjectId,
  ]);

  useEffect(() => {
    if (!session) return;
    dispatchChat({
      type: 'reconcile-references',
      projectId: session.project.id,
      entries: session.tree,
    });
    // Tree mutations update draft and sent reference display metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.project.id, session?.tree]);

  useEffect(() => {
    if (!backgroundNotice) return;
    if (data.currentProjectId !== backgroundNotice.projectId) {
      dismissBackgroundNotice();
      return;
    }
    const visible =
      chatConversation?.summary.id ===
        backgroundNotice.conversationId &&
      layout.rightVisible;
    if (visible) dismissBackgroundNotice();
    // Entering the notified conversation clears its reminder.
  }, [
    backgroundNotice,
    chatConversation?.summary.id,
    data.currentProjectId,
    layout.rightVisible,
  ]);

  useEffect(() => {
    if (data.currentProjectId) return;
    dismissBackgroundNotice();
    // Closing a project clears all background reminders.
  }, [data.currentProjectId]);

  useEffect(() => {
    if (!chatCapabilities?.releaseAttachmentPreview) return;
    const tokens = new Set<string>();
    for (const [projectId, project] of Object.entries(
      data.chat.projects,
    )) {
      for (const conversation of Object.values(
        project.conversations,
      )) {
        for (const reference of conversation.references) {
          if (reference.preview?.token) {
            tokens.add(reference.preview.token);
            chatPreviewTokenProjectsRef.current.set(
              reference.preview.token,
              projectId,
            );
          }
        }
        for (const message of conversation.messages) {
          for (const reference of message.references ?? []) {
            if (reference.preview?.token) {
              tokens.add(reference.preview.token);
              chatPreviewTokenProjectsRef.current.set(
                reference.preview.token,
                projectId,
              );
            }
          }
        }
      }
    }
    const previous = chatPreviewTokensRef.current;
    for (const token of previous) {
      if (tokens.has(token)) continue;
      previous.delete(token);
      const projectId =
        chatPreviewTokenProjectsRef.current.get(token) ??
        data.currentProjectId ??
        '';
      chatPreviewTokenProjectsRef.current.delete(token);
      void safely(
        () =>
          chatCapabilities.releaseAttachmentPreview?.({
            projectId,
            token,
          }) ?? Promise.resolve({ status: 'success' as const, value: null }),
        '附件预览释放失败。',
      );
    }
    for (const token of tokens) previous.add(token);
  }, [chatCapabilities, data.chat, data.currentProjectId]);

  useEffect(() => {
    return () => {
      flushAllChatSaves();
    };
    // Flush pending state when leaving a project; the current project
    // id makes cleanup run at the switch boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.currentProjectId]);

  useEffect(() => {
    if (!chatCapabilities?.releaseAttachmentPreview) return;
    const tokenSet = chatPreviewTokensRef.current;
    const tokenProjects = chatPreviewTokenProjectsRef.current;
    chatPreviewMountedRef.current = true;
    if (chatPreviewReleaseTimerRef.current !== null) {
      window.clearTimeout(chatPreviewReleaseTimerRef.current);
      chatPreviewReleaseTimerRef.current = null;
    }
    return () => {
      chatPreviewMountedRef.current = false;
      chatPreviewReleaseTimerRef.current = window.setTimeout(() => {
        chatPreviewReleaseTimerRef.current = null;
        if (chatPreviewMountedRef.current) return;
        for (const token of tokenSet) {
          void safely(
            () =>
              chatCapabilities.releaseAttachmentPreview?.({
                projectId:
                  tokenProjects.get(token) ??
                  dataRef.current.currentProjectId ??
                  '',
                token,
              }) ??
              Promise.resolve({
                status: 'success' as const,
                value: null,
              }),
            '附件预览释放失败。',
          );
        }
        tokenSet.clear();
        tokenProjects.clear();
      }, 80);
    };
  }, [chatCapabilities]);

  const leaveId = leave?.id ?? null;

  useEffect(() => {
    if (leaveId === null || !capabilities) return;
    const activeLeaveId = leaveId;
    const projectIds = leaveRef.current?.taskProjectIds ?? [];
    const directoryProjectId = leaveRef.current?.directoryProjectId ?? null;
    if (projectIds.length === 0 && !directoryProjectId) return;
    let active = true;
    let inFlight = false;

    async function refreshTasks() {
      if (!active || inFlight || !capabilities) return;
      inFlight = true;
      const availabilityRequest = (async (): Promise<
        ServiceResult<ProjectAvailability | null>
      > => {
        if (!directoryProjectId || !capabilities?.getProjectAvailability) {
          return { status: 'success', value: null };
        }
        return safely(
          () =>
            capabilities!.getProjectAvailability!({
              projectId: directoryProjectId,
            }),
          '无法检查项目目录状态。',
        );
      })();
      const results = await Promise.all(
        projectIds.map(async (projectId) => {
          const result = await safely(
            () => capabilities.listRunningTasks(projectId),
            '无法获取运行中的任务状态。',
          );
          return { projectId, result };
        }),
      );
      const availability = await availabilityRequest;
      inFlight = false;
      if (!active) return;
      const error = results.find(
        (entry) => entry.result.status === 'error',
      );
      const cancelled = results.find(
        (entry) => entry.result.status === 'cancelled',
      );
      const tasks: RunningTask[] = [];
      for (const entry of results) {
        if (entry.result.status === 'success') {
          for (const task of entry.result.value) {
            tasks.push({ ...task, projectId: task.projectId ?? entry.projectId });
          }
        }
      }
      const directory =
        availability.status === 'success' ? availability.value : null;
      const directoryStatus =
        availability.status === 'success' ? 'ready' : 'error';
      const directoryError =
        availability.status === 'error'
          ? availability.message
          : availability.status === 'cancelled'
            ? '无法检查项目目录状态。'
            : '';
      setLeave((current) => {
        if (!current || current.id !== activeLeaveId) return current;
        if (error) {
          return {
            ...current,
            tasksStatus: 'error',
            tasksError:
              error.result.status === 'error'
                ? error.result.message
                : '无法获取运行中的任务状态。',
            directory,
            directoryStatus,
            directoryError,
          };
        }
        if (cancelled) {
          return {
            ...current,
            tasksStatus: 'error',
            tasksError: '无法获取运行中的任务状态。',
            directory,
            directoryStatus,
            directoryError,
          };
        }
        const waitingForStop = current.busyKind === 'stopping';
        const stopped = tasks.length === 0;
        return {
          ...current,
          tasks,
          tasksStatus: 'ready',
          tasksError: '',
          directory,
          directoryStatus,
          directoryError,
          busyKind:
            waitingForStop && stopped ? null : current.busyKind,
          progress:
            waitingForStop && stopped
              ? '任务已停止，请确认后继续。'
              : current.progress,
        };
      });
    }

    void refreshTasks();
    const timer = window.setInterval(refreshTasks, 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [leaveId, capabilities]);

  function handleTogglePanel(side: PanelSide) {
    dispatchLayout({ type: 'toggle-panel', side });
  }

  function noteDocumentClosed(projectId: string, identity: string) {
    const key = documentKey(projectId, identity);
    const epoch = documentCloseEpochRef.current.get(key) ?? 0;
    documentCloseEpochRef.current.set(key, epoch + 1);
    // A close starts a new document generation. A read belonging to the
    // previous generation may still settle, but it must not open a tab or
    // satisfy a later open request.
    inFlightReadsRef.current.delete(key);
  }

  function sessionForSnapshot(
    snapshot: ProjectSnapshot,
    replace = false,
  ): ProjectSession {
    if (replace) return createProjectSession(snapshot);
    const dataNow = dataRef.current;
    const existing =
      dataNow.sessions[snapshot.project.id] ??
      Object.values(dataNow.sessions).find(
        (item) =>
          item.project.pathKey === snapshot.project.pathKey,
      );
    if (existing) {
      return refreshProjectSession(existing, snapshot);
    }
    return createProjectSession(snapshot);
  }

  async function prepareProjectSession(
    snapshot: ProjectSnapshot,
    options: { replaceSession?: boolean } = {},
  ): Promise<{
    session: ProjectSession;
    revision: number;
    blocked: boolean;
    errors: string[];
  }> {
    const replace = options.replaceSession === true;
    const dataNow = dataRef.current;
    const existing = replace
      ? null
      : dataNow.sessions[snapshot.project.id] ??
        Object.values(dataNow.sessions).find(
          (item) =>
            item.project.pathKey === snapshot.project.pathKey,
        );
    if (existing) {
      return {
        session: refreshProjectSession(existing, snapshot),
        revision:
          workspaceRevisionRef.current.get(snapshot.project.id) ?? 0,
        blocked: workspaceBlockedRef.current.has(snapshot.project.id),
        errors: [],
      };
    }
    const base = createProjectSession(snapshot);
    if (!workspaceCapabilities) {
      return { session: base, revision: 0, blocked: false, errors: [] };
    }
    const loaded = await safely(
      () =>
        workspaceCapabilities.loadProjectWorkspace({
          projectId: snapshot.project.id,
        }),
      '无法读取项目工作区。',
    );
    if (loaded.status !== 'success') {
      return {
        session: base,
        revision: 0,
        blocked: true,
        errors: [
          loaded.status === 'error'
            ? loaded.message
            : '项目工作区读取已取消；原记录未覆盖。',
        ],
      };
    }
    const record: ProjectWorkspaceRecord = loaded.value;
    const corruptCount =
      (record.corruptDraftIds?.length ?? 0) +
      (record.corruptTabCount ?? record.corruptTabIds?.length ?? 0);
    if (!record.snapshot) {
      return {
        session: base,
        revision: record.revision,
        blocked: false,
        errors:
          corruptCount > 0
            ? [
                `项目工作区有 ${corruptCount} 条损坏记录；损坏原记录已保留，未自动删除。`,
              ]
            : [],
      };
    }
    try {
      const restored = await restoreWorkspaceSession(
        base,
        record.snapshot,
        {
          readFile: (identity) =>
            safely(
              () =>
                capabilities!.readFile({
                  projectId: snapshot.project.id,
                  fileIdentity: identity,
                }),
              '无法读取文件。',
            ),
          nextInstanceId: () => nextDocumentInstanceId(),
          savedVersions: record.savedVersions,
        },
      );
      return {
        session: restored.session,
        revision: record.revision,
        blocked: false,
        errors: [
          ...(corruptCount > 0
            ? [
                `部分工作区状态未能恢复（${corruptCount} 项），原记录和恢复草稿已保留。`,
              ]
            : []),
          ...restored.errors,
        ],
      };
    } catch (error) {
      return {
        session: base,
        revision: record.revision,
        blocked: true,
        errors: [
          error instanceof Error
            ? `项目工作区恢复失败，原记录已保留：${error.message}`
            : '项目工作区恢复失败，原记录已保留。',
        ],
      };
    }
  }

  function showProjectCleanupStatus(snapshot: ProjectSnapshot) {
    if (!snapshot.cleanupWarning) return;
    showNotice(snapshot.cleanupWarning, 'error', {
      persistent: true, actionLabel: '重试清理',
      onAction: () => {
        void safely(() => capabilities!.openProject({ path: snapshot.project.path, pathKey: snapshot.project.pathKey }), '重试清理失败。')
          .then((result) => {
            if (!mountedRef.current || dataRef.current.currentProjectId !== snapshot.project.id) return;
            if (result.status === 'success') {
              if (result.value.cleanupWarning) showProjectCleanupStatus(result.value);
              else showNotice('旧项目资源清理已完成。', 'success');
            } else showProjectCleanupStatus({ ...snapshot, cleanupWarning: result.status === 'error' ? result.message : '清理已取消。' });
          });
      },
    });
  }

  function activateProject(
    snapshot: ProjectSnapshot,
    options: {
      replaceSession?: boolean;
      session?: ProjectSession;
      workspaceRevision?: number;
      workspaceBlocked?: boolean;
      restoreErrors?: readonly string[];
    } = {},
  ) {
    const nextSession =
      options.session ??
      sessionForSnapshot(snapshot, options.replaceSession);
    const projectId = nextSession.project.id;
    // A project closed because its directory was missing can be reopened once
    // the directory is restored; it must not stay excluded from saving.
    retiredProjectIdsRef.current.delete(projectId);
    if (options.workspaceRevision !== undefined) {
      workspaceRevisionRef.current.set(
        projectId,
        options.workspaceRevision,
      );
    }
    workspaceHydratedRef.current.add(projectId);
    if (options.workspaceBlocked) {
      workspaceBlockedRef.current.add(projectId);
    } else {
      workspaceBlockedRef.current.delete(projectId);
    }
    if (options.restoreErrors && options.restoreErrors.length > 0) {
      showNotice(options.restoreErrors[0], 'error');
    }
    if (nextSession.tabs.some((document) => document.dirty && document.missing)) {
      showNotice(
        '磁盘上已有文件不存在，相关未保存编辑仍保留在标签中；请确认后再处理。',
        'error',
      );
    }
    dispatchData({
      type: 'activate-project',
      session: nextSession,
      replaceSession: options.replaceSession,
    });
    setRecentError('');
    showProjectCleanupStatus(snapshot);
  }

  function emptyFormSnapshot(): ProjectFormState {
    return emptyProjectForm();
  }

  function captureDialogTrigger(): HTMLElement | null {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.isConnected &&
      active !== document.body &&
      !active.closest('[role="menu"]')
    ) {
      return active;
    }
    return document.querySelector<HTMLElement>('.app-menu-button');
  }

  async function loadToolboxesForForm(token: number) {
    if (!capabilities) return;
    setForm((current) => ({
      ...current,
      toolboxesLoading: true,
      toolboxesError: '',
    }));
    const result = await safely(
      () => capabilities.listToolboxes(),
      '无法加载 Flamelet 工具箱。',
    );
    if (!mountedRef.current || token !== formSequenceRef.current) return;
    if (result.status === 'success') {
      setForm((current) => {
        const selected = result.value.some(
          (toolbox) => toolbox.id === current.selectedToolboxId,
        )
          ? current.selectedToolboxId
          : result.value[0]?.id ?? null;
        return {
          ...current,
          toolboxes: result.value,
          selectedToolboxId: selected,
          toolboxesLoading: false,
          toolboxesError: '',
        };
      });
    } else {
      setForm((current) => ({
        ...current,
        toolboxes: [],
        selectedToolboxId: null,
        toolboxesLoading: false,
        toolboxesError:
          result.status === 'error'
            ? result.message
            : '无法加载 Flamelet 工具箱。',
      }));
    }
  }

  function applySettingsRuntime(next: SettingsRuntimeState) {
    setSettingsRuntime((current) =>
      current && next.revision < current.revision ? current : next,
    );
  }

  function openSettings() {
    if (
      !settingsCapabilities ||
      settingsOpen ||
      settingsLoadLockRef.current ||
      projectFormOpen ||
      leave ||
      tabClose
    ) {
      return;
    }
    settingsLoadLockRef.current = true;
    const active = document.activeElement;
    settingsReturnFocusRef.current =
      active instanceof HTMLElement && active.isConnected
        ? active
        : null;
    setSettingsOpen(true);
    setSettingsSnapshot(null);
    setSettingsLoadError('');
    setSettingsLoading(true);
    const request = ++settingsRequestRef.current;
    void safely(
      () => settingsCapabilities.getSnapshot(),
      '无法加载依赖设置。',
    ).then((result) => {
      if (
        !mountedRef.current ||
        request !== settingsRequestRef.current
      ) {
        return;
      }
      settingsLoadLockRef.current = false;
      setSettingsLoading(false);
      if (result.status === 'success') {
        setSettingsSnapshot(result.value);
        applySettingsRuntime(result.value.runtime);
      } else {
        setSettingsLoadError(
          result.status === 'error'
            ? result.message
            : '依赖设置加载已取消。',
        );
      }
    });
  }

  function retrySettingsLoad() {
    if (
      !settingsCapabilities ||
      !settingsOpen ||
      settingsLoadLockRef.current
    ) {
      return;
    }
    settingsLoadLockRef.current = true;
    setSettingsLoadError('');
    setSettingsLoading(true);
    const request = ++settingsRequestRef.current;
    void safely(
      () => settingsCapabilities.getSnapshot(),
      '无法加载依赖设置。',
    ).then((result) => {
      if (
        !mountedRef.current ||
        request !== settingsRequestRef.current
      ) {
        return;
      }
      settingsLoadLockRef.current = false;
      setSettingsLoading(false);
      if (result.status === 'success') {
        setSettingsSnapshot(result.value);
        applySettingsRuntime(result.value.runtime);
      } else {
        setSettingsLoadError(
          result.status === 'error'
            ? result.message
            : '依赖设置加载已取消。',
        );
      }
    });
  }

  function closeSettings() {
    settingsRequestRef.current += 1;
    settingsLoadLockRef.current = false;
    setSettingsOpen(false);
    setSettingsSnapshot(null);
    setSettingsLoading(false);
    setSettingsLoadError('');
  }

  function handleSettingsSaved(
    snapshot: SettingsSnapshot,
    noticeMessage: string,
  ) {
    settingsRequestRef.current += 1;
    settingsLoadLockRef.current = false;
    setSettingsOpen(false);
    setSettingsSnapshot(null);
    setSettingsLoading(false);
    setSettingsLoadError('');
    applySettingsRuntime(snapshot.runtime);
    showNotice(noticeMessage, 'success');
    if (chatCapabilities) {
      void ensureChatContext(true);
    }
  }

  function openToolboxPicker() {
    if (!capabilities?.bindProjectToolbox) {
      showNotice('当前环境不支持绑定工具箱。', 'error');
      return;
    }
    setToolboxPickerOpen(true);
    setToolboxPickerError('');
    setToolboxOptions(null);
    const sequence = ++toolboxPickerSeqRef.current;
    void (async () => {
      const result = await safely(
        () => capabilities.listToolboxes(),
        '读取工具箱列表失败。',
      );
      if (!mountedRef.current || sequence !== toolboxPickerSeqRef.current) {
        return;
      }
      if (result.status === 'success') {
        setToolboxOptions(result.value);
      } else {
        setToolboxPickerError(
          result.status === 'error' ? result.message : '工具箱读取已取消。',
        );
      }
    })();
  }

  async function bindToolbox(toolboxId: string) {
    const projectId = dataRef.current.currentProjectId;
    if (!capabilities?.bindProjectToolbox || !projectId) return;
    setToolboxBinding(true);
    setToolboxPickerError('');
    const result = await safely(
      () => capabilities.bindProjectToolbox!({ projectId, toolboxId }),
      '绑定工具箱失败。',
    );
    if (!mountedRef.current) return;
    setToolboxBinding(false);
    if (result.status !== 'success') {
      setToolboxPickerError(
        result.status === 'error' ? result.message : '绑定已取消。',
      );
      return;
    }
    dispatchData({
      type: 'session',
      projectId,
      action: {
        type: 'sync-project',
        snapshot: result.value,
        changedFileIdentities: [],
        deletedFileIdentities: [],
      },
    });
    setToolboxPickerOpen(false);
    setToolboxOptions(null);
    showNotice(`已绑定工具箱「${result.value.project.toolboxId}」。`, 'success');
    if (chatCapabilities) void ensureChatContext();
  }

  function openApprovals() {
    setApprovalError('');
    setApprovalsOpen(true);
  }

  async function respondToApproval(
    approvalId: string,
    decision: 'approve' | 'deny',
  ) {
    const projectId = dataRef.current.currentProjectId;
    const conversation = chatConversation;
    if (
      !chatCapabilities?.respondApproval ||
      !projectId ||
      !conversation ||
      approvalBusy
    ) {
      return;
    }
    setApprovalBusy(true);
    setApprovalError('');
    const result = await safely(
      () =>
        chatCapabilities!.respondApproval!({
          projectId,
          conversationId: conversation.summary.id,
          approvalId,
          decision,
        }),
      '答复审批失败。',
    );
    if (!mountedRef.current) return;
    setApprovalBusy(false);
    if (result.status === 'success') {
      setApprovalsOpen(false);
      showNotice(
        decision === 'approve' ? '已批准本次操作。' : '已拒绝本次操作。',
        'success',
      );
      return;
    }
    setApprovalError(
      result.status === 'error' ? result.message : '审批答复已取消。',
    );
  }

  function openNewProjectForm() {
    if (
      !capabilities ||
      projectActionLockRef.current ||      leave ||
      tabClose ||
      settingsOpen
    ) {
      return;
    }
    formSequenceRef.current += 1;
    const token = formSequenceRef.current;
    formReturnFocusRef.current = captureDialogTrigger();
    setForm(emptyProjectForm());
    setProjectFormOpen(true);
    setRecentError('');
    void loadToolboxesForForm(token);
  }

  function closeNewProjectForm() {
    if (form.pickingFolder || form.submitting) return;
    if (form.rebuildConfirmation) {
      setForm((current) => ({ ...current, rebuildConfirmation: undefined, error: '' }));
      return;
    }
    formSequenceRef.current += 1;
    setProjectFormOpen(false);
  }

  async function pickFolderForNewProject() {
    if (
      !capabilities ||
      form.pickingFolder ||
      form.submitting ||
      form.toolboxes.length === 0
    ) {
      return;
    }
    const token = ++formSequenceRef.current;
    setForm((current) => ({
      ...current,
      pickingFolder: true,
      error: '',
    }));
    const result = await safely(
      () => capabilities.pickProjectFolder('create'),
      '无法选择项目文件夹。',
    );
    if (!mountedRef.current || token !== formSequenceRef.current) return;
    setForm((current) => {
      if (result.status === 'success') {
        return {
          ...current,
          folder: result.value,
          recreateProjectId: result.value.existingProjectId,
          recreateProjectIds: result.value.existingProjectIds,
          rebuildConfirmation: undefined,
          pickingFolder: false,
          error: '',
        };
      }
      return {
        ...current,
        pickingFolder: false,
        error:
          result.status === 'error'
            ? result.message
            : '',
      };
    });
  }

  function selectToolbox(toolboxId: string) {
    setForm((current) => ({
      ...current,
      selectedToolboxId: toolboxId,
      error: '',
    }));
  }

  /**
   * A project whose directory disappeared cannot persist chat state or an
   * active conversation. Drop its in-memory pending writes so closing or
   * quitting another project never flushes the removed path.
   */
  function skipProjectPendingSaves(projectId: string) {
    retiredProjectIdsRef.current.add(projectId);
    for (const [key, timer] of chatSaveTimersRef.current) {
      if (!key.startsWith(`${projectId}\u0000`)) continue;
      window.clearTimeout(timer);
      chatSaveTimersRef.current.delete(key);
      chatSaveFailuresRef.current.delete(key);
    }
    for (const key of [...chatSaveQueuesRef.current.keys()]) {
      if (key.startsWith(`${projectId}\u0000`)) {
        chatSaveQueuesRef.current.delete(key);
      }
    }
    for (const key of [...chatSaveFailuresRef.current.keys()]) {
      if (key.startsWith(`${projectId}\u0000`)) {
        chatSaveFailuresRef.current.delete(key);
      }
    }
    chatActiveIntentRef.current.delete(projectId);
    chatActivePersistQueuesRef.current.delete(projectId);
    chatActivePersistFailuresRef.current.delete(projectId);
  }

  function retireProjectCache(projectId: string | undefined) {
    if (!projectId) return;
    retiredProjectIdsRef.current.add(projectId);
    for (const [key, timer] of chatSaveTimersRef.current) {
      if (!key.startsWith(`${projectId}\u0000`)) continue;
      window.clearTimeout(timer);
      chatSaveTimersRef.current.delete(key);
      chatSaveFailuresRef.current.delete(key);
    }
    chatActiveIntentRef.current.delete(projectId);
    for (const key of chatSaveFailuresRef.current.keys()) {
      if (key.startsWith(`${projectId}\u0000`)) chatSaveFailuresRef.current.delete(key);
    }
    chatActivePersistFailuresRef.current.delete(projectId);
    removeProjectExternalFailures(projectId);
    const action = { type: 'retire-project' as const, projectId };
    dataRef.current = appDataReducer(dataRef.current, action);
    dispatchData(action);
  }

  async function createDirect(
    folder: FolderSelection,
    toolboxId: string,
    replaceProjectId?: string,
    replaceProjectIds?: readonly string[],
    confirmOverwrite = false,
  ) {
    if (!capabilities) return;
    setForm((current) => ({
      ...current,
      submitting: true,
      error: '',
    }));
    const result = await safely(
      () =>
        capabilities.createProject({
          folder,
          toolboxId,
          replaceProjectId,
          replaceProjectIds,
          ...(confirmOverwrite ? { confirmOverwrite: true } : {}),
        }),
      '创建项目失败。',
    );
    if (!mountedRef.current) return;
    if (result.status === 'success') {
      for (const id of result.value.replacedProjectIds ?? (replaceProjectId ? [replaceProjectId] : [])) retireProjectCache(id);
      const prepared = await prepareProjectSession(result.value, {
        replaceSession: true,
      });
      if (!mountedRef.current) return;
      activateProject(result.value, {
        replaceSession: true,
        session: prepared.session,
        workspaceRevision: prepared.revision,
        workspaceBlocked: prepared.blocked,
        restoreErrors: prepared.errors,
      });
      formSequenceRef.current += 1;
      setProjectFormOpen(false);
      setForm(emptyFormSnapshot());
      return;
    }
    const errorCode = result.status === 'error' ? result.code : undefined;
    const existingProjectId =
      result.status === 'error' ? result.existingProjectId : undefined;
    const existingProjectIds =
      result.status === 'error' ? result.existingProjectIds : undefined;
    setForm((current) => ({
      ...current,
      folder: errorCode === PROJECT_PATH_HAN_ERROR.code
        ? { ...folder, pathContainsHan: true }
        : current.folder,
      submitting: false,
      error:
        errorCode === PROJECT_PATH_HAN_ERROR.code ||
        errorCode === 'project-overwrite-confirmation-required' ||
        errorCode === 'project-recreate-confirmation-required'
          ? ''
          : resultMessage(result, '创建项目失败。'),
      recreateProjectId: existingProjectId ?? replaceProjectId,
      recreateProjectIds: existingProjectIds ?? replaceProjectIds,
      rebuildConfirmation:
        errorCode === 'project-overwrite-confirmation-required'
          ? {
              mode: 'overwrite',
              existingProjectIds:
                existingProjectIds ?? replaceProjectIds ?? [],
            }
          : errorCode === 'project-recreate-confirmation-required'
            ? {
                mode: 'recreate',
                existingProjectIds:
                  existingProjectIds ?? replaceProjectIds ?? [],
              }
            : undefined,
    }));
  }

  function submitNewProjectForm() {
    if (
      !capabilities ||
      !form.folder ||
      invalidProjectCreationFolder(form.folder) ||
      !form.selectedToolboxId ||
      form.toolboxes.length === 0 ||
      form.pickingFolder ||
      form.submitting
    ) {
      return;
    }
    const existingProjectIds =
      form.recreateProjectIds ??
      form.folder.existingProjectIds ??
      (form.recreateProjectId
        ? [form.recreateProjectId]
        : form.folder.existingProjectId
          ? [form.folder.existingProjectId]
          : []);
    const directoryEmpty = form.folder.directoryEmpty;
    if (existingProjectIds.length > 0 || directoryEmpty === false) {
      setForm((current) => ({
        ...current,
        recreateProjectId: existingProjectIds[0],
        recreateProjectIds:
          existingProjectIds.length > 0 ? existingProjectIds : undefined,
        rebuildConfirmation: {
          mode:
            existingProjectIds.length > 0 && directoryEmpty !== false
              ? 'recreate'
              : 'overwrite',
          existingProjectIds,
        },
        error: '',
      }));
      return;
    }
    beginProjectCreation();
  }

  function beginProjectCreation(
    replaceProjectId?: string,
    replaceProjectIds?: readonly string[],
    confirmOverwrite = false,
  ) {
    if (
      !form.folder ||
      !form.selectedToolboxId ||
      form.pickingFolder ||
      form.submitting ||
      invalidProjectCreationFolder(form.folder)
    ) return;
    setForm((current) => ({ ...current, rebuildConfirmation: undefined }));
    if (session) {
      setProjectFormOpen(false);
      formSequenceRef.current += 1;
      leaveReturnFocusRef.current =
        formReturnFocusRef.current ?? captureDialogTrigger();
      setLeave(createLeaveState({
        kind: 'create',
        form: {
          folder: form.folder,
          toolboxId: form.selectedToolboxId,
          replaceProjectId,
          replaceProjectIds,
          ...(confirmOverwrite ? { confirmOverwrite: true } : {}),
        },
      }));
      return;
    }
    void createDirect(
      form.folder,
      form.selectedToolboxId,
      replaceProjectId,
      replaceProjectIds,
      confirmOverwrite,
    );
  }

  function createLeaveState(intent: LeaveIntent): LeaveState {
    leaveSequenceRef.current += 1;
    const projectId = dataRef.current.currentProjectId;
    return {
      id: leaveSequenceRef.current,
      intent,
      tasks: [],
      taskProjectIds: projectId ? [projectId] : [],
      directoryProjectId: projectId,
      tasksStatus: 'loading',
      tasksError: '',
      directory: null,
      directoryStatus: 'loading',
      directoryError: '',
      busyKind: null,
      error: '',
      progress: '',
    };
  }

  function openLeave(intent: LeaveIntent) {
    if (!session) return;
    leaveReturnFocusRef.current = captureDialogTrigger();
    setRecentError('');
    setLeave(createLeaveState(intent));
  }

  async function openProjectDirect(target: OpenTarget) {
    if (!capabilities || projectActionLockRef.current) return;
    projectActionLockRef.current = true;
    setProjectBusy(true);
    setRecentError('');
    const result = await safely(
      () =>
        capabilities.openProject({
          path: target.path,
          pathKey: target.pathKey,
        }),
      '打开项目失败。',
    );
    if (!mountedRef.current) return;
    if (result.status === 'success') {
      const prepared = await prepareProjectSession(result.value);
      if (!mountedRef.current) return;
      projectActionLockRef.current = false;
      setProjectBusy(false);
      activateProject(result.value, {
        session: prepared.session,
        workspaceRevision: prepared.revision,
        workspaceBlocked: prepared.blocked,
        restoreErrors: prepared.errors,
      });
      return;
    }
    projectActionLockRef.current = false;
    setProjectBusy(false);
    setRecentError(
      result.status === 'error'
        ? result.message
        : '打开项目已取消。',
    );
  }

  async function handleOpenProject() {
    if (
      !capabilities ||
      projectActionLockRef.current ||
      projectFormOpen ||
      leave ||
      tabClose ||
      settingsOpen
    ) {
      return;
    }
    projectActionLockRef.current = true;
    setProjectBusy(true);
    setRecentError('');

    const result = await safely(
      () => capabilities.pickProjectFolder('open'),
      '无法打开文件夹选择器。',
    );
    if (!mountedRef.current) return;
    if (result.status !== 'success') {
      projectActionLockRef.current = false;
      setProjectBusy(false);
      if (result.status === 'error') {
        if (dataRef.current.currentProjectId) {
          showNotice(result.message, 'error');
        } else {
          setRecentError(result.message);
        }
      }
      return;
    }

    const target: OpenTarget = {
      path: result.value.path,
      pathKey: result.value.pathKey,
      name: result.value.name,
    };
    const current = currentSession(dataRef.current);
    if (current && current.project.pathKey === target.pathKey) {
      projectActionLockRef.current = false;
      setProjectBusy(false);
      showNotice('当前项目已打开。');
      return;
    }

    projectActionLockRef.current = false;
    setProjectBusy(false);
    if (current) {
      openLeave({ kind: 'open', target });
      return;
    }
    await openProjectDirect(target);
  }

  async function handleOpenRecent(project: RecentProject) {
    if (
      !capabilities ||
      projectActionLockRef.current ||
      tabClose ||
      leave ||
      projectFormOpen
    ) {
      return;
    }
    const current = currentSession(dataRef.current);
    if (current?.project.pathKey === project.pathKey) return;
    if (current) {
      openLeave({
        kind: 'open',
        target: {
          path: project.path,
          pathKey: project.pathKey,
          name: project.name,
        },
      });
      return;
    }
    await openProjectDirect({
      path: project.path,
      pathKey: project.pathKey,
      name: project.name,
    });
  }

  function handleCloseProject() {
    if (!session || tabClose || projectFormOpen || settingsOpen) return;
    openLeave({ kind: 'close' });
  }

  function openQuitLeave(
    error = '',
    initialTasks: RunningTask[] = [],
  ) {
    quitLeaveRef.current = true;
    leaveSequenceRef.current += 1;
    const taskProjectIds = [
      ...new Set([
        ...Object.keys(dataRef.current.sessions),
        ...(dataRef.current.currentProjectId
          ? [dataRef.current.currentProjectId]
          : []),
      ]),
    ];
    setLeave({
      id: leaveSequenceRef.current,
      intent: { kind: 'quit' },
      tasks: initialTasks,
      taskProjectIds,
      directoryProjectId: dataRef.current.currentProjectId,
      tasksStatus: initialTasks.length > 0 ? 'ready' : 'loading',
      tasksError: '',
      directory: null,
      directoryStatus: 'loading',
      directoryError: '',
      busyKind: null,
      error,
      progress: '',
    });
  }

  async function answerQuit(allow: boolean) {
    quitRequestRef.current = false;
    if (!workspaceCapabilities) return;
    await safely(
      () => workspaceCapabilities.respondQuit({ allow }),
      '无法完成退出确认。',
    );
  }

  async function finalizeQuit(discardUnsaved: boolean) {
    if (quitFlowRef.current) return;
    quitFlowRef.current = true;
    const current = currentSession(dataRef.current);
    for (const projectId of workspaceSaveTimersRef.current.keys()) {
      clearWorkspaceTimer(projectId);
    }
    if (layoutSaveTimerRef.current !== null) {
      window.clearTimeout(layoutSaveTimerRef.current);
      layoutSaveTimerRef.current = null;
    }
    if (layoutMaxTimerRef.current !== null) {
      window.clearTimeout(layoutMaxTimerRef.current);
      layoutMaxTimerRef.current = null;
    }
    let failure: string | null = null;
    // The save of one snapshot is not the close authorization. If the user
    // types while a final save is waiting for its IPC reply, that edit was not
    // part of the authorized snapshot; save the new state in another bounded
    // round. Discard is an explicit earlier decision, so new input after it
    // returns to confirmation rather than being silently discarded.
    const maxAttempts = discardUnsaved ? 1 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const before = workspaceEditSignature();
      const activeProjectId = dataRef.current.currentProjectId;
      failure = await flushAllChatSavesAndWait();
      if (!failure && activeProjectId) {
        failure = await flushLeavingProject(activeProjectId, discardUnsaved);
      }
      if (!failure && activeProjectId) {
        for (const [projectId] of Object.entries(dataRef.current.sessions)) {
          if (projectId === activeProjectId) continue;
          // A removed project directory has nothing left to persist on disk.
          if (
            (await loadProjectAvailability(projectId))?.directoryState ===
            'missing'
          ) {
            continue;
          }
          failure = await flushProjectWorkspace(projectId);
          if (!failure) failure = await flushProjectFileSync(projectId);
          if (failure) break;
        }
      } else if (!failure) {
        for (const [projectId] of Object.entries(dataRef.current.sessions)) {
          if (
            (await loadProjectAvailability(projectId))?.directoryState ===
            'missing'
          ) {
            continue;
          }
          failure = await flushProjectWorkspace(projectId);
          if (!failure) failure = await flushProjectFileSync(projectId);
          if (failure) break;
        }
      }
      if (!failure) failure = await flushLayoutState();
      if (failure) break;
      if (workspaceEditSignature() === before) break;
      if (discardUnsaved || attempt === maxAttempts - 1) {
        failure =
          '退出等待期间检测到新的编辑，退出已取消；请确认当前内容后再退出。';
        break;
      }
    }
    if (!mountedRef.current) return;
    if (failure) {
      quitFlowRef.current = false;
      void answerQuit(false);
      if (quitLeaveRef.current) {
        setLeave((state) =>
          state
            ? {
                ...state,
                busyKind: null,
                progress: '',
                error: failure,
              }
            : state,
        );
      } else {
        openQuitLeave(failure);
      }
      return;
    }
    if (discardUnsaved && current) {
      dispatchData({
        type: 'session',
        projectId: current.project.id,
        action: { type: 'discard-unsaved' },
      });
    }
    await answerQuit(true);
  }

  async function handleQuitRequest() {
    if (quitRequestRef.current) return;
    quitRequestRef.current = true;
    if (leaveRef.current || tabCloseRef.current) {
      // Never stack an exit decision over an unresolved tab/project dialog.
      // Answer the main process now so it can ask again after the original
      // decision is completed or cancelled.
      void answerQuit(false);
      return;
    }
    if (projectFormOpenRef.current) {
      if (formRef.current.pickingFolder || formRef.current.submitting) {
        showNotice('当前操作尚未完成，暂不能退出。');
        void answerQuit(false);
        return;
      }
      closeNewProjectForm();
    }
    if (settingsOpenRef.current) {
      if (settingsLoadLockRef.current) {
        showNotice('设置仍在加载，暂不能退出。');
        void answerQuit(false);
        return;
      }
      await Promise.allSettled([
        settingsCapabilities?.cancelChatGptLogin(),
        settingsCapabilities?.cancelPendingOperations?.(),
      ]);
      closeSettings();
    }
    const current = currentSession(dataRef.current);
    const projectIds = [
      ...new Set([
        ...Object.keys(dataRef.current.sessions),
        ...(dataRef.current.currentProjectId
          ? [dataRef.current.currentProjectId]
          : []),
      ]),
    ];
    const taskResults = await Promise.all(
      projectIds.map(async (projectId) => {
        const result = await safely(
          () => capabilities!.listRunningTasks(projectId),
          '无法获取运行中的任务状态。',
        );
        return { projectId, result };
      }),
    );
    if (!mountedRef.current) return;
    const taskError = taskResults.find(
      (entry) => entry.result.status !== 'success',
    );
    if (taskError) {
      showNotice(
        taskError.result.status === 'error'
          ? taskError.result.message
          : '无法获取运行中的任务状态，暂不能退出。',
        'error',
      );
      void answerQuit(false);
      return;
    }
    const tasks: RunningTask[] = [];
    for (const entry of taskResults) {
      if (entry.result.status === 'success') {
        for (const task of entry.result.value) {
          tasks.push({
            ...task,
            projectId: task.projectId ?? entry.projectId,
          });
        }
      }
    }
    if (current?.tabs.some((document) => document.dirty) || tasks.length > 0) {
      leaveReturnFocusRef.current = captureDialogTrigger();
      openQuitLeave('', tasks);
      return;
    }
    await finalizeQuit(false);
  }

  function cancelLeave() {
    const current = leaveRef.current;
    if (!current || current.busyKind) return;
    leaveSequenceRef.current += 1;
    setLeave(null);
    if (current.intent.kind === 'create') {
      setProjectFormOpen(true);
    }
    if (current.intent.kind === 'quit') {
      quitLeaveRef.current = false;
      quitFlowRef.current = false;
      void answerQuit(false);
    }
  }

  async function stopLeaveTasks() {
    const current = leaveRef.current;
    const projectId = dataRef.current.currentProjectId;
    if (
      !current ||
      !capabilities ||
      !projectId ||
      current.busyKind ||
      current.tasksStatus !== 'ready' ||
      current.tasks.length === 0
    ) {
      return;
    }
    const leaveId = current.id;
    const tasks = current.tasks;
    setLeave((state) =>
      state
        ? {
            ...state,
            busyKind: 'stopping',
            error: '',
            progress: '正在停止任务…',
          }
        : state,
    );

    const errors: string[] = [];
    await Promise.all(
      tasks.map(async (task) => {
        const result = await safely(
          () =>
            capabilities.stopTask({
              projectId: task.projectId ?? projectId,
              taskId: task.id,
              ...(task.conversationId
                ? { conversationId: task.conversationId }
                : {}),
              ...(task.runId ? { runId: task.runId } : {}),
            }),
          `未能停止任务「${task.title}」。`,
        );
        if (result.status !== 'success') {
          errors.push(
            result.status === 'error'
              ? result.message
              : `未能停止任务「${task.title}」。`,
          );
        }
      }),
    );

    if (
      !mountedRef.current ||
      leaveSequenceRef.current !== leaveId
    ) {
      return;
    }

    if (errors.length > 0) {
      setLeave((state) =>
        state
          ? {
              ...state,
              busyKind: null,
              error: errors.join('；'),
              progress: '',
            }
          : state,
      );
      return;
    }

    // A successful stop request is not itself a terminal state. Keep the
    // dialog blocked while the task list is refreshed; the polling effect
    // unlocks it only after the run layer reports that no task remains.
    setLeave((state) =>
      state
        ? {
            ...state,
            busyKind: 'stopping',
            error: '',
            progress: '停止请求已发送，正在等待任务结束…',
          }
        : state,
    );
  }

  async function flushLeavingProject(
    projectId: string,
    discardUnsaved: boolean,
  ): Promise<string | null> {
    const projectSession = dataRef.current.sessions[projectId];
    if (!projectSession) return null;
    const availability = await loadProjectAvailability(projectId);
    if (availability?.directoryState === 'missing') {
      // Nothing on disk belongs to this project any more. Saving a snapshot or
      // waiting for a final scan would only reproduce the path error.
      removeProjectExternalFailures(projectId);
      return null;
    }
    const snapshot = discardUnsaved
      ? cleanWorkspaceForQuit(projectSession)
      : workspaceSnapshotFromSession(projectSession);
    const workspaceFailure = await flushProjectWorkspace(projectId, {
      snapshot,
      includeDrafts: !discardUnsaved,
    });
    if (workspaceFailure) return workspaceFailure;
    return flushProjectFileSync(projectId);
  }

  async function commitLeave(
    current: LeaveState,
    discardUnsaved: boolean,
  ) {
    const dataNow = dataRef.current;
    const oldProjectId = dataNow.currentProjectId;
    if (!oldProjectId || !capabilities) return;
    const leaveId = current.id;

    if (current.intent.kind === 'close') {
      // Recheck immediately before saving: the directory may have disappeared
      // while the dialog was open. A removed directory has nothing to save or
      // synchronize; continuing closes with the already-explained discard.
      setLeave((state) =>
        state
          ? {
              ...state,
              busyKind: 'saving',
              error: '',
              progress: '正在检查项目目录…',
            }
          : state,
      );
      const availability = await loadProjectAvailability(oldProjectId);
      if (
        !mountedRef.current ||
        leaveSequenceRef.current !== leaveId
      ) {
        return;
      }
      if (availability?.directoryState === 'missing') {
        const sessionNow = dataRef.current.sessions[oldProjectId];
        const hasUnsaved =
          sessionNow?.tabs.some((document) => document.dirty) ?? false;
        if (!discardUnsaved && hasUnsaved) {
          setLeave((state) =>
            state
              ? {
                  ...state,
                  busyKind: null,
                  progress: '',
                  directory: availability,
                  directoryStatus: 'ready',
                  directoryError: '',
                  error:
                    '项目目录已被外部删除，未保存的编辑无法写回；请选择“不保存并继续”。',
                }
              : state,
          );
          return;
        }
        dispatchData({
          type: 'session',
          projectId: oldProjectId,
          action: { type: 'discard-unsaved' },
        });
        // Do not let a debounce that was scheduled before the deletion write a
        // workspace snapshot or chat state after the user chose to close.
        clearWorkspaceTimer(oldProjectId);
        skipProjectPendingSaves(oldProjectId);
        removeProjectExternalFailures(oldProjectId);
        dismissNotice();
        leaveSequenceRef.current += 1;
        setLeave(null);
        dispatchData({ type: 'close-project' });
        return;
      }
      setLeave((state) =>
        state
          ? {
              ...state,
              error: '',
              progress: '正在保存对话状态…',
            }
          : state,
      );
    }

    if (current.intent.kind !== 'quit') {
      setLeave((state) =>
        state
          ? {
              ...state,
              busyKind: 'saving',
              error: '',
              progress: '正在保存对话状态…',
            }
          : state,
      );
      const chatSaveFailure = await flushAllChatSavesAndWait();
      if (
        !mountedRef.current ||
        leaveSequenceRef.current !== leaveId
      ) {
        return;
      }
      if (chatSaveFailure) {
        setLeave((state) =>
          state
            ? {
                ...state,
                busyKind: null,
                progress: '',
                error: chatSaveFailure,
              }
            : state,
        );
        return;
      }
    }

    if (current.intent.kind === 'quit') {
      setLeave((state) =>
        state
          ? {
              ...state,
              busyKind: 'saving',
              error: '',
              progress: '正在保存最终工作区状态…',
            }
          : state,
      );
      await finalizeQuit(discardUnsaved);
      return;
    }

    if (current.intent.kind === 'close') {
      setLeave((state) =>
        state
          ? {
              ...state,
              busyKind: 'saving',
              error: '',
              progress: '正在保存工作区状态…',
            }
          : state,
      );
      const saveError = await flushLeavingProject(
        oldProjectId,
        discardUnsaved,
      );
      if (
        !mountedRef.current ||
        leaveSequenceRef.current !== leaveId
      ) {
        return;
      }
      if (saveError) {
        setLeave((state) =>
          state
            ? {
                ...state,
                busyKind: null,
                progress: '',
                error: saveError,
              }
            : state,
        );
        return;
      }
      if (discardUnsaved) {
        dispatchData({
          type: 'session',
          projectId: oldProjectId,
          action: { type: 'discard-unsaved' },
        });
      }
      leaveSequenceRef.current += 1;
      setLeave(null);
      dispatchData({ type: 'close-project' });
      return;
    }

    if (current.intent.kind === 'open') {
      const target = current.intent.target;
      setLeave((state) =>
        state
          ? {
              ...state,
              busyKind: 'opening',
              error: '',
              progress: `正在打开项目「${target.name}」…`,
            }
          : state,
      );
      const result = await safely(
        () =>
          capabilities.openProject({
            path: target.path,
            pathKey: target.pathKey,
          }),
        '打开项目失败。',
      );
      if (
        !mountedRef.current ||
        leaveSequenceRef.current !== leaveId
      ) {
        return;
      }
      if (result.status !== 'success') {
        setLeave((state) =>
          state
            ? {
                ...state,
                busyKind: null,
                progress: '',
                error: resultMessage(result, '打开项目失败。'),
              }
            : state,
        );
        return;
      }
      const prepared = await prepareProjectSession(result.value);
      if (
        !mountedRef.current ||
        leaveSequenceRef.current !== leaveId
      ) {
        return;
      }
      setLeave((state) =>
        state
          ? {
              ...state,
              progress: '正在保存原项目工作区…',
            }
          : state,
      );
      const saveError = await flushLeavingProject(
        oldProjectId,
        discardUnsaved,
      );
      if (
        !mountedRef.current ||
        leaveSequenceRef.current !== leaveId
      ) {
        return;
      }
      if (saveError) {
        setLeave((state) =>
          state
            ? {
                ...state,
                busyKind: null,
                progress: '',
                error: saveError,
              }
            : state,
        );
        return;
      }
      if (discardUnsaved) {
        dispatchData({
          type: 'session',
          projectId: oldProjectId,
          action: { type: 'discard-unsaved' },
        });
      }
      activateProject(result.value, {
        session: prepared.session,
        workspaceRevision: prepared.revision,
        workspaceBlocked: prepared.blocked,
        restoreErrors: prepared.errors,
      });
      leaveSequenceRef.current += 1;
      setLeave(null);
      return;
    }

    const formSnapshot = current.intent.form;
    setLeave((state) =>
      state
        ? {
            ...state,
            busyKind: 'creating',
            error: '',
            progress: '正在创建项目…',
          }
        : state,
    );
    const saveError = await flushLeavingProject(
      oldProjectId,
      discardUnsaved,
    );
    if (
      !mountedRef.current ||
      leaveSequenceRef.current !== leaveId
    ) {
      return;
    }
    if (saveError) {
      setLeave((state) =>
        state
          ? {
              ...state,
              busyKind: null,
              progress: '',
              error: saveError,
            }
          : state,
      );
      return;
    }
    const result = await safely(
      () =>
        capabilities.createProject({
          folder: formSnapshot.folder,
          toolboxId: formSnapshot.toolboxId,
          replaceProjectId: formSnapshot.replaceProjectId,
          replaceProjectIds: formSnapshot.replaceProjectIds,
          ...(formSnapshot.confirmOverwrite
            ? { confirmOverwrite: true }
            : {}),
        }),
      '创建项目失败。',
    );
    if (
      !mountedRef.current ||
      leaveSequenceRef.current !== leaveId
    ) {
      return;
    }
    if (result.status !== 'success') {
      const errorCode = result.status === 'error' ? result.code : undefined;
      const existingProjectId =
        result.status === 'error' ? result.existingProjectId : undefined;
      const existingProjectIds =
        result.status === 'error' ? result.existingProjectIds : undefined;
      const needsConfirmation =
        errorCode === 'project-overwrite-confirmation-required' ||
        errorCode === 'project-recreate-confirmation-required';
      leaveSequenceRef.current += 1;
      setLeave(null);
      setForm((previous) => ({
        ...previous,
        folder: errorCode === PROJECT_PATH_HAN_ERROR.code
          ? { ...formSnapshot.folder, pathContainsHan: true }
          : formSnapshot.folder,
        selectedToolboxId: formSnapshot.toolboxId,
        toolboxesLoading: false,
        pickingFolder: false,
        submitting: false,
        error: needsConfirmation || errorCode === PROJECT_PATH_HAN_ERROR.code
          ? ''
          : resultMessage(result, '创建项目失败。'),
        recreateProjectId: existingProjectId ?? formSnapshot.replaceProjectId,
        recreateProjectIds:
          existingProjectIds ?? formSnapshot.replaceProjectIds,
        rebuildConfirmation:
          errorCode === 'project-overwrite-confirmation-required'
            ? {
                mode: 'overwrite',
                existingProjectIds:
                  existingProjectIds ??
                  formSnapshot.replaceProjectIds ??
                  [],
              }
            : errorCode === 'project-recreate-confirmation-required'
              ? {
                  mode: 'recreate',
                  existingProjectIds:
                    existingProjectIds ??
                    formSnapshot.replaceProjectIds ??
                    [],
                }
              : undefined,
      }));
      setProjectFormOpen(true);
      return;
    }
    for (const id of result.value.replacedProjectIds ?? (formSnapshot.replaceProjectId ? [formSnapshot.replaceProjectId] : [])) retireProjectCache(id);
    const prepared = await prepareProjectSession(result.value, {
      replaceSession: true,
    });
    if (
      !mountedRef.current ||
      leaveSequenceRef.current !== leaveId
    ) {
      return;
    }
    if (discardUnsaved) {
      dispatchData({
        type: 'session',
        projectId: oldProjectId,
        action: { type: 'discard-unsaved' },
      });
    }
    activateProject(result.value, {
      replaceSession: true,
      session: prepared.session,
      workspaceRevision: prepared.revision,
      workspaceBlocked: prepared.blocked,
      restoreErrors: prepared.errors,
    });
    leaveSequenceRef.current += 1;
    setLeave(null);
    setProjectFormOpen(false);
    setForm(emptyFormSnapshot());
  }

  function nextDocumentInstanceId(): string {
    documentInstanceRef.current += 1;
    return `document-${documentInstanceRef.current}`;
  }

  function saveDocumentSnapshot(
    projectId: string,
    document: OpenDocument,
    content: string,
    forceVersion?: string,
  ): Promise<ServiceResult<SaveFileResult>> {
    if (!capabilities) {
      return Promise.resolve({
        status: 'error',
        message: '当前环境不可用。',
      });
    }
    const key = documentKey(projectId, document.identity);
    const activeSave = forceVersion
      ? undefined
      : saveInFlightRef.current.get(key);
    if (activeSave?.content === content) {
      return activeSave.promise;
    }
    const previous = activeSave?.promise;
    const base = previous
      ? previous.then(() => undefined)
      : Promise.resolve();
    const promise = base.then(async () => {
      const latest = dataRef.current.sessions[projectId]?.tabs.find(
        (item) =>
          item.identity === document.identity &&
          item.instanceId === document.instanceId,
      );
      const expectedVersion = forceVersion
        ? forceVersion
        : saveVersionsRef.current.get(key) ??
          latest?.version ??
          document.version;
      const result = await safely(
        () =>
          capabilities!.saveFile({
            projectId,
            fileIdentity: document.identity,
            path: latest?.path ?? document.path,
            content,
            ...(expectedVersion ? { expectedVersion } : {}),
            ...(forceVersion ? { force: true } : {}),
            bom: latest?.bom ?? document.bom,
            newline: latest?.newline ?? document.newline,
          }),
        `保存「${document.name}」失败。`,
      );
      if (result.status === 'success' && result.value?.version) {
        saveVersionsRef.current.set(key, result.value.version);
      }
      const projectSession = dataRef.current.sessions[projectId];
      if (
        result.status === 'success' &&
        dataRef.current.currentProjectId === projectId &&
        projectSession?.project.toolboxId === WORKFLOW_TOOLBOX &&
        findCaseDict(projectSession.tree)?.fileIdentity === document.identity
      ) {
        refreshSavedWorkflow();
      }
      if (
        result.status === 'error' &&
        result.code === 'version-conflict' &&
        dataRef.current.currentProjectId === projectId
      ) {
        setSaveConflict((current) => {
          if (
            current &&
            current.identity === document.identity &&
            current.instanceId === document.instanceId
          ) {
            return {
              ...current,
              currentVersion: result.currentVersion ?? current.currentVersion,
            };
          }
          return {
            projectId,
            identity: document.identity,
            instanceId: document.instanceId,
            fileName: document.name,
            ...(result.currentVersion
              ? { currentVersion: result.currentVersion }
              : {}),
            busy: false,
            error: '',
          };
        });
      }
      return result;
    });
    const entry = { content, promise };
    if (!forceVersion) saveInFlightRef.current.set(key, entry);
    void promise.finally(() => {
      if (saveInFlightRef.current.get(key) === entry) {
        saveInFlightRef.current.delete(key);
      }
    });
    return promise;
  }

  async function reloadConflictedDocument() {
    const conflict = saveConflict;
    if (!conflict || !capabilities || conflict.busy) return;
    setSaveConflict({ ...conflict, busy: true, error: '' });
    const result = await safely(
      () =>
        capabilities.readFile({
          projectId: conflict.projectId,
          fileIdentity: conflict.identity,
        }),
      '重新读取磁盘文件失败。',
    );
    if (!mountedRef.current) return;
    if (result.status !== 'success') {
      setSaveConflict((current) =>
        current
          ? {
              ...current,
              busy: false,
              error:
                result.status === 'error'
                  ? result.message
                  : '读取已取消。',
            }
          : current,
      );
      return;
    }
    saveVersionsRef.current.set(
      documentKey(conflict.projectId, conflict.identity),
      result.value.version ?? '',
    );
    dispatchData({
      type: 'session',
      projectId: conflict.projectId,
      action: {
        type: 'reload-document',
        identity: conflict.identity,
        instanceId: conflict.instanceId,
        content: result.value.content,
        ...(result.value.version !== undefined
          ? { version: result.value.version }
          : {}),
        ...(result.value.bom !== undefined ? { bom: result.value.bom } : {}),
        ...(result.value.newline !== undefined
          ? { newline: result.value.newline }
          : {}),
      },
    });
    setSaveConflict(null);
    showNotice('已重新载入磁盘内容，未保存的编辑已放弃。', 'success');
  }

  async function overwriteConflictedDocument() {
    const conflict = saveConflict;
    if (!conflict || conflict.busy) return;
    const projectSession = dataRef.current.sessions[conflict.projectId];
    const document = projectSession?.tabs.find(
      (item) =>
        item.identity === conflict.identity &&
        item.instanceId === conflict.instanceId,
    );
    if (!document) {
      setSaveConflict(null);
      return;
    }
    if (!conflict.currentVersion) {
      setSaveConflict({
        ...conflict,
        error: '无法确认磁盘版本，请先重新载入磁盘。',
      });
      return;
    }
    setSaveConflict({ ...conflict, busy: true, error: '' });
    const snapshot = document.content;
    const result = await saveDocumentSnapshot(
      conflict.projectId,
      document,
      snapshot,
      conflict.currentVersion,
    );
    if (!mountedRef.current) return;
    if (result.status === 'success') {
      dispatchData({
        type: 'session',
        projectId: conflict.projectId,
        action: {
          type: 'mark-document-saved',
          identity: conflict.identity,
          instanceId: conflict.instanceId,
          savedContent: snapshot,
          ...(result.value?.version
            ? { version: result.value.version }
            : {}),
        },
      });
      setSaveConflict(null);
      showNotice('已覆盖保存。', 'success');
      return;
    }
    setSaveConflict((current) =>
      current
        ? {
            ...current,
            busy: false,
            error:
              result.status === 'error'
                ? result.message
                : '保存已取消。',
          }
        : current,
    );
  }

  async function saveMissingDocumentAs(name: string) {
    const target = saveAsTarget;
    if (!target || !capabilities?.saveFileAs || target.busy) return;
    const projectSession = dataRef.current.sessions[target.projectId];
    const document = projectSession?.tabs.find(
      (item) =>
        item.identity === target.identity &&
        item.instanceId === target.instanceId,
    );
    if (!document) {
      setSaveAsTarget(null);
      return;
    }
    setSaveAsTarget({ ...target, busy: true, error: '' });
    const result = await safely(
      () =>
        capabilities!.saveFileAs!({
          projectId: target.projectId,
          fileIdentity: target.identity,
          name,
          content: document.content,
        }),
      '另存恢复内容失败。',
    );
    if (!mountedRef.current) return;
    if (result.status !== 'success') {
      setSaveAsTarget((current) =>
        current
          ? {
              ...current,
              busy: false,
              error:
                result.status === 'error' ? result.message : '保存已取消。',
            }
          : current,
      );
      return;
    }
    dispatchData({
      type: 'session',
      projectId: target.projectId,
      action: {
        type: 'sync-project',
        snapshot: { project: projectSession.project, tree: result.value.tree },
        changedFileIdentities: [],
        deletedFileIdentities: [],
      },
    });
    dispatchData({
      type: 'session',
      projectId: target.projectId,
      action: {
        type: 'close-document',
        identity: target.identity,
      },
    });
    const instanceId = nextDocumentInstanceId();
    dispatchData({
      type: 'session',
      projectId: target.projectId,
      action: {
        type: 'open-document',
        document: createDocument(
          name,
          result.value.path,
          result.value.fileIdentity,
          instanceId,
          document.content,
          { version: result.value.version },
        ),
      },
    });
    saveVersionsRef.current.set(
      documentKey(target.projectId, result.value.fileIdentity),
      result.value.version,
    );
    setSaveAsTarget(null);
    showNotice(`已另存为「${name}」。`, 'success');
  }

  async function handleManualSave() {
    const current = currentSession(dataRef.current);
    if (!current || !capabilities) return;
    const documentToSave = activeDocument(current);
    if (
      !documentToSave ||
      !isEditableViewer(documentToSave.viewerKind) ||
      !documentToSave.dirty
    ) {
      return;
    }
    const projectId = current.project.id;
    const instanceId = documentToSave.instanceId;
    const snapshot = documentToSave.content;
    const result = await saveDocumentSnapshot(
      projectId,
      documentToSave,
      snapshot,
    );
    if (!mountedRef.current) return;
    if (result.status === 'success') {
      dispatchData({
        type: 'session',
        projectId,
        action: {
          type: 'mark-document-saved',
          identity: documentToSave.identity,
          instanceId,
          savedContent: snapshot,
          ...(result.value?.version
            ? { version: result.value.version }
            : {}),
        },
      });
      return;
    }
    const latestSession = dataRef.current.sessions[projectId];
    const latestDocument = latestSession?.tabs.find(
      (document) =>
        document.identity === documentToSave.identity &&
        document.instanceId === instanceId,
    );
    if (
      latestDocument &&
      dataRef.current.currentProjectId === projectId
    ) {
      if (result.status === 'error' && result.code === 'version-conflict') {
        // The conflict dialog owns this failure and offers explicit actions.
        return;
      }
      showNotice(
        resultMessage(result, '保存失败，请重试。'),
        'error',
      );
    }
  }

  async function saveAndContinue() {
    const current = leaveRef.current;
    const currentProjectId = dataRef.current.currentProjectId;
    if (
      !current ||
      !currentProjectId ||
      !capabilities ||
      current.busyKind ||
      current.tasksStatus !== 'ready' ||
      current.tasks.length > 0
    ) {
      return;
    }
    const leaveId = current.id;
    const sessionNow = dataRef.current.sessions[currentProjectId];
    const dirtyDocuments =
      sessionNow?.tabs.filter((document) => document.dirty) ?? [];
    const readOnlyDirtyDocument = dirtyDocuments.find(
      (document) => !isEditableViewer(document.viewerKind),
    );
    if (readOnlyDirtyDocument) {
      setLeave((state) =>
        state
          ? {
              ...state,
              busyKind: null,
              progress: '',
              error: `「${readOnlyDirtyDocument.name}」当前以只读${viewerKindLabel(readOnlyDirtyDocument.viewerKind)}方式打开，但仍有未保存的文本修改，不能保存为${viewerKindLabel(readOnlyDirtyDocument.viewerKind)}文件。请取消离开，将扩展名改回文本格式后保存；或选择“不保存并继续”。`,
            }
          : state,
      );
      return;
    }

    setLeave((state) =>
      state
        ? {
            ...state,
            busyKind: 'saving',
            error: '',
            progress: '正在保存文件…',
          }
        : state,
    );

    for (const document of dirtyDocuments) {
      const snapshot = document.content;
      const result = await saveDocumentSnapshot(
        currentProjectId,
        document,
        snapshot,
      );
      if (
        !mountedRef.current ||
        leaveSequenceRef.current !== leaveId
      ) {
        return;
      }
      if (result.status !== 'success') {
        setLeave((state) =>
          state
            ? {
                ...state,
                busyKind: null,
                progress: '',
                error: resultMessage(result, '保存文件失败。'),
              }
            : state,
        );
        return;
      }
      const latestBeforeMark = dataRef.current.sessions[
        currentProjectId
      ]?.tabs.find(
        (item) =>
          item.identity === document.identity &&
          item.instanceId === document.instanceId,
      );
      if (latestBeforeMark && latestBeforeMark.content !== snapshot) {
        setLeave((state) =>
          state
            ? {
                ...state,
                busyKind: null,
                progress: '',
                error:
                  '保存期间文件内容又被修改，尚未离开项目；请再次保存后再继续。',
              }
            : state,
        );
        return;
      }
      dispatchData({
        type: 'session',
        projectId: currentProjectId,
        action: {
          type: 'mark-document-saved',
          identity: document.identity,
          instanceId: document.instanceId,
          savedContent: snapshot,
          ...(result.value?.version
            ? { version: result.value.version }
            : {}),
        },
      });
    }

    await commitLeave(current, false);
  }

  function discardAndContinue() {
    const current = leaveRef.current;
    if (
      !current ||
      current.busyKind ||
      current.tasksStatus !== 'ready' ||
      current.tasks.length > 0
    ) {
      return;
    }
    void commitLeave(current, true);
  }

  function continueLeave() {
    const current = leaveRef.current;
    if (
      !current ||
      current.busyKind ||
      current.tasksStatus !== 'ready' ||
      current.tasks.length > 0
    ) {
      return;
    }
    void commitLeave(current, false);
  }

  async function handleCopyProjectPath() {
    if (!capabilities || !session) return;
    const result = await safely(
      () => capabilities.copyText(session.project.path),
      '复制路径失败。',
    );
    if (!mountedRef.current) return;
    if (result.status === 'success') {
      showNotice('路径已复制。', 'success');
    } else {
      showNotice(
        resultMessage(result, '复制路径失败。'),
        'error',
      );
    }
  }

  async function handleOpenChatProjectFile(projectId: string, href: string) {
    const inactiveProjectMessage = '这条回复所属的项目已失效或未打开。';
    if (dataRef.current.currentProjectId !== projectId) {
      showNotice(inactiveProjectMessage, 'error');
      return;
    }
    const resolveLink = capabilities?.resolveProjectFileLink;
    if (!resolveLink) {
      showNotice('当前环境无法打开项目文件链接。', 'error');
      return;
    }
    const result = await safely(
      () => resolveLink({ projectId, href }),
      '无法打开项目文件链接。',
    );
    if (!mountedRef.current) return;
    if (dataRef.current.currentProjectId !== projectId) {
      showNotice(inactiveProjectMessage, 'error');
    } else if (result.status === 'success') {
      await handleOpenFile(result.value, projectId);
    } else {
      showNotice(resultMessage(result, '无法打开项目文件链接。'), 'error');
    }
  }

  async function handleOpenFile(entry: FileTreeEntry, linkProjectId?: string) {
    const current = currentSession(dataRef.current);
    if (!current || !capabilities) return;
    const projectId = current.project.id;
    if (linkProjectId !== undefined && linkProjectId !== projectId) return;
    const identity = entry.fileIdentity;
    if (!identity) {
      showNotice('无法读取该文件身份。', 'error');
      return;
    }
    const existing = current.tabs.find(
      (document) => document.identity === identity,
    );
    if (existing) {
      dispatchData({
        type: 'session',
        projectId,
        action: { type: 'activate-document', identity },
      });
      return;
    }

    const initialKind = viewerKindForFileName(entry.name);
    if (!isTextContentViewer(initialKind)) {
      const document = createDocument(
        entry.name,
        entry.path,
        identity,
        nextDocumentInstanceId(),
        '',
      );
      dispatchData({
        type: 'session',
        projectId,
        action: { type: 'open-document', document },
      });
      return;
    }

    const key = documentKey(projectId, identity);
    if (inFlightReadsRef.current.has(key)) return;
    const startEpoch = documentCloseEpochRef.current.get(key) ?? 0;
    // A sync event for a new link target can still be pending in React.
    const linkEntry =
      linkProjectId !== undefined && !findFileByIdentity(current.tree, identity)
        ? entry
        : null;

    const request = (async () => {
      const result = await safely(
        () =>
          capabilities.readFile({
            projectId,
            fileIdentity: identity,
          }),
        `无法打开「${entry.name}」。`,
      );
      if (!mountedRef.current) return;

      const currentEpoch = documentCloseEpochRef.current.get(key) ?? 0;
      if (currentEpoch !== startEpoch) return;

      const latestSession = dataRef.current.sessions[projectId];
      if (!latestSession) return;
      const currentTab = latestSession.tabs.find(
        (document) => document.identity === identity,
      );
      if (currentTab) return;
      const latestEntry = findFileByIdentity(latestSession.tree, identity) ?? linkEntry;
      const latestKind = latestEntry ? viewerKindForFileName(latestEntry.name) : null;

      if (result.status !== 'success') {
        if (
          dataRef.current.currentProjectId === projectId &&
          (linkProjectId !== undefined || (latestKind && isTextContentViewer(latestKind)))
        ) {
          showNotice(
            resultMessage(result, `无法打开「${entry.name}」。`),
            'error',
          );
        }
        return;
      }
      if (!latestEntry || !latestKind) return;

      const document = createDocument(
        latestEntry.name,
        latestEntry.path,
        identity,
        nextDocumentInstanceId(),
        isTextContentViewer(latestKind) ? result.value.content : '',
        isTextContentViewer(latestKind)
          ? {
              version: result.value.version,
              bom: result.value.bom,
              newline: result.value.newline,
            }
          : {},
      );
      if (result.value.version) {
        saveVersionsRef.current.set(
          documentKey(projectId, identity),
          result.value.version,
        );
      }
      dispatchData({
        type: 'session',
        projectId,
        action: { type: 'open-document', document },
      });
    })();

    inFlightReadsRef.current.set(key, request);
    try {
      await request;
    } finally {
      if (inFlightReadsRef.current.get(key) === request) {
        inFlightReadsRef.current.delete(key);
      }
    }
  }

  function handleActivateTab(identity: string) {
    if (!session) return;
    dispatchData({
      type: 'session',
      projectId: session.project.id,
      action: { type: 'activate-document', identity },
    });
  }

  function handleChangeDocument(
    projectId: string,
    identity: string,
    content: string,
  ) {
    dispatchData({
      type: 'session',
      projectId,
      action: {
        type: 'update-document-content',
        identity,
        content,
      },
    });
  }

  function handleTextViewChange(
    projectId: string,
    identity: string,
    patch: Partial<TextViewState>,
  ) {
    dispatchData({
      type: 'session',
      projectId,
      action: { type: 'update-text-view', identity, patch },
    });
  }

  function handleMarkdownModeChange(
    projectId: string,
    identity: string,
    mode: 'preview' | 'source',
  ) {
    dispatchData({
      type: 'session',
      projectId,
      action: { type: 'set-markdown-mode', identity, mode },
    });
  }

  function handlePreviewScroll(
    projectId: string,
    identity: string,
    scrollTop: number,
  ) {
    dispatchData({
      type: 'session',
      projectId,
      action: {
        type: 'set-markdown-preview-scroll',
        identity,
        scrollTop,
      },
    });
  }

  function handleImageViewChange(
    projectId: string,
    identity: string,
    patch: Partial<ImageViewState>,
  ) {
    dispatchData({
      type: 'session',
      projectId,
      action: { type: 'update-image-view', identity, patch },
    });
  }

  function handleCsvViewChange(
    projectId: string,
    identity: string,
    instanceId: string,
    patch: Partial<CsvViewState>,
  ) {
    dispatchData({
      type: 'session',
      projectId,
      action: {
        type: 'update-csv-view',
        identity,
        instanceId,
        patch,
      },
    });
  }

  function handleH5ViewChange(
    projectId: string,
    identity: string,
    instanceId: string,
    patch: Partial<H5ViewState>,
  ) {
    dispatchData({
      type: 'session',
      projectId,
      action: {
        type: 'update-h5-view',
        identity,
        instanceId,
        patch,
      },
    });
  }

  function handleRefreshHtml(
    projectId: string,
    identity: string,
    instanceId: string,
  ) {
    void requestHtmlPreview(projectId, identity, instanceId, true);
  }

  async function persistDocumentClose(
    projectId: string,
    identity: string,
  ): Promise<string | null> {
    return flushProjectWorkspace(projectId, {
      closeIdentity: identity,
    });
  }

  function handleCloseTab(
    identity: string,
    trigger: HTMLElement | null,
  ) {
    if (!session) return;
    const document = session.tabs.find(
      (item) => item.identity === identity,
    );
    if (!document) return;
    if (!document.dirty) {
      const projectId = session.project.id;
      const instanceId = document.instanceId;
      void (async () => {
        const error = await persistDocumentClose(projectId, identity);
        if (!mountedRef.current) return;
        if (error) {
          showNotice(error, 'error');
          return;
        }
        const latest = dataRef.current.sessions[projectId]?.tabs.find(
          (item) =>
            item.identity === identity && item.instanceId === instanceId,
        );
        if (!latest) return;
        if (latest.dirty) {
          // The close was authorized while the tab was clean, but new input
          // arrived while the workspace save was in flight. It was not part of
          // that decision: cancel the close and keep the now-dirty tab open
          // rather than dropping or silently confirming away the new edit.
          const workspaceError = await flushProjectWorkspace(projectId);
          if (!mountedRef.current) return;
          if (workspaceError) {
            showNotice(workspaceError, 'error');
            return;
          }
          showNotice(
            '关闭期间文档内容有新编辑，标签已保持打开；请重新关闭。',
            'error',
          );
          return;
        }
        noteDocumentClosed(projectId, identity);
        dispatchData({
          type: 'session',
          projectId,
          action: { type: 'close-document', identity },
        });
      })();
      return;
    }
    tabCloseReturnFocusRef.current =
      trigger ?? captureDialogTrigger();
    tabCloseSequenceRef.current += 1;
    setTabClose({
      id: tabCloseSequenceRef.current,
      projectId: session.project.id,
      identity,
      saving: false,
      error: '',
    });
  }

  function cancelTabClose() {
    if (tabClose?.saving) return;
    tabCloseSequenceRef.current += 1;
    setTabClose(null);
  }

  async function discardTabClose() {
    const current = tabClose;
    if (!current || current.saving) return;
    const startingDocument = dataRef.current.sessions[
      current.projectId
    ]?.tabs.find((item) => item.identity === current.identity);
    const startingContent = startingDocument?.content;
    const startingInstanceId = startingDocument?.instanceId;
    setTabClose((state) =>
      state ? { ...state, saving: true, error: '' } : state,
    );
    const error = await persistDocumentClose(
      current.projectId,
      current.identity,
    );
    if (
      !mountedRef.current ||
      tabCloseSequenceRef.current !== current.id
    ) {
      return;
    }
    if (error) {
      setTabClose((state) =>
        state
          ? { ...state, saving: false, error }
          : state,
      );
      return;
    }
    const latest = dataRef.current.sessions[current.projectId]?.tabs.find(
      (item) =>
        item.identity === current.identity &&
        item.instanceId === startingInstanceId,
    );
    if (!latest) return;
    if (latest.content !== startingContent) {
      // The user typed after asking to discard the earlier body. Preserve the
      // new body and return to the confirmation instead of treating the new
      // input as part of the old discard decision.
      await flushProjectWorkspace(current.projectId);
      if (!mountedRef.current) return;
      setTabClose((state) =>
        state
          ? {
              ...state,
              saving: false,
              error:
                '放弃确认期间内容又被修改，标签尚未关闭；请重新确认。',
            }
          : state,
      );
      return;
    }
    noteDocumentClosed(current.projectId, current.identity);
    dispatchData({
      type: 'session',
      projectId: current.projectId,
      action: {
        type: 'close-document',
        identity: current.identity,
      },
    });
    tabCloseSequenceRef.current += 1;
    setTabClose(null);
  }

  async function saveTabClose() {
    const current = tabClose;
    if (!current || current.saving || !capabilities) return;
    const document = dataRef.current.sessions[current.projectId]?.tabs.find(
      (item) => item.identity === current.identity,
    );
    if (!document) {
      tabCloseSequenceRef.current += 1;
      setTabClose(null);
      return;
    }
    if (!isEditableViewer(document.viewerKind)) {
      setTabClose((state) =>
        state
          ? {
              ...state,
              saving: false,
              error: `${viewerKindLabel(document.viewerKind)}文件不支持文本保存。`,
            }
          : state,
      );
      return;
    }
    const tabCloseId = current.id;
    const snapshot = document.content;
    setTabClose((state) =>
      state
        ? { ...state, saving: true, error: '' }
        : state,
    );
    const result = await saveDocumentSnapshot(
      current.projectId,
      document,
      snapshot,
    );
    if (
      !mountedRef.current ||
      tabCloseSequenceRef.current !== tabCloseId
    ) {
      return;
    }
    if (result.status !== 'success') {
      setTabClose((state) =>
        state
          ? {
              ...state,
              saving: false,
              error: resultMessage(result, '保存失败，请重试。'),
            }
          : state,
      );
      return;
    }
    const latestDocument = dataRef.current.sessions[
      current.projectId
    ]?.tabs.find(
      (item) =>
        item.identity === current.identity &&
        item.instanceId === document.instanceId,
    );
    if (!latestDocument) {
      tabCloseSequenceRef.current += 1;
      setTabClose(null);
      return;
    }
    if (latestDocument.content !== snapshot) {
      dispatchData({
        type: 'session',
        projectId: current.projectId,
        action: {
          type: 'mark-document-saved',
          identity: current.identity,
          instanceId: document.instanceId,
          savedContent: snapshot,
          ...(result.value?.version
            ? { version: result.value.version }
            : {}),
        },
      });
      setTabClose((state) =>
        state
          ? {
              ...state,
              saving: false,
              error:
                '保存期间文档内容又被修改，标签尚未关闭；请再次保存。',
            }
          : state,
      );
      return;
    }
    const persistError = await persistDocumentClose(
      current.projectId,
      current.identity,
    );
    if (
      !mountedRef.current ||
      tabCloseSequenceRef.current !== tabCloseId
    ) {
      return;
    }
    if (persistError) {
      setTabClose((state) =>
        state
          ? {
              ...state,
              saving: false,
              error: persistError,
            }
          : state,
      );
      return;
    }
    const afterPersist = dataRef.current.sessions[
      current.projectId
    ]?.tabs.find(
      (item) =>
        item.identity === current.identity &&
        item.instanceId === document.instanceId,
    );
    if (!afterPersist) return;
    if (afterPersist.content !== snapshot) {
      // The file was saved, but the user typed again while the workspace
      // close record was being written. Keep the tab; the new body is dirty
      // relative to the saved snapshot.
      dispatchData({
        type: 'session',
        projectId: current.projectId,
        action: {
          type: 'mark-document-saved',
          identity: current.identity,
          instanceId: document.instanceId,
          savedContent: snapshot,
          ...(result.value?.version
            ? { version: result.value.version }
            : {}),
        },
      });
      setTabClose((state) =>
        state
          ? {
              ...state,
              saving: false,
              error:
                '保存期间文档内容又被修改，标签尚未关闭；请再次保存。',
            }
          : state,
      );
      return;
    }
    noteDocumentClosed(current.projectId, current.identity);
    dispatchData({
      type: 'session',
      projectId: current.projectId,
      action: {
        type: 'close-document',
        identity: current.identity,
      },
    });
    tabCloseSequenceRef.current += 1;
    setTabClose(null);

  }

  async function handleCreateEntry(
    parentId: string | null,
    kind: FileTreeEntryKind,
    name: string,
  ): Promise<TreeOperationFeedback> {
    const current = currentSession(dataRef.current);
    if (!current || !capabilities) {
      return { ok: false, message: '当前环境不可用。' };
    }
    const projectId = current.project.id;
    const result = await safely(
      () =>
        capabilities.createEntry({
          projectId,
          parentId,
          kind,
          name,
        }),
      '新建失败，请重试。',
    );
    if (result.status !== 'success') {
      if (result.status === 'error' && result.treeResult) {
        applyMutation(projectId, result.treeResult, {
          preserveDirtyDeleted: result.partial === true,
        });
      }
      return {
        ok: false,
        message: resultMessage(result, '新建失败，请重试。'),
      };
    }
    applyMutation(projectId, result.value, {
      selectionId: result.value.targetEntryId ?? undefined,
      expandToId: result.value.targetEntryId ?? undefined,
    });
    return {
      ok: true,
      entryId: result.value.targetEntryId,
    };
  }

  async function handleRenameEntry(
    entryId: string,
    name: string,
  ): Promise<TreeOperationFeedback> {
    const current = currentSession(dataRef.current);
    if (!current || !capabilities) {
      return { ok: false, message: '当前环境不可用。' };
    }
    const projectId = current.project.id;
    const result = await safely(
      () =>
        capabilities.renameEntry({
          projectId,
          entryId,
          name,
        }),
      '重命名失败，请重试。',
    );
    if (result.status !== 'success') {
      if (result.status === 'error' && result.treeResult) {
        applyMutation(projectId, result.treeResult, {
          selectionId: entryId,
          expandToId: entryId,
          preserveDirtyDeleted: result.partial === true,
        });
      }
      return {
        ok: false,
        message: resultMessage(result, '重命名失败，请重试。'),
      };
    }
    applyMutation(projectId, result.value, {
      selectionId: result.value.targetEntryId ?? entryId,
      expandToId: result.value.targetEntryId ?? entryId,
    });
    return {
      ok: true,
      entryId: result.value.targetEntryId ?? entryId,
    };
  }

  async function handleDeleteEntry(
    entryId: string,
  ): Promise<TreeOperationFeedback> {
    const current = currentSession(dataRef.current);
    if (!current || !capabilities) {
      return { ok: false, message: '当前环境不可用。' };
    }
    const projectId = current.project.id;
    const parentId = parentIdOf(current.tree, entryId);
    const result = await safely(
      () =>
        capabilities.deleteEntry({
          projectId,
          entryId,
        }),
      '删除失败，请重试。',
    );
    if (result.status !== 'success') {
      if (result.status === 'error' && result.treeResult) {
        applyMutation(projectId, result.treeResult, {
          selectionId: parentId,
          expandToId: parentId,
          preserveDirtyDeleted: result.partial === true,
        });
      }
      return {
        ok: false,
        message: resultMessage(result, '删除失败，请重试。'),
      };
    }
    applyMutation(projectId, result.value, {
      selectionId: parentId,
      expandToId: parentId,
    });
    return { ok: true, entryId: parentId ?? undefined };
  }

  async function handlePasteEntry(
    targetFolderId: string | null,
    sourceEntryId: string,
    mode: 'cut' | 'copy',
  ): Promise<TreeOperationFeedback> {
    const current = currentSession(dataRef.current);
    if (!current || !capabilities) {
      return { ok: false, message: '当前环境不可用。' };
    }
    const projectId = current.project.id;
    if (pasteInFlightRef.current.has(projectId)) {
      return { ok: false, ignored: true };
    }
    pasteInFlightRef.current.add(projectId);
    dispatchData({
      type: 'session',
      projectId,
      action: { type: 'set-paste-pending', pending: true },
    });

    try {
      const result = await safely(
        () =>
          capabilities.pasteEntry({
            projectId,
            targetFolderId,
            sourceEntryId,
            mode,
          }),
        '粘贴失败，请重试。',
      );
      if (result.status !== 'success') {
        if (result.status === 'error' && result.treeResult) {
          applyMutation(projectId, result.treeResult, {
            preserveDirtyDeleted: result.partial === true,
          });
        }
        return {
          ok: false,
          message: resultMessage(result, '粘贴失败，请重试。'),
        };
      }
      applyMutation(projectId, result.value, {
        selectionId: result.value.targetEntryId ?? undefined,
        expandToId: result.value.targetEntryId ?? undefined,
        clearClipboard: mode === 'cut',
      });
      return {
        ok: true,
        entryId: result.value.targetEntryId,
      };
    } catch {
      return { ok: false, message: '粘贴失败，请重试。' };
    } finally {
      pasteInFlightRef.current.delete(projectId);
      if (mountedRef.current) {
        dispatchData({
          type: 'session',
          projectId,
          action: { type: 'set-paste-pending', pending: false },
        });
      }
    }
  }

  function maybeHydrateRenamedTextDocuments(
    projectId: string,
    tree: TreeMutationResult['tree'],
  ) {
    if (!capabilities) return;
    const current = dataRef.current.sessions[projectId];
    if (!current) return;
    for (const document of current.tabs) {
      if (document.contentLoaded) continue;
      const entry = findFileByIdentity(tree, document.identity);
      if (!entry) continue;
      const nextKind = viewerKindForFileName(entry.name);
      if (!isTextContentViewer(nextKind)) continue;
      const key = `${projectId}\u0000${document.instanceId}`;
      if (kindHydrationRef.current.has(key)) continue;
      const request = (async () => {
        const result = await safely(
          () =>
            capabilities.readFile({
              projectId,
              fileIdentity: document.identity,
            }),
          `无法读取「${document.name}」。`,
        );
        if (!mountedRef.current) return;
        const latestDocument = dataRef.current.sessions[
          projectId
        ]?.tabs.find(
          (item) =>
            item.identity === document.identity &&
            item.instanceId === document.instanceId,
        );
        if (!latestDocument) return;
        if (result.status !== 'success') {
          if (dataRef.current.currentProjectId === projectId) {
            showNotice(
              resultMessage(
                result,
                `无法读取「${document.name}」。`,
              ),
              'error',
            );
          }
          return;
        }
        if (result.value.version) {
          saveVersionsRef.current.set(
            documentKey(projectId, document.identity),
            result.value.version,
          );
        }
        dispatchData({
          type: 'session',
          projectId,
          action: {
            type: 'hydrate-document',
            identity: document.identity,
            instanceId: document.instanceId,
            content: result.value.content,
            version: result.value.version,
            bom: result.value.bom,
            newline: result.value.newline,
          },
        });
      })();
      kindHydrationRef.current.set(key, request);
      void request.finally(() => {
        if (kindHydrationRef.current.get(key) === request) {
          kindHydrationRef.current.delete(key);
        }
      });
    }
  }

  function applyMutation(
    projectId: string,
    result: TreeMutationResult,
    options: {
      selectionId?: string | null;
      expandToId?: string | null;
      clearClipboard?: boolean;
      preserveDirtyDeleted?: boolean;
    },
  ) {
    dispatchData({
      type: 'session',
      projectId,
      action: {
        type: 'apply-tree-result',
        result,
        ...options,
      },
    });
    maybeHydrateRenamedTextDocuments(projectId, result.tree);
  }

  async function handleCopyPath(path: string) {
    if (!capabilities) return;
    const result = await safely(
      () => capabilities.copyText(path),
      '复制路径失败。',
    );
    if (!mountedRef.current) return;
    if (result.status === 'success') {
      showNotice('路径已复制。', 'success');
    } else {
      showNotice(resultMessage(result, '复制路径失败。'), 'error');
    }
  }

  async function handleRevealPath(
    path: string,
    isDirectory: boolean,
  ) {
    const current = currentSession(dataRef.current);
    if (!capabilities || !current) return;
    const projectId = current.project.id;
    const result = await safely(
      () =>
        capabilities.revealPath({
          projectId,
          path,
          isDirectory,
        }),
      '无法在资源管理器中打开。',
    );
    if (!mountedRef.current) return;
    if (result.status !== 'success') {
      if (dataRef.current.currentProjectId === projectId) {
        showNotice(
          resultMessage(result, '无法在资源管理器中打开。'),
          'error',
        );
      }
    }
  }

  function handleSetClipboard(clipboard: TreeClipboard | null) {
    if (!session) return;
    dispatchData({
      type: 'session',
      projectId: session.project.id,
      action: { type: 'set-clipboard', clipboard },
    });
  }

  const treeActions = {
    onToggleExpanded: (entryId: string) => {
      if (!session) return;
      dispatchData({
        type: 'session',
        projectId: session.project.id,
        action: { type: 'toggle-expanded', entryId },
      });
    },
    onSelect: (entryId: string | null) => {
      if (!session) return;
      dispatchData({
        type: 'session',
        projectId: session.project.id,
        action: { type: 'select', entryId },
      });
    },
    onSetClipboard: handleSetClipboard,
    onOpenFile: (entry: FileTreeEntry) => {
      void handleOpenFile(entry);
    },
    onCreateEntry: handleCreateEntry,
    onRenameEntry: handleRenameEntry,
    onDeleteEntry: handleDeleteEntry,
    onPasteEntry: handlePasteEntry,
    onCopyPath: (path: string) => {
      void handleCopyPath(path);
    },
    onReveal: (path: string, isDirectory: boolean) => {
      void handleRevealPath(path, isDirectory);
    },
    onAddToChat:
      chatAvailable &&
      chatConversation?.loadStatus === 'ready'
        ? handleAddTreeToChat
        : undefined,
    onNotice: showNotice,
  };

  const tabActions = {
    onActivateTab: handleActivateTab,
    onCloseTab: handleCloseTab,
    onChangeDocument: handleChangeDocument,
    onSaveAs: (
      projectId: string,
      identity: string,
      instanceId: string,
    ) => {
      const document = dataRef.current.sessions[projectId]?.tabs.find(
        (item) =>
          item.identity === identity && item.instanceId === instanceId,
      );
      if (!document) return;
      setSaveAsTarget({
        projectId,
        identity,
        instanceId,
        name: document.name,
        busy: false,
        error: '',
      });
    },
  };

  const viewerActions = {
    onTextViewChange: handleTextViewChange,
    onMarkdownModeChange: handleMarkdownModeChange,
    onPreviewScroll: handlePreviewScroll,
    onImageViewChange: handleImageViewChange,
    onCsvViewChange: handleCsvViewChange,
    onH5ViewChange: handleH5ViewChange,
    onRefreshHtml: handleRefreshHtml,
    onCopyValue: handleCopyViewerValue,
  };

  manualSaveRef.current = () => {
    void handleManualSave();
  };

  let leaveTargetName = '';
  if (leave?.intent.kind === 'open') {
    leaveTargetName = leave.intent.target.name;
  }

  const leavePurpose: LeavePurpose = leave?.intent.kind ?? 'close';
  const leaveDirectoryMissing =
    leave?.directoryStatus === 'ready' &&
    leave.directory?.directoryState === 'missing';
  const leaveDirectoryPath =
    leave?.directory?.path ?? session?.project.path ?? '';
  const leaveDirectoryMessage =
    leave?.directoryStatus === 'error'
      ? leave.directoryError
      : leave?.directory?.directoryState === 'unreadable'
        ? leave.directory.message ?? '项目目录暂时无法读取，请稍后重试。'
        : '';
  const workspaceSession = session;
  const visibleChatProject =
    chatProject ?? createChatProjectState();
  const chatConnection =
    !chatAvailable
      ? ('disconnected' as const)
      : data.chat.contextStatus === 'error'
        ? ('error' as const)
        : chatContext?.connection ??
          (data.chat.contextStatus === 'loading' ||
          data.chat.contextStatus === 'idle'
            ? ('connecting' as const)
            : ('disconnected' as const));
  const settingsConnection: ChatConnectionState | null =
    settingsRuntime &&
    (settingsRuntime.cli.state === 'connected' ||
      settingsRuntime.cli.state === 'connecting' ||
      settingsRuntime.cli.state === 'error' ||
      settingsRuntime.cli.state === 'not-configured')
      ? settingsRuntime.cli.state === 'connected'
        ? 'connected'
        : settingsRuntime.cli.state === 'connecting'
          ? 'connecting'
          : settingsRuntime.cli.state === 'error'
            ? 'error'
            : 'disconnected'
      : null;
  const statusConnection = settingsConnection ?? chatConnection;
  const statusConnectionMessage =
    settingsRuntime?.cli.message ||
    (settingsRuntime?.cli.version
      ? `Codex CLI ${settingsRuntime.cli.version}`
      : undefined) ||
    (settingsConnection ? undefined : chatContext?.connectionMessage) ||
    data.chat.contextError ||
    undefined;
  const chatPanelProps: ChatPanelProps = {
    available: chatAvailable,
    projectId: workspaceSession?.project.id ?? '',
    toolboxName: workspaceSession?.project.toolboxId ?? null,
    pendingApprovals: chatConversation?.approvals ?? [],
    chat: visibleChatProject,
    context: chatContext,
    contextStatus: data.chat.contextStatus,
    contextError: data.chat.contextError,
    onNewConversation: () => {
      void handleNewChatConversation();
    },
    onSelectConversation: handleSelectChatConversation,
    onRetryList: () => {
      const projectId = currentChatProjectId();
      if (projectId) void ensureChatList(projectId);
    },
    onRetryConversation: (conversationId) => {
      const projectId = currentChatProjectId();
      if (projectId) {
        chatConversationRequestsRef.current.delete(
          `${projectId}\u0000${conversationId}`,
        );
        void ensureChatConversation(projectId, conversationId);
      }
    },
    onDraftChange: handleChatDraftChange,
    onReferencesChange: handleChatReferencesChange,
    onSettingsChange: handleChatSettingsChange,
    onSwitchService: (serviceId, modelId) => {
      void handleChatServiceSwitch(serviceId, modelId);
    },
    onUiChange: handleChatUiChange,
    onAddAttachment: (kind) => {
      void handleAddChatAttachment(kind);
    },
    onSend: () => {
      void requestChatSend();
    },
    onStop: () => {
      void requestChatStop();
    },
    onChooseToolbox: openToolboxPicker,
    onOpenApprovals: openApprovals,
    onOpenProjectFile: (projectId, href) => {
      void handleOpenChatProjectFile(projectId, href);
    },
    onCopyText: (text) => {
      if (!capabilities) return;
      void safely(
        () => capabilities.copyText(text),
        '复制回复失败。',
      ).then((result) => {
        if (!mountedRef.current) return;
        if (result.status === 'success') {
          showNotice('已复制', 'success');
        } else {
          showNotice(
            result.status === 'error'
              ? result.message
              : '复制已取消。',
            'error',
          );
        }
      });
    },
  };

  return (
    <div
      className="app-shell"
      data-view={workspaceSession ? 'workspace' : 'welcome'}
    >
      <AppHeader
        showPanelToggles={Boolean(workspaceSession)}
        leftVisible={layout.leftVisible}
        rightVisible={layout.rightVisible}
        canCreateProject={actionsAvailable}
        canOpenProject={actionsAvailable}
        canCloseProject={Boolean(workspaceSession)}
        projectActionsDisabled={projectActionsDisabled}
        settingsAvailable={settingsAvailable}
        settingsDisabled={
          projectFormOpen || leave !== null || tabClose !== null
        }
        settingsExpanded={settingsOpen}
        onTogglePanel={handleTogglePanel}
        onNewProject={openNewProjectForm}
        onOpenProject={() => {
          void handleOpenProject();
        }}
        onCloseProject={handleCloseProject}
        onOpenSettings={openSettings}
      />

      {workspaceSession ? (
        <WorkspaceView
          key={workspaceSession.project.id}
          layout={layout}
          dispatch={dispatchLayout}
          session={workspaceSession}
          treeActions={treeActions}
          tabActions={tabActions}
          viewerActions={viewerActions}
          renderDocument={renderDocument}
          readBinaryResource={readBinaryResource}
          listH5Datasets={listH5Datasets}
          readH5DatasetRange={readH5DatasetRange}
          chatPanel={chatPanelProps}
          backgroundNotice={backgroundNotice}
          noticeBlocked={modalOpen}
          onViewBackgroundNotice={handleViewBackgroundNotice}
        />
      ) : (
        <WelcomeView
          recentProjects={data.recentProjects}
          actionsAvailable={actionsAvailable}
          busy={projectBusy}
          error={recentError}
          onNewProject={openNewProjectForm}
          onOpenProject={() => {
            void handleOpenProject();
          }}
          onOpenRecentProject={(project) => {
            void handleOpenRecent(project);
          }}
        />
      )}

      <HtmlViewerHost
        sessions={data.sessions}
        currentProjectId={data.currentProjectId}
      />

      <StatusBar
        project={workspaceSession?.project ?? null}
        connection={statusConnection}
        connectionMessage={statusConnectionMessage}
        progress={workspaceSession?.project.toolboxId === WORKFLOW_TOOLBOX && capabilities
          ? {
              entry: findCaseDict(workspaceSession.tree),
              readFile: capabilities.readFile,
              saveRevision: workflowSaveRevision,
            }
          : undefined}
        onCopyProjectPath={
          workspaceSession && capabilities
            ? () => {
                void handleCopyProjectPath();
              }
            : undefined
        }
      />

      {settingsOpen && settingsCapabilities ? (
        <SettingsDialog
          loading={settingsLoading}
          loadError={settingsLoadError}
          snapshot={settingsSnapshot}
          runtime={settingsRuntime}
          capabilities={settingsCapabilities}
          returnFocusTarget={settingsReturnFocusRef.current}
          onRetryLoad={retrySettingsLoad}
          onClose={closeSettings}
          onSaved={handleSettingsSaved}
        />
      ) : null}

      <NewProjectDialog
        open={projectFormOpen}
        folder={form.folder}
        toolboxes={form.toolboxes}
        selectedToolboxId={form.selectedToolboxId}
        toolboxesLoading={form.toolboxesLoading}
        toolboxesError={form.toolboxesError}
        pickingFolder={form.pickingFolder}
        submitting={form.submitting}
        error={form.error}
        folderPath={form.folder?.path ?? ''}
        rebuildConfirmation={
          form.rebuildConfirmation
            ? {
                mode: form.rebuildConfirmation.mode,
                existingProjectIds:
                  form.rebuildConfirmation.existingProjectIds,
              }
            : null
        }
        onConfirmRebuild={() =>
          beginProjectCreation(
            form.recreateProjectId,
            form.recreateProjectIds,
            // A recreate confirmation only authorizes clearing old project
            // records. Directory contents require the explicit overwrite mode,
            // which is rechecked against the disk when submitted.
            form.rebuildConfirmation?.mode === 'overwrite',
          )
        }
        returnFocusTarget={formReturnFocusRef.current}
        onClose={closeNewProjectForm}
        onBrowse={() => {
          void pickFolderForNewProject();
        }}
        onToolboxChange={selectToolbox}
        onCreate={submitNewProjectForm}
      />

      {leave ? (
        <LeaveDialog
          open
          purpose={leavePurpose}
          projectName={session?.project.name ?? ''}
          targetName={leaveTargetName}
          unsavedDocuments={leaveUnsavedDocuments}
          tasks={leave.tasks}
          tasksStatus={leave.tasksStatus}
          tasksError={leave.tasksError}
          directoryMissing={leaveDirectoryMissing}
          directoryPath={leaveDirectoryPath}
          directoryMessage={leaveDirectoryMessage}
          busyKind={leave.busyKind}
          error={leave.error}
          progress={leave.progress}
          returnFocusTarget={leaveReturnFocusRef.current}
          onCancel={cancelLeave}
          onStopTasks={() => {
            void stopLeaveTasks();
          }}
          onSaveAndContinue={() => {
            void saveAndContinue();
          }}
          onDiscardAndContinue={discardAndContinue}
          onContinue={continueLeave}
        />
      ) : null}

      {tabClose && tabCloseDocument ? (
        <TabCloseDialog
          open
          document={tabCloseDocument}
          saving={tabClose.saving}
          error={tabClose.error}
          returnFocusTarget={tabCloseReturnFocusRef.current}
          onCancel={cancelTabClose}
          onDiscard={discardTabClose}
          onSave={() => {
            void saveTabClose();
          }}
        />
      ) : null}

      {approvalsOpen ? (
        <ChatApprovalDialog
          open
          conversationTitle={chatConversation?.summary.title ?? ''}
          approvals={chatConversation?.approvals ?? []}
          busy={approvalBusy}
          error={approvalError}
          onClose={() => {
            setApprovalsOpen(false);
            setApprovalError('');
          }}
          onRespond={(approvalId, decision) => {
            void respondToApproval(approvalId, decision);
          }}
        />
      ) : null}

      {toolboxPickerOpen ? (
        <ToolboxPickerDialog
          open
          loading={toolboxOptions === null && !toolboxPickerError}
          error={toolboxPickerError}
          toolboxes={toolboxOptions ?? []}
          busy={toolboxBinding}
          onClose={() => {
            if (toolboxBinding) return;
            setToolboxPickerOpen(false);
            setToolboxOptions(null);
            setToolboxPickerError('');
          }}
          onBind={(toolboxId) => {
            void bindToolbox(toolboxId);
          }}
        />
      ) : null}

      {saveConflict ? (
        <FileConflictDialog
          open
          fileName={saveConflict.fileName}
          message={
            saveConflict.currentVersion
              ? '文件已在磁盘上修改。'
              : '磁盘版本无法确认。'
          }
          busy={saveConflict.busy}
          error={saveConflict.error}
          onCancel={() => {
            if (saveConflict.busy) return;
            setSaveConflict(null);
          }}
          onReload={() => {
            void reloadConflictedDocument();
          }}
          onOverwrite={() => {
            void overwriteConflictedDocument();
          }}
        />
      ) : null}

      {saveAsTarget ? (
        <SaveAsDialog
          open
          originalName={saveAsTarget.name}
          busy={saveAsTarget.busy}
          error={saveAsTarget.error}
          onClose={() => {
            if (saveAsTarget.busy) return;
            setSaveAsTarget(null);
          }}
          onSave={(name) => {
            void saveMissingDocumentAs(name);
          }}
        />
      ) : null}

      {notice ? (
        <Notice
          message={notice.message}
          tone={notice.tone}
          actionLabel={notice.actionLabel}
          onAction={notice.onAction}
        />
      ) : null}
    </div>
  );
}


