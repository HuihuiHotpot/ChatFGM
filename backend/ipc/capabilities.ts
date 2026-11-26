export type ServiceResult<T> =
  | { status: 'success'; value: T }
  | { status: 'cancelled' }
  | {
      status: 'error';
      message: string;
      /** Stable backend error code when the caller needs to branch on it. */
      code?: string;
      existingProjectId?: string;
      existingProjectIds?: readonly string[];
      /** Present when a partial file-system operation produced a fresh tree. */
      treeResult?: TreeMutationResult;
      /** True when the operation changed some, but not all, intended paths. */
      partial?: boolean;
      /** Present for save conflicts: the version currently on disk. */
      currentVersion?: string;
    };

export interface FolderSelection {
  path: string;
  pathKey: string;
  name: string;
  /** Create-only warning for the selected path or its resolved target. */
  pathContainsHan?: boolean;
  /** True when the selected folder contains no entries (create only). */
  directoryEmpty?: boolean;
  /** Read-only hint; creation always rechecks current path ownership. */
  existingProjectId?: string;
  existingProjectIds?: readonly string[];
}

export type ProjectDirectoryState = 'available' | 'missing' | 'unreadable';

/** The registered project path as it exists right now. */
export interface ProjectAvailability {
  projectId: string;
  name: string;
  path: string;
  directoryState: ProjectDirectoryState;
  message?: string;
}

export interface ProjectAvailabilityInput {
  projectId: string;
}

export interface ToolboxOption {
  /** The toolbox folder name; it is both the stable type and the label. */
  id: string;
  label: string;
  /** Concrete reason this discovered folder is unusable, when it is. */
  error?: string;
}

export interface SettingsPathSelection {
  path: string;
  pathKey?: string;
  name?: string;
}

export interface SettingsCliConfig {
  path: string;
}

export type SettingsCliRuntimeState =
  | 'not-configured'
  | 'connecting'
  | 'connected'
  | 'error';

export interface SettingsCliRuntime {
  state: SettingsCliRuntimeState;
  /** The path to which the actual state belongs, when known. */
  path?: string;
  version?: string;
  message?: string;
}

export interface SettingsServiceConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** The secret itself is never sent to the renderer. */
  hasKey: boolean;
}

export type SettingsModelMode = 'chatgpt' | 'api';

export interface SettingsServicesConfig {
  mode: SettingsModelMode;
  activeServiceId: string | null;
  services: readonly SettingsServiceConfig[];
}

export interface SettingsToolboxEnvironmentConfig {
  toolboxId: string;
  environmentPath: string;
}

export interface SettingsToolboxesConfig {
  environments: readonly SettingsToolboxEnvironmentConfig[];
}

export interface SettingsSavedConfig {
  cli: SettingsCliConfig;
  models: SettingsServicesConfig;
  toolboxes: SettingsToolboxesConfig;
}

export type SettingsChatGptStatus =
  | 'logged-out'
  | 'authorizing'
  | 'logged-in';

export interface SettingsChatGptAccount {
  status: SettingsChatGptStatus;
  email?: string;
  /** Last authorization failure, if any. */
  message?: string;
}

export type SettingsEnvironmentState = 'ok' | 'error';

export interface SettingsToolboxRuntime {
  state: SettingsEnvironmentState;
  path?: string;
  message?: string;
}

export interface SettingsModelRuntime {
  state: 'inactive' | 'preparing' | 'ready' | 'error';
  serviceId?: string;
  modelId?: string;
  message?: string;
}

export interface SettingsRuntimeState {
  revision: number;
  cli: SettingsCliRuntime;
  chatgpt: SettingsChatGptAccount;
  /** Optional in older test adapters; present in the real backend. */
  models?: SettingsModelRuntime;
  toolboxEnvironments: Readonly<
    Record<string, SettingsToolboxRuntime>
  >;
}

export interface SettingsSnapshot {
  revision: number;
  saved: SettingsSavedConfig;
  runtime: SettingsRuntimeState;
}

export interface SettingsRuntimeUpdate {
  revision: number;
  runtime: SettingsRuntimeState;
}

export interface SettingsServiceInput {
  id: string;
  name: string;
  baseUrl: string;
  /** Only present when the user entered a replacement/new key. */
  key?: string;
}

