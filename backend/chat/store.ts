import { randomUUID } from 'node:crypto';
import type {
  ChatApproval,
  ChatApprovalKind,
  ChatApprovalPermissions,
  ChatApprovalStatus,
  ChatConversationSettings,
  ChatConversationSnapshot,
  ChatConversationSummary,
  ChatConversationUiState,
  ChatMessage,
  ChatMessageFormat,
  ChatMessageRole,
  ChatPendingSubmission,
  ChatProjectChatState,
  ChatReference,
  ChatRun,
  ChatRunExecution,
  ChatRunSettings,
  ChatRunStatus,
  ChatStep,
  ChatToolCall,
  SendChatMessageInput,
} from '../ipc/capabilities';
import type { ApplicationDatabase } from '../storage/database';

export class ChatStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChatStoreError';
    this.code = code;
  }
}

export type ChatSubmissionStage =
  | 'prepared'
  | 'sending'
  | 'accepted'
  | 'finished'
  | 'unknown'
  | 'not-sent'
  | 'rejected';

export interface ChatConversationRecord {
  id: string;
  projectId: string;
  serviceId: string;
  serviceName: string | null;
  threadId: string | null;
  accountIdentityHash: string | null;
  title: string;
  settings: ChatConversationSettings;
  draft: string;
  references: ChatReference[];
  ui: ChatConversationUiState;
  stateRevision: number;
  summaryRevision: number;
  historyStatus: 'unverified' | 'ready' | 'error';
  historyError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  projectId: string;
  role: ChatMessageRole;
  text: string;
  format: ChatMessageFormat;
  order: number;
  createdAt: number;
  revision: number;
  references: ChatReference[];
  runId: string | null;
  turnId: string | null;
  itemId: string | null;
  submissionId: string | null;
}