export interface SaveSettingsInput {
  cli: SettingsCliConfig;
  models: {
    mode: SettingsModelMode;
    activeServiceId: string | null;
    services: readonly SettingsServiceInput[];
  };
  toolboxes: SettingsToolboxesConfig;
}

export interface TestSettingsServiceInput {
  service: SettingsServiceInput;
  /** True means the backend should use its saved key for this id. */
  keepSavedKey: boolean;
}

export interface SettingsCliDetection {
  version?: string;
  message?: string;
  runtime: SettingsCliRuntime;
}

export interface SettingsServiceConnectionTest {
  message?: string;
}

export interface SettingsToolboxEnvironmentDetection {
  message?: string;
  runtime: SettingsToolboxRuntime;
}

export interface SettingsCapabilityGroup {
  getSnapshot(): Promise<ServiceResult<SettingsSnapshot>>;
  saveSettings(
    input: SaveSettingsInput,
  ): Promise<ServiceResult<SettingsSnapshot>>;
  pickCliExecutable(): Promise<ServiceResult<SettingsPathSelection>>;
  pickToolboxEnvironment(input: {
    toolboxId: string;
  }): Promise<ServiceResult<SettingsPathSelection>>;
  detectCli(input: {
    path: string;
  }): Promise<ServiceResult<SettingsCliDetection>>;
  testServiceConnection(
    input: TestSettingsServiceInput,
  ): Promise<ServiceResult<SettingsServiceConnectionTest>>;
  startChatGptLogin(): Promise<
    ServiceResult<SettingsChatGptAccount>
  >;
  cancelChatGptLogin(): Promise<
    ServiceResult<SettingsChatGptAccount>
  >;
  logoutChatGpt(): Promise<ServiceResult<SettingsChatGptAccount>>;
  scanToolboxes(): Promise<ServiceResult<readonly ToolboxOption[]>>;
  detectToolboxEnvironment(input: {
    toolboxId: string;
    path: string;
  }): Promise<ServiceResult<SettingsToolboxEnvironmentDetection>>;
  /** Best-effort cancellation for non-authorization probes on close. */
  cancelPendingOperations?(): Promise<ServiceResult<null>>;
  subscribeUpdates(listener: (update: SettingsRuntimeUpdate) => void): () => void;
}

export type FileTreeEntryKind = 'file' | 'folder';

export interface FileTreeEntry {
  id: string;
  name: string;
  path: string;
  kind: FileTreeEntryKind;
  fileIdentity?: string;
  children?: readonly FileTreeEntry[];
}

export interface ProjectSnapshot {
  project: import('./project-types').ProjectInfo;
  tree: readonly FileTreeEntry[];
  replacedProjectIds?: readonly string[];
  cleanupWarning?: string;
}

/**
 * A disk change discovered while an Agent run modified the project. The
 * renderer applies the fresh tree to the already-open session; it never
 * re-opens the project or changes recency.
 */
export interface ProjectTreeUpdate {
  projectId: string;
  revision: number;
  tree: readonly FileTreeEntry[];
  /** Files whose on-disk version differs from the last known version. */
  changedFileIdentities: readonly string[];
  /** Files that disappeared (by identity). */
  deletedFileIdentities: readonly string[];
}

export type ProjectTreeUpdateListener = (update: ProjectTreeUpdate) => void;

export interface ProjectSyncFailure {
  projectId: string;
  message: string;
}

export type ProjectSyncFailureListener = (
  failure: ProjectSyncFailure,
) => void;

export interface FlushProjectSyncInput {
  projectId: string;
}

export interface BindProjectToolboxInput {
  projectId: string;
  toolboxId: string;
}

export interface FileChange {
  kind: 'renamed' | 'moved' | 'deleted';
  identity: string;
  name: string;
  path: string;
  previousPath: string;
}

export interface TreeMutationResult {
  tree: readonly FileTreeEntry[];
  changes: readonly FileChange[];
  targetEntryId?: string;
}

export interface CreateProjectInput {
  folder: FolderSelection;
  toolboxId: string;
  /** Explicit confirmation bound to the current old identity. */
  replaceProjectId?: string;
  /** Exact set explicitly confirmed, including legacy records for this path. */
  replaceProjectIds?: readonly string[];
  /**
   * Explicit user confirmation that the full contents of a non-empty target
   * directory will be removed before the selected template is published.
   */
  confirmOverwrite?: boolean;
}

export interface OpenProjectInput {
  path: string;
  pathKey: string;
}

export interface ReadFileInput {
  projectId: string;
  fileIdentity: string;
}

export interface ResolveProjectFileLinkInput {
  projectId: string;
  href: string;
}

export interface ReadBinaryResourceInput {
  projectId: string;
  fileIdentity: string;
  /**
   * A reference authored inside a text document, such as a Markdown image
   * URL. When present, the backend resolves it relative to the document and
   * validates that the resulting file stays inside the project. The frontend
   * never turns this value into a file:// URL.
   */
  relativePath?: string;
}

export interface BinaryResource {
  bytes: Uint8Array;
  mime: string;
}

export interface HtmlPreviewInput {
  projectId: string;
  fileIdentity: string;
}

export interface HtmlPreview {
  /** A backend-controlled preview URL; never a file:// URL. */
  url: string;
  /** Optional backend handle that can be released when the tab closes. */
  handle?: string;
}

export interface ReleaseHtmlPreviewInput {
  projectId: string;
  fileIdentity: string;
  handle: string;
}

export type H5DatasetKind = 'scalar' | 'array' | 'unsupported';

export interface H5Dataset {
  /** Full HDF5 path, for example "/results/temperature". */
  path: string;
  name: string;
  dtype: string;
  shape: readonly number[];
  kind: H5DatasetKind;
  supported: boolean;
  reason?: string;
}

export interface H5DatasetList {
  datasets: readonly H5Dataset[];
  fileInfo?: string;
}

export interface ListH5DatasetsInput {
  projectId: string;
  fileIdentity: string;
}

export interface ReadH5RangeInput {
  projectId: string;
  fileIdentity: string;
  datasetPath: string;
  /** Zero-based global start per dataset dimension. */
  start: readonly number[];
  /** Requested window size per dimension; the viewer keeps this bounded. */
  shape: readonly number[];
}

export type H5ValueKind =
  | 'number'
  | 'boolean'
  | 'string'
  | 'empty'
  | 'null';

/**
 * `raw` is the lossless textual original. `display` is only a presentation
 * hint; copy and the value bar always use raw.
 */
export interface H5CellValue {
  raw: string;
  display?: string;
  kind: H5ValueKind;
}

export interface H5DatasetRange {
  datasetPath: string;
  /** Actual global start; must cover the requested window. */
  start: readonly number[];
  /** Actual window shape; must cover the requested window. */
  shape: readonly number[];
  /** Row-major values for the actual start/shape window. */
  values: readonly (readonly (H5CellValue | null)[] | null)[];
}

export interface TreeEntryInput {
  projectId: string;
  parentId: string | null;
  kind: FileTreeEntryKind;
  name: string;
}

export interface RenameEntryInput {
  projectId: string;
  entryId: string;
  name: string;
}

export interface DeleteEntryInput {
  projectId: string;
  entryId: string;
}

export interface PasteEntryInput {
  projectId: string;
  targetFolderId: string | null;
  sourceEntryId: string;
  mode: 'cut' | 'copy';
}

export interface ReadFileResult {
  content: string;
  /** Opaque token for the bytes read from disk. */
  version?: string;
  /** True when the original file starts with a BOM. */
  bom?: boolean;
  newline?: '\n' | '\r\n' | '\r';
  /** Encoding detected for this read; saves reuse it automatically. */
  encoding?: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';
}

export interface SaveFileResult {
  /** New opaque version token; absent only for legacy test adapters. */
  version?: string;
}

export interface SaveFileInput {
  projectId: string;
  fileIdentity: string;
  /** Consistency check only; the backend locates the file by identity. */
  path: string;
  content: string;
  /** Version observed by the last read/save. */
  expectedVersion?: string;
  /**
   * Explicit user confirmation to replace the version identified by
   * `expectedVersion`. The disk version is still re-checked; a second external
   * change is reported as a new conflict instead of being overwritten.
   */
  force?: boolean;
  bom?: boolean;
  newline?: '\n' | '\r\n' | '\r';
}

export interface SaveFileAsInput {
  projectId: string;
  /** Existing missing document whose content is being preserved. */
  fileIdentity?: string;
  /** New file name inside the project root. */
  name: string;
  content: string;
}