export interface ChatRunRecord {
  id: string;
  conversationId: string;
  projectId: string;
  submissionId: string | null;
  turnId: string | null;
  status: ChatRunStatus;
  revision: number;
  settings: ChatRunSettings;
  startedAt: number | null;
  finishedAt: number | null;
  summary: string | null;
  tools: ChatToolCall[];
  steps: ChatStep[] | null;
  lastError: string | null;
  runtimeInstanceId: string | null;
  execution: ChatRunExecution | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatApprovalRecord {
  id: string;
  projectId: string;
  conversationId: string;
  runId: string;
  turnId: string;
  threadId: string | null;
  itemId: string | null;
  method: string;
  kind: ChatApprovalKind;
  requestKey: string | null;
  /** Display facts only; never a renderer-supplied command or path. */
  payload: {
    title: string;
    command?: string;
    paths?: string[];
    cwd?: string;
    reason?: string;
    availableDecisions?: unknown;
    /** Normalized display facts; the raw grant is kept separately. */
    permissionDisplay?: ChatApprovalPermissions;
    /** Exact profile echoed when the user approves a permissions request. */
    grant?: unknown;
    /** Legacy pre-fix shape retained for already stored rows. */
    permissions?: unknown;
  };
  status: ChatApprovalStatus;
  runtimeInstanceId: string | null;
  connectionGeneration: number | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface ChatSubmissionRecord {
  projectId: string;
  conversationId: string;
  submissionId: string;
  stage: ChatSubmissionStage;
  input: SendChatMessageInput;
  /** Frozen user-visible text plus extracted attachment/reference material. */
  composedText: string;
  imagePaths: string[];
  digest: string;
  threadId: string | null;
  turnId: string | null;
  userMessageId: string | null;
  runId: string | null;
  receipt: unknown;
  verification: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatAttachmentRecord {
  id: string;
  projectId: string;
  conversationId: string;
  originalName: string;
  kind: 'file' | 'image' | 'screenshot';
  mime: string;
  byteSize: number;
  sha256: string;
  storageName: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

interface ConversationRow {
  id: string;
  project_id: string;
  service_id: string;
  service_name: string | null;
  thread_id: string | null;
  account_identity_hash: string | null;
  title: string;
  model_id: string;
  model_label: string | null;
  effort_id: string | null;
  effort_label: string | null;
  permission_id: string;
  permission_label: string | null;
  draft: string;
  references_json: string;
  ui_json: string;
  summary_revision: number;
  state_revision: number;
  history_status: 'unverified' | 'ready' | 'error';
  history_error: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  project_id: string;
  role: ChatMessageRole;
  text: string;
  format: ChatMessageFormat;
  order_index: number;
  created_at: number;
  revision: number;
  references_json: string;
  run_id: string | null;
  turn_id: string | null;
  item_id: string | null;
  submission_id: string | null;
}

interface RunRow {
  id: string;
  conversation_id: string;
  project_id: string;
  submission_id: string | null;
  turn_id: string | null;
  status: ChatRunStatus;
  revision: number;
  settings_json: string;
  started_at: number | null;
  finished_at: number | null;
  summary: string | null;
  tools_json: string | null;
  steps_json: string | null;
  last_error: string | null;
  runtime_instance_id: string | null;
  toolbox_name: string | null;
  execution_cwd: string | null;
  environment_path: string | null;
  interpreter_path: string | null;
  interpreter_version: string | null;
  sandbox: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  project_id: string;
  conversation_id: string;
  run_id: string;
  turn_id: string;
  thread_id: string | null;
  item_id: string | null;
  method: string;
  kind: ChatApprovalKind;
  request_key: string | null;
  payload_json: string;
  status: ChatApprovalStatus;
  runtime_instance_id: string | null;
  connection_generation: number | null;
  created_at: number;
  decided_at: number | null;
}

interface SubmissionRow {
  project_id: string;
  conversation_id: string;
  submission_id: string;
  stage: ChatSubmissionStage;
  input_json: string;
  digest: string;
  thread_id: string | null;
  turn_id: string | null;
  user_message_id: string | null;
  run_id: string | null;
  receipt_json: string | null;
  verification: string | null;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  project_id: string;
  conversation_id: string;
  original_name: string;
  kind: 'file' | 'image' | 'screenshot';
  mime: string;
  byte_size: number;
  sha256: string;
  storage_name: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

const MAX_JSON_CHARS = 8 * 1024 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(
  value: string,
  label: string,
): T {
  if (value.length > MAX_JSON_CHARS) {
    throw new ChatStoreError(
      'chat-corrupt',
      `${label}超过本地记录大小限制，已保留原数据。`,
    );
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new ChatStoreError(
      'chat-corrupt',
      `${label}不是有效的本地记录，已保留原数据。`,
      { cause: error },
    );
  }
}

function parseSettings(
  modelId: string,
  modelLabel: string | null,
  effortId: string | null,
  effortLabel: string | null,
  permissionId: string,
  permissionLabel: string | null,
): ChatConversationSettings {
  return {
    modelId,
    ...(modelLabel ? { modelLabel } : {}),
    effortId,
    ...(effortLabel ? { effortLabel } : {}),
    permissionId,
    ...(permissionLabel ? { permissionLabel } : {}),
  };
}

function conversationFromRow(row: ConversationRow): ChatConversationRecord {
  if (
    typeof row.summary_revision !== 'number' ||
    typeof row.state_revision !== 'number'
  ) {
    throw new ChatStoreError('chat-corrupt', '对话版本记录无效。');
  }
  return {
    id: row.id,
    projectId: row.project_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    threadId: row.thread_id,
    accountIdentityHash: row.account_identity_hash,
    title: row.title,
    settings: parseSettings(
      row.model_id,
      row.model_label,
      row.effort_id,
      row.effort_label,
      row.permission_id,
      row.permission_label,
    ),
    draft: row.draft,
    references: parseJson<ChatReference[]>(
      row.references_json,
      '对话引用',
    ),
    ui: parseJson<ChatConversationUiState>(row.ui_json, '对话界面状态'),
    stateRevision: row.state_revision,
    summaryRevision: row.summary_revision,
    historyStatus: row.history_status,
    historyError: row.history_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromRow(row: MessageRow): ChatMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    role: row.role,
    text: row.text,
    format: row.format,
    order: row.order_index,
    createdAt: row.created_at,
    revision: row.revision,
    references: parseJson<ChatReference[]>(
      row.references_json,
      '消息引用',
    ),
    runId: row.run_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    submissionId: row.submission_id,
  };
}

function runFromRow(row: RunRow): ChatRunRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    submissionId: row.submission_id,
    turnId: row.turn_id,
    status: row.status,
    revision: row.revision,
    settings: parseJson<ChatRunSettings>(
      row.settings_json,
      '运行设置',
    ),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary,
    tools: row.tools_json
      ? parseJson<ChatToolCall[]>(row.tools_json, '运行工具记录')
      : [],
    steps: row.steps_json
      ? parseJson<ChatStep[]>(row.steps_json, '运行步骤记录')
      : null,
    lastError: row.last_error,
    runtimeInstanceId: row.runtime_instance_id,
    execution: runExecutionFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runExecutionFromRow(row: RunRow): ChatRunExecution | null {
  const execution: ChatRunExecution = {
    ...(row.toolbox_name ? { toolboxName: row.toolbox_name } : {}),
    ...(row.execution_cwd ? { cwd: row.execution_cwd } : {}),
    ...(row.environment_path ? { environmentPath: row.environment_path } : {}),
    ...(row.interpreter_path ? { interpreterPath: row.interpreter_path } : {}),
    ...(row.interpreter_version
      ? { interpreterVersion: row.interpreter_version }
      : {}),
    ...(row.sandbox ? { sandbox: row.sandbox } : {}),
  };
  return Object.keys(execution).length > 0 ? execution : null;
}

function approvalFromRow(row: ApprovalRow): ChatApprovalRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    threadId: row.thread_id,
    itemId: row.item_id,
    method: row.method,
    kind: row.kind,
    requestKey: row.request_key,
    payload: parseJson<ChatApprovalRecord['payload']>(
      row.payload_json,
      '审批内容',
    ),
    status: row.status,
    runtimeInstanceId: row.runtime_instance_id,
    connectionGeneration: row.connection_generation,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export function publicApprovalFromRecord(
  record: ChatApprovalRecord,
): ChatApproval {
  return {
    id: record.id,
    projectId: record.projectId,
    conversationId: record.conversationId,
    runId: record.runId,
    turnId: record.turnId,
    ...(record.itemId ? { itemId: record.itemId } : {}),
    kind: record.kind,
    title: record.payload.title,
    ...(record.payload.command ? { command: record.payload.command } : {}),
    ...(record.payload.paths?.length ? { paths: record.payload.paths } : {}),
    ...(record.payload.cwd ? { cwd: record.payload.cwd } : {}),
    ...(record.payload.reason ? { reason: record.payload.reason } : {}),
    ...(record.payload.permissionDisplay
      ? {
          permissions: {
            ...record.payload.permissionDisplay,
            readPaths: [...record.payload.permissionDisplay.readPaths],
            writePaths: [...record.payload.permissionDisplay.writePaths],
            denyPaths: [...record.payload.permissionDisplay.denyPaths],
            networkTargets: record.payload.permissionDisplay.networkTargets.map(
              (target) => ({ ...target }),
            ),
          },
        }
      : {}),
    createdAt: record.createdAt,
    status: record.status,
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
  };
}

function submissionFromRow(row: SubmissionRow): ChatSubmissionRecord {
  const parsed = parseJson<
    | {
        input?: SendChatMessageInput;
        composedText?: string;
        imagePaths?: string[];
      }
    | SendChatMessageInput
  >(row.input_json, '提交快照');
  const legacy =
    parsed && typeof parsed === 'object' && 'text' in parsed
      ? (parsed as SendChatMessageInput)
      : null;
  const input =
    legacy ??
    (parsed as { input?: SendChatMessageInput }).input;
  if (!input) {
    throw new ChatStoreError('chat-corrupt', '提交快照缺少输入记录。');
  }
  return {
    projectId: row.project_id,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    stage: row.stage,
    input,
    composedText: legacy
      ? input.text
      : ((parsed as { composedText?: string }).composedText ?? input.text),
    imagePaths: legacy
      ? []
      : ((parsed as { imagePaths?: string[] }).imagePaths ?? []),
    digest: row.digest,
    threadId: row.thread_id,
    turnId: row.turn_id,
    userMessageId: row.user_message_id,
    runId: row.run_id,
    receipt: row.receipt_json
      ? parseJson<unknown>(row.receipt_json, '提交回执')
      : null,
    verification: row.verification,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row: AttachmentRow): ChatAttachmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    originalName: row.original_name,
    kind: row.kind,
    mime: row.mime,
    byteSize: row.byte_size,
    sha256: row.sha256,
    storageName: row.storage_name,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

function runRoundOrder(
  run: ChatRunRecord,
  messages: readonly ChatMessageRecord[],
): number {
  let order = -1;
  for (const message of messages) {
    if (message.runId === run.id) {
      order = Math.max(order, message.order);
    }
  }
  return order;
}

/**
 * Orders different tasks in one conversation. A run's revision only describes
 * updates to that same run, so it must never decide which task is newer.
 * Start time is the primary business order; when it is equal, missing or
 * restored, the persisted conversation round order decides, with the run id
 * as the final deterministic tie-breaker (same rule as the renderer).
 */
export function compareRunRecency(
  left: ChatRunRecord,
  right: ChatRunRecord,
  messages: readonly ChatMessageRecord[],
): number {
  const startDifference =
    (left.startedAt ?? left.finishedAt ?? 0) -
    (right.startedAt ?? right.finishedAt ?? 0);
  if (startDifference !== 0) return startDifference;
  const orderDifference =
    runRoundOrder(left, messages) - runRoundOrder(right, messages);
  if (orderDifference !== 0) return orderDifference;
  return left.id.localeCompare(right.id);
}

function summaryFromRecord(
  record: ChatConversationRecord,
  messages: readonly ChatMessageRecord[],
  runs: readonly ChatRunRecord[],
): ChatConversationSummary {
  const latestRun = [...runs]
    .sort((left, right) => compareRunRecency(left, right, messages))
    .at(-1);
  const latestMessage = [...messages].sort(
    (left, right) =>
      left.order - right.order ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id),
  ).at(-1);
  const status = latestRun?.status ?? 'idle';
  return {
    id: record.id,
    projectId: record.projectId,
    serviceId: record.serviceId,
    ...(record.serviceName ? { serviceName: record.serviceName } : {}),
    title: record.title,
    updatedAt: Date.parse(record.updatedAt),
    revision: record.summaryRevision,
    status,
    activeRunId:
      latestRun?.status === 'running' ? latestRun.id : null,
    ...(latestMessage ? { messagePreview: latestMessage.text.slice(0, 160) } : {}),
    hasDraft: record.draft.trim().length > 0 || record.references.length > 0,
  };
}

function publicMessage(record: ChatMessageRecord): ChatMessage {
  return {
    id: record.id,
    conversationId: record.conversationId,
    role: record.role,
    text: record.text,
    format: record.format,
    order: record.order,
    createdAt: record.createdAt,
    revision: record.revision,
    ...(record.references.length ? { references: record.references } : {}),
    ...(record.runId ? { runId: record.runId } : {}),
  };
}

function publicRun(record: ChatRunRecord): ChatRun {
  return {
    id: record.id,
    conversationId: record.conversationId,
    submissionId: record.submissionId ?? record.id,
    status: record.status,
    revision: record.revision,
    settings: record.settings,
    ...(record.startedAt !== null ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt !== null ? { finishedAt: record.finishedAt } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.tools.length ? { tools: record.tools } : {}),
    ...(record.steps ? { steps: record.steps } : {}),
    ...(record.execution ? { execution: record.execution } : {}),
  };
}

export function referencesEqual(
  left: readonly ChatReference[],
  right: readonly ChatReference[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((reference, index) => {
    const other = right[index];
    return (
      reference.id === other.id &&
      reference.attachmentId === other.attachmentId &&
      reference.fileIdentity === other.fileIdentity &&
      reference.directoryId === other.directoryId
    );
  });
}

/**
 * Removes short-lived preview handles before records are written. Preview
 * URLs and tokens are re-issued after a restart and must never be persisted.
 */
export function stripReferencePreviews(
  references: readonly ChatReference[],
): ChatReference[] {
  return references.map((reference) => {
    const { preview: _preview, ...rest } = reference;
    void _preview;
    return rest;
  });
}

export class ChatStore {
  private readonly database: ApplicationDatabase;

  constructor(database: ApplicationDatabase) {
    this.database = database;
  }

  getProjectState(projectId: string): ChatProjectChatState {
    const row = this.database
      .prepare(
        'SELECT active_conversation_id, revision FROM project_chat_state WHERE project_id = ?',
      )
      .get(projectId) as
      | { active_conversation_id: string | null; revision: number }
      | undefined;
    if (!row) {
      return { projectId, activeConversationId: null, revision: 0 };
    }
    return {
      projectId,
      activeConversationId: row.active_conversation_id,
      revision: row.revision,
    };
  }

  setActiveConversation(
    projectId: string,
    conversationId: string,
    expectedRevision: number,
  ): ChatProjectChatState {
    const conversation = this.getConversation(projectId, conversationId);
    if (!conversation) {
      throw new ChatStoreError('chat-not-found', '对话不存在或不属于当前项目。');
    }
    return this.database.runInTransaction(() => {
      const current = this.getProjectState(projectId);
      if (current.revision !== expectedRevision) {
        throw new ChatStoreError(
          'chat-revision-conflict',
          '项目对话状态已更新，本次活动对话写入已拒绝。',
        );
      }
      const next = current.revision + 1;
      this.database
        .prepare(
          `INSERT INTO project_chat_state
             (project_id, active_conversation_id, revision, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             active_conversation_id = excluded.active_conversation_id,
             revision = excluded.revision,
             updated_at = excluded.updated_at`,
        )
        .run(projectId, conversationId, next, nowIso());
      return {
        projectId,
        activeConversationId: conversationId,
        revision: next,
      };
    });
  }

  createConversation(input: {
    projectId: string;
    serviceId: string;
    serviceName?: string;
    settings: ChatConversationSettings;
    title?: string;
  }): ChatConversationRecord {
    const id = randomUUID();
    const now = nowIso();
    const title = (input.title ?? '新对话').slice(0, 80);
    try {
      this.database
        .prepare(
          `INSERT INTO chat_conversations (
             id, project_id, service_id, service_name, thread_id,
             account_identity_hash, title, model_id, model_label, effort_id,
             effort_label, permission_id, permission_label, draft,
             references_json, ui_json, summary_revision, state_revision,
             history_status, history_error, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, '',
             '[]', ?, 0, 0, 'unverified', NULL, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.serviceId,
          input.serviceName ?? null,
          title,
          input.settings.modelId,
          input.settings.modelLabel ?? null,
          input.settings.effortId,
          input.settings.effortLabel ?? null,
          input.settings.permissionId,
          input.settings.permissionLabel ?? null,
          JSON.stringify({
            scrollTop: 0,
            followLatest: true,
            expandedRunIds: [],
          } satisfies ChatConversationUiState),
          now,
          now,
        );
    } catch (error) {
      throw new ChatStoreError(
        'chat-save-failed',
        `新建对话保存失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const created = this.getConversation(input.projectId, id);
    if (!created) {
      throw new ChatStoreError('chat-save-failed', '新建对话后无法读取本地记录。');
    }
    return created;
  }

  getConversation(
    projectId: string,
    conversationId: string,
  ): ChatConversationRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM chat_conversations
         WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, conversationId) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : null;
  }

  getConversationById(
    conversationId: string,
  ): ChatConversationRecord | null {
    const row = this.database
      .prepare('SELECT * FROM chat_conversations WHERE id = ?')
      .get(conversationId) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : null;
  }

  listConversations(projectId: string): ChatConversationRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_conversations
         WHERE project_id = ?
         ORDER BY updated_at DESC, id`,
      )
      .all(projectId) as unknown as ConversationRow[];
    return rows.map(conversationFromRow);
  }

  updateConversation(
    conversationId: string,
    patch: {
      title?: string;
      serviceName?: string | null;
      threadId?: string | null;
      accountIdentityHash?: string | null;
      settings?: ChatConversationSettings;
      historyStatus?: 'unverified' | 'ready' | 'error';
      historyError?: string | null;
      touch?: boolean;
    },
  ): ChatConversationRecord {
    const current = this.getConversationById(conversationId);
    if (!current) {
      throw new ChatStoreError('chat-not-found', '对话不存在。');
    }
    const settings = patch.settings ?? current.settings;
    const now = nowIso();
    const touch = patch.touch !== false;
    this.database
      .prepare(
        `UPDATE chat_conversations SET
           service_name = ?,
           thread_id = ?,
           account_identity_hash = ?,
           title = ?,
           model_id = ?,
           model_label = ?,
           effort_id = ?,
           effort_label = ?,
           permission_id = ?,
           permission_label = ?,
           history_status = ?,
           history_error = ?,
           summary_revision = summary_revision + ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.serviceName !== undefined
          ? patch.serviceName
          : current.serviceName,
        patch.threadId !== undefined ? patch.threadId : current.threadId,
        patch.accountIdentityHash !== undefined
          ? patch.accountIdentityHash
          : current.accountIdentityHash,
        patch.title !== undefined ? patch.title : current.title,
        settings.modelId,
        settings.modelLabel ?? null,
        settings.effortId,
        settings.effortLabel ?? null,
        settings.permissionId,
        settings.permissionLabel ?? null,
        patch.historyStatus ?? current.historyStatus,
        patch.historyError !== undefined
          ? patch.historyError
          : current.historyError,
        touch ? 1 : 0,
        touch ? now : current.updatedAt,
        conversationId,
      );
    const updated = this.getConversationById(conversationId);
    if (!updated) {
      throw new ChatStoreError('chat-save-failed', '更新对话后无法读取本地记录。');
    }
    return updated;
  }

  /**
   * Saves the independent user state (draft, references, next-turn settings,
   * reading position). Message/run revisions cannot conflict with this save.
   */
  saveConversationState(
    projectId: string,
    conversationId: string,
    state: {
      draft: string;
      references: readonly ChatReference[];
      settings: ChatConversationSettings;
      ui: ChatConversationUiState;
      expectedStateRevision?: number;
    },
  ): number {
    return this.database.runInTransaction(() => {
      const current = this.getConversation(projectId, conversationId);
      if (!current) {
        throw new ChatStoreError('chat-not-found', '对话不存在或不属于当前项目。');
      }
      if (
        state.expectedStateRevision !== undefined &&
        current.stateRevision !== state.expectedStateRevision
      ) {
        const sameState =
          current.draft === state.draft &&
          referencesEqual(current.references, state.references) &&
          JSON.stringify(current.settings) === JSON.stringify(state.settings) &&
          JSON.stringify(current.ui) === JSON.stringify(state.ui);
        if (sameState) {
          // The backend may have cleared the submitted draft or applied an
          // idempotent write first. Identical content is already persisted.
          return current.stateRevision;
        }
        throw new ChatStoreError(
          'chat-state-conflict',
          '草稿或设置已更新，本次保存未写入；本地内容已保留。',
        );
      }
      const next = current.stateRevision + 1;
      this.database
        .prepare(
          `UPDATE chat_conversations SET
             draft = ?, references_json = ?, model_id = ?, model_label = ?,
             effort_id = ?, effort_label = ?, permission_id = ?,
             permission_label = ?, ui_json = ?, state_revision = ?,
             updated_at = ?
           WHERE project_id = ? AND id = ?`,
        )
        .run(
          state.draft,
          JSON.stringify(stripReferencePreviews(state.references)),
          state.settings.modelId,
          state.settings.modelLabel ?? null,
          state.settings.effortId,
          state.settings.effortLabel ?? null,
          state.settings.permissionId,
          state.settings.permissionLabel ?? null,
          JSON.stringify(state.ui),
          next,
          nowIso(),
          projectId,
          conversationId,
        );
      return next;
    });
  }

  listMessages(conversationId: string): ChatMessageRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_messages
         WHERE conversation_id = ?
         ORDER BY order_index, created_at, id`,
      )
      .all(conversationId) as unknown as MessageRow[];
    return rows.map(messageFromRow);
  }

  getMessage(id: string): ChatMessageRecord | null {
    const row = this.database
      .prepare('SELECT * FROM chat_messages WHERE id = ?')
      .get(id) as MessageRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  nextMessageOrder(conversationId: string): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(order_index), -1) AS max_order FROM chat_messages WHERE conversation_id = ?',
      )
      .get(conversationId) as { max_order: number } | undefined;
    return (row?.max_order ?? -1) + 1;
  }

  /**
   * Inserts or replaces a message only when its revision does not go backwards.
   * Returns true when a row changed. The caller publishes only after this.
   */
  upsertMessage(
    record: ChatMessageRecord,
    touchConversation = true,
  ): boolean {
    return this.database.runInTransaction(() => {
      const existing = this.database
        .prepare(
          'SELECT revision FROM chat_messages WHERE id = ?',
        )
        .get(record.id) as { revision: number } | undefined;
      if (existing && record.revision < existing.revision) return false;
      if (existing && record.revision === existing.revision) return false;
      this.database
        .prepare(
          `INSERT INTO chat_messages (
             id, conversation_id, project_id, role, text, format,
             order_index, created_at, revision, references_json, run_id,
             turn_id, item_id, submission_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             text = excluded.text,
             format = excluded.format,
             order_index = excluded.order_index,
             revision = excluded.revision,
             references_json = excluded.references_json,
             run_id = excluded.run_id,
             turn_id = excluded.turn_id,
             item_id = excluded.item_id,
             submission_id = excluded.submission_id`,
        )
        .run(
          record.id,
          record.conversationId,
          record.projectId,
          record.role,
          record.text,
          record.format,
          record.order,
          record.createdAt,
          record.revision,
          JSON.stringify(stripReferencePreviews(record.references)),
          record.runId,
          record.turnId,
          record.itemId,
          record.submissionId,
        );
      if (touchConversation) this.touchConversation(record.conversationId);
      return true;
    });
  }

  getLatestMessage(conversationId: string): ChatMessageRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM chat_messages WHERE conversation_id = ?
         ORDER BY order_index DESC, created_at DESC, id DESC LIMIT 1`,
      )
      .get(conversationId) as MessageRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  listRuns(conversationId: string): ChatRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT r.* FROM chat_runs r
         LEFT JOIN (
           SELECT run_id, MAX(order_index) AS round_order
           FROM chat_messages
           WHERE conversation_id = ? AND run_id IS NOT NULL
           GROUP BY run_id
         ) m ON m.run_id = r.id
         WHERE r.conversation_id = ?
         ORDER BY COALESCE(r.started_at, r.finished_at, 0),
                  COALESCE(m.round_order, -1), r.id`,
      )
      .all(conversationId, conversationId) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  getLatestRun(conversationId: string): ChatRunRecord | null {
    const row = this.database
      .prepare(
        `SELECT r.* FROM chat_runs r
         LEFT JOIN (
           SELECT run_id, MAX(order_index) AS round_order
           FROM chat_messages
           WHERE conversation_id = ? AND run_id IS NOT NULL
           GROUP BY run_id
         ) m ON m.run_id = r.id
         WHERE r.conversation_id = ?
         ORDER BY COALESCE(r.started_at, r.finished_at, 0) DESC,
                  COALESCE(m.round_order, -1) DESC, r.id DESC
         LIMIT 1`,
      )
      .get(conversationId, conversationId) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  listRunsByProject(projectId: string): ChatRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_runs r WHERE r.project_id = ?
         ORDER BY COALESCE(r.started_at, r.finished_at, 0),
                  COALESCE((SELECT MAX(order_index) FROM chat_messages
                            WHERE run_id = r.id), -1), r.id`,
      )
      .all(projectId) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  listUnsettledRunsByProject(projectId: string): ChatRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_runs r
         WHERE r.project_id = ? AND r.status IN ('running', 'unknown')
         ORDER BY COALESCE(r.started_at, r.finished_at, 0),
                  COALESCE((SELECT MAX(order_index) FROM chat_messages
                            WHERE run_id = r.id), -1), r.id`,
      )
      .all(projectId) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  listAllUnsettledRuns(): ChatRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_runs r
         WHERE r.status IN ('running', 'unknown')
         ORDER BY COALESCE(r.started_at, r.finished_at, 0),
                  COALESCE((SELECT MAX(order_index) FROM chat_messages
                            WHERE run_id = r.id), -1), r.id`,
      )
      .all() as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  serviceIdForRun(runId: string): string | null {
    const row = this.database
      .prepare(
        `SELECT c.service_id AS service_id
         FROM chat_runs r JOIN chat_conversations c ON c.id = r.conversation_id
         WHERE r.id = ?`,
      )
      .get(runId) as { service_id: string } | undefined;
    return row?.service_id ?? null;
  }

  serviceIdForConversation(conversationId: string): string | null {
    const row = this.database
      .prepare('SELECT service_id FROM chat_conversations WHERE id = ?')
      .get(conversationId) as { service_id: string } | undefined;
    return row?.service_id ?? null;
  }

  listUnsettledSubmissions(): ChatSubmissionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_submissions
         WHERE stage IN ('sending', 'unknown', 'accepted')
         ORDER BY updated_at DESC`,
      )
      .all() as unknown as SubmissionRow[];
    return rows.map(submissionFromRow);
  }

  markRunningRunsUnknownForService(
    serviceId: string,
    message: string,
  ): ChatRunRecord[] {
    return this.database.runInTransaction(() => {
      const rows = this.database
        .prepare(
          `SELECT r.* FROM chat_runs r
           JOIN chat_conversations c ON c.id = r.conversation_id
           WHERE c.service_id = ? AND r.status = 'running'`,
        )
        .all(serviceId) as unknown as RunRow[];
      if (rows.length === 0) return [];
      const now = nowIso();
      const updated: ChatRunRecord[] = [];
      for (const row of rows) {
        const revision = row.revision + 1;
        this.database
          .prepare(
            `UPDATE chat_runs SET
               status = 'unknown', revision = ?,
               summary = COALESCE(summary, ?), last_error = ?,
               updated_at = ?
             WHERE id = ?`,
          )
          .run(revision, message, message, now, row.id);
        this.touchConversation(row.conversation_id);
        const next = this.database
          .prepare('SELECT * FROM chat_runs WHERE id = ?')
          .get(row.id) as RunRow | undefined;
        if (next) updated.push(runFromRow(next));
      }
      return updated;
    });
  }

  getConversationByThread(
    threadId: string,
  ): ChatConversationRecord | null {
    const row = this.database
      .prepare('SELECT * FROM chat_conversations WHERE thread_id = ?')
      .get(threadId) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : null;
  }

  getRun(id: string): ChatRunRecord | null {
    const row = this.database
      .prepare('SELECT * FROM chat_runs WHERE id = ?')
      .get(id) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  getRunBySubmission(
    conversationId: string,
    submissionId: string,
  ): ChatRunRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM chat_runs WHERE conversation_id = ? AND submission_id = ?',
      )
      .get(conversationId, submissionId) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  getRunByTurn(
    conversationId: string,
    turnId: string,
  ): ChatRunRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM chat_runs WHERE conversation_id = ? AND turn_id = ?',
      )
      .get(conversationId, turnId) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  upsertRun(record: ChatRunRecord, touchConversation = true): boolean {
    return this.database.runInTransaction(() => {
      const existing = this.database
        .prepare('SELECT revision, status FROM chat_runs WHERE id = ?')
        .get(record.id) as
        | { revision: number; status: ChatRunStatus }
        | undefined;
      if (existing) {
        if (record.revision < existing.revision) return false;
        if (
          record.revision === existing.revision &&
          record.status === existing.status
        ) {
          return false;
        }
        const terminal =
          existing.status === 'completed' ||
          existing.status === 'failed' ||
          existing.status === 'stopped';
        if (terminal && record.status === 'running') return false;
      }
      this.database
        .prepare(
          `INSERT INTO chat_runs (
             id, conversation_id, project_id, submission_id, turn_id,
             status, revision, settings_json, started_at, finished_at,
             summary, tools_json, steps_json, last_error, runtime_instance_id,
             toolbox_name, execution_cwd, environment_path, interpreter_path,
             interpreter_version, sandbox, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             submission_id = excluded.submission_id,
             turn_id = excluded.turn_id,
             status = excluded.status,
             revision = excluded.revision,
             settings_json = excluded.settings_json,
             started_at = excluded.started_at,
             finished_at = excluded.finished_at,
             summary = excluded.summary,
             tools_json = excluded.tools_json,
             steps_json = excluded.steps_json,
             last_error = excluded.last_error,
             runtime_instance_id = excluded.runtime_instance_id,
             toolbox_name = excluded.toolbox_name,
             execution_cwd = excluded.execution_cwd,
             environment_path = excluded.environment_path,
             interpreter_path = excluded.interpreter_path,
             interpreter_version = excluded.interpreter_version,
             sandbox = excluded.sandbox,
             updated_at = excluded.updated_at`,
        )
        .run(
          record.id,
          record.conversationId,
          record.projectId,
          record.submissionId,
          record.turnId,
          record.status,
          record.revision,
          JSON.stringify(record.settings),
          record.startedAt,
          record.finishedAt,
          record.summary,
          record.tools.length ? JSON.stringify(record.tools) : null,
          record.steps ? JSON.stringify(record.steps) : null,
          record.lastError,
          record.runtimeInstanceId,
          record.execution?.toolboxName ?? null,
          record.execution?.cwd ?? null,
          record.execution?.environmentPath ?? null,
          record.execution?.interpreterPath ?? null,
          record.execution?.interpreterVersion ?? null,
          record.execution?.sandbox ?? null,
          record.createdAt,
          record.updatedAt,
        );
      if (touchConversation) this.touchConversation(record.conversationId);
      return true;
    });
  }

  touchConversation(conversationId: string): void {
    this.database
      .prepare(
        `UPDATE chat_conversations SET
           summary_revision = summary_revision + 1,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(nowIso(), conversationId);
  }

  getSubmission(
    projectId: string,
    conversationId: string,
    submissionId: string,
  ): ChatSubmissionRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM chat_submissions
         WHERE project_id = ? AND conversation_id = ? AND submission_id = ?`,
      )
      .get(projectId, conversationId, submissionId) as
      | SubmissionRow
      | undefined;
    return row ? submissionFromRow(row) : null;
  }

  getSubmissionById(
    submissionId: string,
  ): ChatSubmissionRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM chat_submissions WHERE submission_id = ?',
      )
      .get(submissionId) as SubmissionRow | undefined;
    return row ? submissionFromRow(row) : null;
  }

  listPendingSubmissions(
    conversationId: string,
  ): ChatSubmissionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_submissions
         WHERE conversation_id = ?
           AND stage IN ('prepared', 'sending', 'unknown', 'accepted')
         ORDER BY created_at DESC`,
      )
      .all(conversationId) as unknown as SubmissionRow[];
    return rows.map(submissionFromRow);
  }