export interface SaveFileAsResult {
  tree: readonly FileTreeEntry[];
  fileIdentity: string;
  path: string;
  version: string;
}


export interface RevealPathInput {
  projectId: string;
  path: string;
  isDirectory: boolean;
}

export interface RunningTask {
  id: string;
  title: string;
  status?: string;
  /** Project that owns the task; present for chat runs. */
  projectId?: string;
  /** Optional linkage when the task is an Agent run. */
  conversationId?: string;
  runId?: string;
}

/* ── Step 5 chat capabilities ─────────────────────────────────────── */

export type ChatConnectionState =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'error';

export interface ChatEffortOption {
  id: string;
  label: string;
}

export interface ChatInputCapabilities {
  text: boolean;
  image: boolean;
  file: boolean;
  projectReference: boolean;
}

export interface ChatModel {
  serviceId: string;
  modelId: string;
  label: string;
  available: boolean;
  reason?: string;
  /** null means the model does not support an effort parameter. */
  efforts: readonly ChatEffortOption[] | null;
  defaultEffortId?: string | null;
  input: ChatInputCapabilities;
}

/** Model list and connection state for one configured service. */
export interface ChatServiceContext {
  serviceId: string;
  serviceName: string;
  connection: ChatConnectionState;
  connectionMessage?: string;
  models: readonly ChatModel[];
  defaultModelId?: string | null;
}

export interface ChatPermissionOption {
  id: string;
  label: string;
  description?: string;
  available: boolean;
  reason?: string;
}

export interface ChatCapabilityContext {
  serviceId: string;
  serviceName: string;
  connection: ChatConnectionState;
  connectionMessage?: string;
  models: readonly ChatModel[];
  defaultModelId?: string | null;
  /**
   * Every configured service with its own connection/model state. A failure or
   * logged-out state of one service never hides another service's models.
   * Optional for compatibility with older capability adapters.
   */
  services?: readonly ChatServiceContext[];
  permissions: readonly ChatPermissionOption[];
  defaultPermissionId?: string | null;
  /**
   * Monotonic identity of the context read that produced this snapshot. A
   * response/event with a lower id is stale and must not replace a newer one.
   */
  contextRequestId?: number;
}

export interface ChatConversationSettings {
  modelId: string;
  modelLabel?: string;
  effortId: string | null;
  effortLabel?: string;
  permissionId: string;
  permissionLabel?: string;
}

export interface ChatRunSettings {
  serviceId: string;
  serviceName?: string;
  modelId: string;
  modelLabel?: string;
  effortId: string | null;
  effortLabel?: string;
  permissionId: string;
  permissionLabel?: string;
}

export type ChatReferenceKind = 'file' | 'folder' | 'attachment';

export interface ChatReferencePreview {
  url: string;
  /** Opaque temporary resource handle, released when unused. */
  token?: string;
}

export interface ChatReference {
  /** Stable opaque reference identity. */
  id: string;
  kind: ChatReferenceKind;
  name: string;
  displayPath: string;
  fileIdentity?: string;
  directoryId?: string;
  attachmentId?: string;
  mime?: string;
  invalid?: boolean;
  preview?: ChatReferencePreview;
}

export type ChatMessageFormat = 'text' | 'markdown';
export type ChatMessageRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatMessageRole;
  text: string;
  format: ChatMessageFormat;
  order: number;
  createdAt: number;
  revision: number;
  references?: readonly ChatReference[];
  runId?: string;
}

export type ChatRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'unknown';

export type ChatToolStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'unknown';

export interface ChatToolCall {
  id: string;
  name: string;
  summary?: string;
  detail?: string;
  status: ChatToolStatus;
  /** Real process exit code when the CLI reports one. */
  exitCode?: number;
}

export type ChatStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface ChatStep {
  id: string;
  title: string;
  status: ChatStepStatus;
  detail?: string;
}

export interface ChatRun {
  id: string;
  conversationId: string;
  submissionId: string;
  status: ChatRunStatus;
  revision: number;
  settings: ChatRunSettings;
  startedAt?: number;
  finishedAt?: number;
  /** Explicit background-task marker supplied by the run layer. */
  task?: boolean;
  summary?: string;
  tools?: readonly ChatToolCall[];
  /** null/absent means no structured plan was supplied. */
  steps?: readonly ChatStep[] | null;
  /** Actual execution facts recorded by the run layer. */
  execution?: ChatRunExecution;
}

/**
 * Facts about the environment an accepted run actually used. These are read
 * from the backend, never inferred by the renderer.
 */
export interface ChatRunExecution {
  toolboxName?: string;
  cwd?: string;
  environmentPath?: string;
  interpreterPath?: string;
  interpreterVersion?: string;
  sandbox?: string;
}

export type ChatApprovalKind = 'command' | 'file-change' | 'permissions';

export type ChatApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled';

export interface ChatApprovalNetworkTarget {
  host: string;
  protocol?: string;
}

export interface ChatApprovalPermissions {
  readPaths: readonly string[];
  writePaths: readonly string[];
  denyPaths: readonly string[];
  network: boolean;
  networkTargets: readonly ChatApprovalNetworkTarget[];
  /** How long the requested grant applies. */
  scope: 'turn' | 'command';
}

/**
 * One approval request from the Codex runtime. The renderer receives an
 * opaque id plus display facts; it can only answer with a decision.
 */
export interface ChatApproval {
  id: string;
  projectId: string;
  conversationId: string;
  runId: string;
  turnId: string;
  itemId?: string;
  kind: ChatApprovalKind;
  title: string;
  command?: string;
  paths?: readonly string[];
  cwd?: string;
  reason?: string;
  permissions?: ChatApprovalPermissions;
  createdAt: number;
  status: ChatApprovalStatus;
  decidedAt?: number;
}

export interface RespondChatApprovalInput {
  projectId: string;
  conversationId: string;
  approvalId: string;
  decision: 'approve' | 'deny';
}

export interface ChatConversationUiState {
  scrollTop: number;
  followLatest: boolean;
  expandedRunIds: readonly string[];
}

export interface ChatConversationSummary {
  id: string;
  projectId: string;
  serviceId: string;
  serviceName?: string;
  title: string;
  updatedAt: number;
  revision: number;
  status: ChatRunStatus | 'idle';
  activeRunId?: string | null;
  messagePreview?: string;
  hasDraft?: boolean;
}

/** A submission whose turn may already have reached the service. */
export interface ChatPendingSubmission {
  submissionId: string;
  input: SendChatMessageInput;
  submittedDraft: string;
  submittedReferences: ChatReference[];
}

export type ChatHistoryStatus = 'ready' | 'unverified' | 'error';

export interface ChatConversationSnapshot
  extends ChatConversationSummary {
  settings: ChatConversationSettings;
  /** Version of the user-owned draft/references/settings/ui state. */
  stateRevision?: number;
  draft: string;
  references: readonly ChatReference[];
  messages: readonly ChatMessage[];
  runs: readonly ChatRun[];
  ui: ChatConversationUiState;
  /**
   * Present when the conversation was restored from a submission whose turn
   * may have been accepted. The renderer must reconcile before a new send.
   */
  pendingSubmission?: ChatPendingSubmission | null;
  historyStatus?: ChatHistoryStatus;
  /** Non-fatal history verification feedback for the existing message list. */
  historyWarning?: string;
  /** Approval requests for this conversation, including decided history. */
  approvals?: readonly ChatApproval[];
}

export interface ChatProjectChatState {
  projectId: string;
  activeConversationId: string | null;
  revision: number;
}

export interface GetChatProjectStateInput {
  projectId: string;
}

export interface SetActiveChatConversationInput {
  projectId: string;
  conversationId: string;
  expectedRevision: number;
}

export interface ChatContextInput {
  projectId?: string;
  /** Forces a fresh model discovery for every configured service. */
  refresh?: boolean;
}

export interface ListChatConversationsInput {
  projectId: string;
}

export interface LoadChatConversationInput {
  projectId: string;
  conversationId: string;
}

export interface CreateChatConversationInput {
  projectId: string;
  /** Target service. Defaults to the configured current service. */
  serviceId?: string;
  /** Initial model from that service. Defaults to the service's default. */
  modelId?: string;
}

export interface SaveChatConversationStateInput {
  projectId: string;
  conversationId: string;
  draft: string;
  references: readonly ChatReference[];
  settings: ChatConversationSettings;
  ui: ChatConversationUiState;
  /** Version observed at the time this save was prepared. */
  expectedStateRevision?: number;
}