  listUnresolvedSubmissions(): ChatSubmissionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_submissions
         WHERE stage IN ('sending', 'unknown', 'accepted')
         ORDER BY updated_at DESC`,
      )
      .all() as unknown as SubmissionRow[];
    return rows.map(submissionFromRow);
  }

  getSubmissionByThreadTurn(
    threadId: string,
    turnId: string,
  ): ChatSubmissionRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM chat_submissions
         WHERE thread_id = ? AND turn_id = ?`,
      )
      .get(threadId, turnId) as SubmissionRow | undefined;
    return row ? submissionFromRow(row) : null;
  }

  /**
   * Finds any journal already bound to this conversation turn, including a
   * finished journal whose run row is missing. Turn ownership is an identity,
   * not a property of the unresolved queue; a terminal event for an old turn
   * must not fall through to the conversation's current in-flight submission
   * merely because the old run was not persisted.
   */
  getSubmissionByConversationTurn(
    projectId: string,
    conversationId: string,
    turnId: string,
  ): ChatSubmissionRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM chat_submissions
         WHERE project_id = ? AND conversation_id = ?
           AND (turn_id = ? OR run_id = ?)
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(projectId, conversationId, turnId, turnId) as
      | SubmissionRow
      | undefined;
    return row ? submissionFromRow(row) : null;
  }

  insertSubmission(record: {
    projectId: string;
    conversationId: string;
    submissionId: string;
    input: SendChatMessageInput;
    composedText: string;
    imagePaths: readonly string[];
    digest: string;
  }): ChatSubmissionRecord {
    const now = nowIso();
    try {
      this.database
        .prepare(
          `INSERT INTO chat_submissions (
             project_id, conversation_id, submission_id, stage, input_json,
             digest, thread_id, turn_id, user_message_id, run_id,
             receipt_json, verification, created_at, updated_at
           ) VALUES (?, ?, ?, 'prepared', ?, ?, NULL, NULL, NULL, NULL,
             NULL, NULL, ?, ?)`,
        )
        .run(
          record.projectId,
          record.conversationId,
          record.submissionId,
          JSON.stringify({
            input: {
              ...record.input,
              references: stripReferencePreviews(record.input.references),
            },
            composedText: record.composedText,
            imagePaths: [...record.imagePaths],
          }),
          record.digest,
          now,
          now,
        );
    } catch (error) {
      throw new ChatStoreError(
        'chat-save-failed',
        `提交记录保存失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const saved = this.getSubmission(
      record.projectId,
      record.conversationId,
      record.submissionId,
    );
    if (!saved) {
      throw new ChatStoreError('chat-save-failed', '提交后无法读取本地记录。');
    }
    return saved;
  }

  updateSubmission(
    projectId: string,
    conversationId: string,
    submissionId: string,
    patch: {
      stage?: ChatSubmissionStage;
      threadId?: string | null;
      turnId?: string | null;
      userMessageId?: string | null;
      runId?: string | null;
      receipt?: unknown;
      verification?: string | null;
    },
  ): ChatSubmissionRecord {
    const current = this.getSubmission(
      projectId,
      conversationId,
      submissionId,
    );
    if (!current) {
      throw new ChatStoreError('chat-not-found', '提交记录不存在。');
    }
    this.database
      .prepare(
        `UPDATE chat_submissions SET
           stage = ?, thread_id = ?, turn_id = ?, user_message_id = ?,
           run_id = ?, receipt_json = ?, verification = ?, updated_at = ?
         WHERE project_id = ? AND conversation_id = ? AND submission_id = ?`,
      )
      .run(
        patch.stage ?? current.stage,
        patch.threadId !== undefined ? patch.threadId : current.threadId,
        patch.turnId !== undefined ? patch.turnId : current.turnId,
        patch.userMessageId !== undefined
          ? patch.userMessageId
          : current.userMessageId,
        patch.runId !== undefined ? patch.runId : current.runId,
        patch.receipt !== undefined
          ? JSON.stringify(patch.receipt)
          : current.receipt !== null
            ? JSON.stringify(current.receipt)
            : null,
        patch.verification !== undefined
          ? patch.verification
          : current.verification,
        nowIso(),
        projectId,
        conversationId,
        submissionId,
      );
    const saved = this.getSubmission(
      projectId,
      conversationId,
      submissionId,
    );
    if (!saved) {
      throw new ChatStoreError('chat-save-failed', '更新提交后无法读取本地记录。');
    }
    return saved;
  }

  /**
   * Clears the submitted draft only when the saved user state still equals the
   * submitted snapshot. New input typed while the turn was starting is kept.
   */
  clearSubmittedDraftIfUnchanged(
    conversationId: string,
    input: SendChatMessageInput,
  ): boolean {
    return this.database.runInTransaction(() => {
      const current = this.getConversationById(conversationId);
      if (!current) return false;
      const matches =
        current.draft === input.text &&
        referencesEqual(current.references, input.references);
      if (!matches) return false;
      this.database
        .prepare(
          `UPDATE chat_conversations SET
             draft = '', references_json = '[]',
             state_revision = state_revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso(), conversationId);
      return true;
    });
  }

  /**
   * On startup no prior app-server process is owned by this application. Any
   * persisted running run must be presented as unverified, never as running.
   */
  markStaleRunsUnknown(): number {
    return this.database.runInTransaction(() => {
      const rows = this.database
        .prepare(
          "SELECT id, conversation_id FROM chat_runs WHERE status = 'running'",
        )
        .all() as unknown as Array<{
        id: string;
        conversation_id: string;
      }>;
      if (rows.length === 0) return 0;
      const now = nowIso();
      for (const row of rows) {
        this.database
          .prepare(
            `UPDATE chat_runs SET
               status = 'unknown', revision = revision + 1,
               summary = COALESCE(summary, '应用已重新启动，执行状态待核实。'),
               updated_at = ?
             WHERE id = ?`,
          )
          .run(now, row.id);
        this.touchConversation(row.conversation_id);
      }
      return rows.length;
    });
  }

  /**
   * A persisted `prepared` stage proves the RPC write had not started yet, so
   * those submissions can be resolved as not sent. `sending`/`unknown` are
   * retained for history reconciliation.
   */
  resolvePreparedSubmissionsNotSent(): number {
    return this.database.runInTransaction(() => {
      const rows = this.database
        .prepare(
          "SELECT project_id, conversation_id, submission_id FROM chat_submissions WHERE stage = 'prepared'",
        )
        .all() as unknown as Array<{
        project_id: string;
        conversation_id: string;
        submission_id: string;
      }>;
      const now = nowIso();
      for (const row of rows) {
        this.database
          .prepare(
            `UPDATE chat_submissions SET
               stage = 'not-sent', verification = 'prepared-record-restored',
               updated_at = ?
             WHERE project_id = ? AND conversation_id = ? AND submission_id = ?`,
          )
          .run(now, row.project_id, row.conversation_id, row.submission_id);
      }
      return rows.length;
    });
  }

  insertAttachment(record: {
    projectId: string;
    conversationId: string;
    originalName: string;
    kind: 'file' | 'image' | 'screenshot';
    mime: string;
    byteSize: number;
    sha256: string;
    storageName: string;
    width?: number;
    height?: number;
  }): ChatAttachmentRecord {
    const id = randomUUID();
    const now = nowIso();
    this.database
      .prepare(
        `INSERT INTO chat_attachments (
           id, project_id, conversation_id, original_name, kind, mime,
           byte_size, sha256, storage_name, width, height, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.projectId,
        record.conversationId,
        record.originalName,
        record.kind,
        record.mime,
        record.byteSize,
        record.sha256,
        record.storageName,
        record.width ?? null,
        record.height ?? null,
        now,
      );
    const saved = this.getAttachment(record.projectId, id);
    if (!saved) {
      throw new ChatStoreError('chat-save-failed', '附件保存后无法读取本地记录。');
    }
    return saved;
  }

  getAttachment(
    projectId: string,
    attachmentId: string,
  ): ChatAttachmentRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM chat_attachments WHERE project_id = ? AND id = ?',
      )
      .get(projectId, attachmentId) as AttachmentRow | undefined;
    return row ? attachmentFromRow(row) : null;
  }

  listAttachments(conversationId: string): ChatAttachmentRecord[] {
    const rows = this.database
      .prepare(
        'SELECT * FROM chat_attachments WHERE conversation_id = ? ORDER BY created_at',
      )
      .all(conversationId) as unknown as AttachmentRow[];
    return rows.map(attachmentFromRow);
  }

  insertApproval(
    input: Omit<ChatApprovalRecord, 'status' | 'decidedAt'>,
  ): ChatApprovalRecord {
    this.database
      .prepare(
        `INSERT INTO chat_approvals (
           id, project_id, conversation_id, run_id, turn_id, thread_id,
           item_id, method, kind, request_key, payload_json, status,
           runtime_instance_id, connection_generation, created_at, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.projectId,
        input.conversationId,
        input.runId,
        input.turnId,
        input.threadId,
        input.itemId,
        input.method,
        input.kind,
        input.requestKey,
        JSON.stringify(input.payload),
        input.runtimeInstanceId,
        input.connectionGeneration,
        input.createdAt,
      );
    const saved = this.getApproval(input.id);
    if (!saved) {
      throw new ChatStoreError('chat-save-failed', '审批请求写入本地记录失败。');
    }
    return saved;
  }

  getApproval(id: string): ChatApprovalRecord | null {
    const row = this.database
      .prepare('SELECT * FROM chat_approvals WHERE id = ?')
      .get(id) as ApprovalRow | undefined;
    return row ? approvalFromRow(row) : null;
  }

  listApprovals(conversationId: string, limit = 50): ChatApprovalRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_approvals WHERE conversation_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(conversationId, Math.max(1, Math.min(limit, 200))) as unknown as ApprovalRow[];
    return rows.map(approvalFromRow).reverse();
  }

  hasUnresolvedSubmissions(projectId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM chat_submissions s
      WHERE s.project_id=? AND (s.stage IN ('prepared','sending','unknown') OR
        (s.stage='accepted' AND NOT EXISTS (SELECT 1 FROM chat_runs r
          WHERE r.id=s.run_id AND r.status IN ('completed','failed','stopped')))) LIMIT 1
    `).get(projectId));
  }

  listPendingApprovals(): ChatApprovalRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_approvals WHERE status = 'pending'
         ORDER BY created_at, id`,
      )
      .all() as unknown as ApprovalRow[];
    return rows.map(approvalFromRow);
  }

  /**
   * Moves a pending approval to a decided state exactly once. An approval
   * that was already decided, expired or cancelled is never reopened.
   */
  setApprovalStatus(
    id: string,
    status: Exclude<ChatApprovalStatus, 'pending'>,
    decidedAt = Date.now(),
  ): ChatApprovalRecord | null {
    const changes = this.database
      .prepare(
        `UPDATE chat_approvals SET status = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, decidedAt, id);
    if (Number(changes.changes) !== 1) return null;
    return this.getApproval(id);
  }

  expireApprovalsForRun(runId: string, status: 'expired' | 'cancelled' = 'expired'): number {
    const result = this.database
      .prepare(
        `UPDATE chat_approvals SET status = ?, decided_at = ?
         WHERE run_id = ? AND status = 'pending'`,
      )
      .run(status, Date.now(), runId);
    return Number(result.changes);
  }

  expireApprovalsForConversation(
    conversationId: string,
    status: 'expired' | 'cancelled' = 'expired',
  ): number {
    const result = this.database
      .prepare(
        `UPDATE chat_approvals SET status = ?, decided_at = ?
         WHERE conversation_id = ? AND status = 'pending'`,
      )
      .run(status, Date.now(), conversationId);
    return Number(result.changes);
  }

  /** On startup no previous in-memory approval can still be answered. */
  expireStaleApprovals(): number {
    const result = this.database
      .prepare(
        `UPDATE chat_approvals SET status = 'expired', decided_at = ?
         WHERE status = 'pending'`,
      )
      .run(Date.now());
    return Number(result.changes);
  }

  summary(record: ChatConversationRecord): ChatConversationSummary {
    const latestMessage = this.getLatestMessage(record.id);
    const latestRun = this.getLatestRun(record.id);
    return summaryFromRecord(
      record,
      latestMessage ? [latestMessage] : [],
      latestRun ? [latestRun] : [],
    );
  }

  snapshot(
    record: ChatConversationRecord,
    pending?: ChatPendingSubmission | null,
  ): ChatConversationSnapshot {
    const messages = this.listMessages(record.id);
    const runs = this.listRuns(record.id);
    const pendingSubmission =
      pending ??
      (() => {
        const stored = this.listPendingSubmissions(record.id).find(
          (submission) =>
            submission.stage === 'sending' ||
            submission.stage === 'unknown',
        );
        if (!stored) return null;
        return {
          submissionId: stored.submissionId,
          input: stored.input,
          submittedDraft: stored.input.text,
          submittedReferences: stored.input.references.map((reference) => ({
            ...reference,
          })),
        };
      })();
    return {
      ...summaryFromRecord(record, messages, runs),
      settings: { ...record.settings },
      stateRevision: record.stateRevision,
      draft: record.draft,
      references: record.references.map((reference) => ({ ...reference })),
      messages: messages.map(publicMessage),
      runs: runs.map(publicRun),
      ui: {
        ...record.ui,
        expandedRunIds: [...record.ui.expandedRunIds],
      },
      ...(pendingSubmission ? { pendingSubmission } : {}),
      historyStatus: record.historyStatus,
      ...(record.historyError
        ? { historyWarning: record.historyError }
        : {}),
    };
  }
}

export function publicMessageFromRecord(
  record: ChatMessageRecord,
): ChatMessage {
  return publicMessage(record);
}

export function publicRunFromRecord(record: ChatRunRecord): ChatRun {
  return publicRun(record);
}