export interface SaveChatConversationStateResult {
  stateRevision: number;
}

export type ChatAttachmentKind = 'file' | 'image' | 'screenshot';

export interface SelectChatAttachmentInput {
  projectId: string;
  conversationId: string;
  kind: ChatAttachmentKind;
}

export interface ChatAttachment {
  id: string;
  name: string;
  kind: ChatAttachmentKind;
  mime?: string;
  displayPath?: string;
  previewUrl?: string;
  /** Opaque temporary preview handle. */
  previewToken?: string;
}

export interface ReleaseChatAttachmentInput {
  projectId: string;
  token: string;
}

export interface SendChatMessageInput {
  projectId: string;
  conversationId: string;
  submissionId: string;
  text: string;
  references: readonly ChatReference[];
  settings: ChatConversationSettings;
  /** Frozen from the settings above when the submission is accepted. */
  serviceId: string;
  serviceName?: string;
}

export interface ChatSendReceipt {
  submissionId: string;
  /** User-state revision after the submitted draft was conditionally cleared. */
  stateRevision?: number;
  userMessage: ChatMessage;
  run: ChatRun;
  summary?: ChatConversationSummary;
}

/**
 * Whether the service can prove that a send request was not accepted.
 * A transport failure or a missing acknowledgement must be reported as
 * `unknown`; callers must reconcile before submitting a new request.
 */
export type ChatSendAcceptance = 'not-sent' | 'unknown';

/**
 * Structured send result. Errors without `acceptance` are treated as
 * explicitly not sent for compatibility with existing capabilities.
 */
export type ChatSendResult =
  | { status: 'success'; value: ChatSendReceipt }
  | { status: 'cancelled' }
  | {
      status: 'error';
      message: string;
      acceptance?: ChatSendAcceptance;
    };

export interface StopChatRunInput {
  projectId: string;
  conversationId: string;
  runId: string;
}

export type ChatUpdate =
  | { type: 'context'; context: ChatCapabilityContext }
  | {
      type: 'conversation';
      projectId: string;
      summary: ChatConversationSummary;
    }
  | {
      type: 'snapshot';
      projectId: string;
      snapshot: ChatConversationSnapshot;
    }
  | {
      type: 'message';
      projectId: string;
      conversationId: string;
      message: ChatMessage;
    }
  | {
      type: 'run';
      projectId: string;
      conversationId: string;
      run: ChatRun;
    }
  | {
      type: 'approvals';
      projectId: string;
      conversationId: string;
      approvals: readonly ChatApproval[];
    };

export type ChatUpdateListener = (update: ChatUpdate) => void;

export interface ChatCapabilityGroup {
  getContext(
    input?: ChatContextInput,
  ): Promise<ServiceResult<ChatCapabilityContext>>;
  listConversations(
    input: ListChatConversationsInput,
  ): Promise<ServiceResult<readonly ChatConversationSummary[]>>;
  loadConversation(
    input: LoadChatConversationInput,
  ): Promise<ServiceResult<ChatConversationSnapshot>>;
  createConversation(
    input: CreateChatConversationInput,
  ): Promise<ServiceResult<ChatConversationSnapshot>>;
  saveConversationState(
    input: SaveChatConversationStateInput,
  ): Promise<ServiceResult<SaveChatConversationStateResult>>;
  getProjectState?(
    input: GetChatProjectStateInput,
  ): Promise<ServiceResult<ChatProjectChatState>>;
  setActiveConversation?(
    input: SetActiveChatConversationInput,
  ): Promise<ServiceResult<ChatProjectChatState>>;
  selectAttachment(
    input: SelectChatAttachmentInput,
  ): Promise<ServiceResult<ChatAttachment>>;
  releaseAttachmentPreview?(
    input: ReleaseChatAttachmentInput,
  ): Promise<ServiceResult<null>>;
  sendMessage(input: SendChatMessageInput): Promise<ChatSendResult>;
  stopRun(input: StopChatRunInput): Promise<ServiceResult<null>>;
  /** Answers one pending approval; only an opaque approval id is accepted. */
  respondApproval?(
    input: RespondChatApprovalInput,
  ): Promise<ServiceResult<null>>;
  subscribeUpdates(listener: ChatUpdateListener): () => void;
}

/**
 * Minimal seam between the verified frontend flow and a future desktop
 * backend. The current browser build deliberately has no implementation.
 */
export interface ChatFgmCapabilities {
  loadRecentProjects(): Promise<ServiceResult<import('./project-types').RecentProject[]>>;
  listToolboxes(): Promise<ServiceResult<ToolboxOption[]>>;
  pickProjectFolder(
    purpose: 'create' | 'open',
  ): Promise<ServiceResult<FolderSelection>>;
  createProject(
    input: CreateProjectInput,
  ): Promise<ServiceResult<ProjectSnapshot>>;
  openProject(input: OpenProjectInput): Promise<ServiceResult<ProjectSnapshot>>;
  /**
   * Current state of the registered project directory. Task and close flows
   * use it to distinguish a removed directory from a temporarily unreadable
   * one without depending on a path error.
   */
  getProjectAvailability?(
    input: ProjectAvailabilityInput,
  ): Promise<ServiceResult<ProjectAvailability>>;
  readFile(input: ReadFileInput): Promise<ServiceResult<ReadFileResult>>;
  resolveProjectFileLink?(
    input: ResolveProjectFileLinkInput,
  ): Promise<ServiceResult<FileTreeEntry>>;
  /** Optional until Step 3 image/resource viewers are connected. */
  readBinaryResource?(
    input: ReadBinaryResourceInput,
  ): Promise<ServiceResult<BinaryResource>>;
  /** Optional until Step 3 HTML resource serving is connected. */
  getHtmlPreviewUrl?(
    input: HtmlPreviewInput,
  ): Promise<ServiceResult<HtmlPreview>>;
  releaseHtmlPreview?(
    input: ReleaseHtmlPreviewInput,
  ): Promise<ServiceResult<null>>;
  /** Optional until the Step 3 H5 backend is connected. */
  listH5Datasets?(
    input: ListH5DatasetsInput,
  ): Promise<ServiceResult<H5DatasetList>>;
  readH5DatasetRange?(
    input: ReadH5RangeInput,
  ): Promise<ServiceResult<H5DatasetRange>>;
  createEntry(
    input: TreeEntryInput,
  ): Promise<ServiceResult<TreeMutationResult>>;
  renameEntry(
    input: RenameEntryInput,
  ): Promise<ServiceResult<TreeMutationResult>>;
  deleteEntry(
    input: DeleteEntryInput,
  ): Promise<ServiceResult<TreeMutationResult>>;
  pasteEntry(
    input: PasteEntryInput,
  ): Promise<ServiceResult<TreeMutationResult>>;
  copyText(text: string): Promise<ServiceResult<null>>;
  revealPath(input: RevealPathInput): Promise<ServiceResult<null>>;
  saveFile(input: SaveFileInput): Promise<ServiceResult<SaveFileResult>>;
  /** Preserves a missing/dirty document under a new project-relative name. */
  saveFileAs?(
    input: SaveFileAsInput,
  ): Promise<ServiceResult<SaveFileAsResult>>;
  /** Binds an unbound project to a discovered toolbox; no template files. */
  bindProjectToolbox?(
    input: BindProjectToolboxInput,
  ): Promise<ServiceResult<ProjectSnapshot>>;
  /** Backend-pushed project tree changes caused by Agent tool execution. */
  subscribeProjectUpdates?(
    listener: ProjectTreeUpdateListener,
  ): () => void;
  /** Waits for the final coalesced disk scan; rejects on scan failure. */
  flushProjectSync?(
    input: FlushProjectSyncInput,
  ): Promise<ServiceResult<null>>;
  /** Background scan failures that need a visible retry entry. */
  subscribeProjectSyncFailures?(
    listener: ProjectSyncFailureListener,
  ): () => void;
  listRunningTasks(
    projectId: string,
  ): Promise<ServiceResult<RunningTask[]>>;
  stopTask(input: {
    projectId: string;
    taskId: string;
    conversationId?: string;
    runId?: string;
  }): Promise<ServiceResult<null>>;
  /** Optional Step 5 chat group; absent means the feature is unavailable. */
  chat?: ChatCapabilityGroup;
  /** Optional Step 4 workspace/layout persistence. */
  workspace?: import('./workspace').WorkspaceCapabilityGroup;
  /** Optional Step 6 global dependency settings. */
  settings?: SettingsCapabilityGroup;
}
