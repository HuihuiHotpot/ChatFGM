import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync } from 'node:fs';
import path from 'node:path';
import { explicitSkillContext } from './explicit-skill';
import type {
  ChatApprovalPermissions,
  ChatAttachment,
  ChatCapabilityContext,
  ChatConversationSettings,
  ChatConversationSnapshot,
  ChatConversationSummary,
  ChatConversationUiState,
  ChatPendingSubmission,
  ChatProjectChatState,
  ChatReference,
  ChatRunExecution,
  ChatRunSettings,
  ChatRunStatus,
  ChatSendReceipt,
  ChatSendResult,
  ChatStep,
  ChatStepStatus,
  ChatToolCall,
  CreateChatConversationInput,
  ListChatConversationsInput,
  LoadChatConversationInput,
  ReleaseChatAttachmentInput,
  RespondChatApprovalInput,
  RunningTask,
  SaveChatConversationStateInput,
  SaveChatConversationStateResult,
  SelectChatAttachmentInput,
  SendChatMessageInput,
  SetActiveChatConversationInput,
  StopChatRunInput,
  ChatUpdate,
  ChatUpdateListener,
} from '../ipc/capabilities';
import type { Logger } from '../platform/log';
import type { ProjectService } from '../projects/service';
import type { ApplicationDatabase } from '../storage/database';
import type {
  ChatSettingsChange,
  ChatSettingsGuard,
  ChatToolboxEnvironment,
  SettingsService,
} from '../settings/service';
import {
  CodexProtocolError,
  type CodexNotification,
  type CodexServerRequest,
} from '../settings/codex';
import { DeepSeekClient } from '../settings/deepseek';
import {
  buildShellEnvironmentBase,
  buildToolShellEnvironmentPolicy,
  buildToolboxShellEnvironment,
} from '../settings/python';
import type { ToolboxDefinition } from '../toolboxes/registry';
import {
  AttachmentService,
  type ScreenshotProvider,
} from './attachments';
import {
  CHAT_FULL_ACCESS_PERMISSION,
  CHAT_READ_ONLY_PERMISSION,
  CHAT_WORKSPACE_WRITE_PERMISSION,
  CHATGPT_SERVICE_ID,
  ChatRuntimeManager,
  chatGptAccountHash,
  chatPermissionOptions,
  chatSandboxPolicy,
  isChatPermissionId,
  type ChatRuntimeConnection,
} from './runtime';
import { CHAT_LIMITS, enforceTextLimit, utf8Bytes } from './limits';
import {
  ChatStore,
  ChatStoreError,
  publicApprovalFromRecord,
  publicMessageFromRecord,
  publicRunFromRecord,
  referencesEqual,
  stripReferencePreviews,
  type ChatApprovalRecord,
  type ChatConversationRecord,
  type ChatMessageRecord,
  type ChatRunRecord,
  type ChatSubmissionRecord,
} from './store';
import { ScreenshotService } from './screenshot';
import type { ProjectFileSyncService } from '../workspace/file-sync';

const TURN_PAGE_SIZE = 50;
const ITEM_PAGE_SIZE = 100;
const MESSAGE_FLUSH_MS = 140;
const MAX_MESSAGE_TOOL_DETAIL = 4000;
/**
 * Clock tolerance when matching a terminal turn's start time against the
 * submission's creation time. Provider timestamps are second-granularity, so
 * a legitimate same-second turn may appear up to 999 ms earlier; a turn that
 * started seconds before the submission is a different turn.
 */
const TURN_OWNERSHIP_TOLERANCE_MS = 1000;
const MAX_COMMAND_OUTPUT = 16 * 1024;
const MAX_TOOLBOX_INSTRUCTIONS = 32 * 1024;
const MAX_TOOLBOX_AGENTS = 24 * 1024;
const MAX_TITLE = CHAT_LIMITS.titleChars;

export interface ChatServiceOptions {
  database: ApplicationDatabase;
  logger: Logger;
  projectService: ProjectService;
  settingsService: SettingsService;
  userDataPath: string;
  getMainWindow: () => import('electron').BrowserWindow | undefined;
  screenshotOverlayPath: string;
  screenshotPreloadPath: string;
  deepSeek?: DeepSeekClient;
  screenshot?: ScreenshotProvider;
  /** Coalesced external file change scanner; optional for legacy callers. */
  fileSync?: ProjectFileSyncService;
  /** Bounded OS process-exit confirmation budget; expiration keeps ownership pending. */
  exitConfirmationTimeoutMs?: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeSummary(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(sk|pk|ak)-[A-Za-z0-9._-]{6,}\b/g, '[redacted]')
    .replace(/([?&](?:key|token|code|secret)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 800);
}

/** Generic fallback used only when no detailed CLI error is available. */
const GENERIC_SYSTEM_ERROR = 'Codex thread 进入系统错误状态。';

const ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  usage_limit_exceeded: '使用额度已用尽',
  usage_limit_reached: '使用额度已用尽',
  rate_limit_exceeded: '请求频率超限',
  context_window_exceeded: '上下文窗口已超出',
  authentication_error: '账号认证失败',
  unauthorized: '账号认证失败',
  network_error: '网络请求失败',
  server_overloaded: '服务暂时过载',
  tool_error: '工具执行失败',
  stream_error: '流式响应中断',
};

function errorCodeOf(error: Record<string, unknown>): string {
  const raw =
    error.codex_error_info ??
    error.codexErrorInfo ??
    error.code ??
    error.type;
  if (typeof raw === 'string') return raw.trim().slice(0, 80);
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const key of ['type', 'code', 'kind', 'id']) {
      if (typeof record[key] === 'string') {
        return (record[key] as string).trim().slice(0, 80);
      }
    }
  }
  return '';
}

/**
 * Builds a presentable message from a CLI error object. The raw message is
 * kept (sanitized) and the stable error code is added when known, so a
 * concrete reason is never reduced to a generic "system error".
 */
function codexErrorText(error: Record<string, unknown>): string | null {
  const message =
    typeof error.message === 'string'
      ? sanitizeSummary(error.message.trim())
      : '';
  const detail =
    typeof error.detail === 'string'
      ? sanitizeSummary(error.detail.trim())
      : '';
  const code = errorCodeOf(error);
  const label = code ? ERROR_CODE_LABELS[code] ?? '' : '';
  const reason = message || detail;
  if (label && reason) return `${label}（${code}）：${reason}`;
  if (label) return `${label}（${code}）`;
  if (reason) return reason;
  if (code) return `Codex 执行错误：${code}`;
  return null;
}

function isGenericSystemError(value: string | null | undefined): boolean {
  if (!value) return true;
  return value === GENERIC_SYSTEM_ERROR || value.startsWith(GENERIC_SYSTEM_ERROR);
}

function hasDetailedError(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && !isGenericSystemError(value);
}

/** True when the text carries a stable CLI error code (not just prose). */
function hasStableErrorCode(value: string | null | undefined): boolean {
  if (!value) return false;
  return Object.keys(ERROR_CODE_LABELS).some((code) =>
    value.includes(code),
  );
}

/** Chooses the more specific error so a later generic event cannot win. */
function preferDetailedError(
  current: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  if (hasDetailedError(current)) return current!;
  if (hasDetailedError(incoming)) return incoming!;
  return current ?? incoming ?? null;
}

function isTerminalStatus(status: ChatRunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped'
  );
}

function mapTurnStatus(status: unknown, live: boolean): ChatRunStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'stopped';
  return live ? 'running' : 'unknown';
}

function mapToolStatus(status: unknown): ChatToolCall['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'declined') return 'failed';
  if (status === 'inProgress') return 'running';
  return 'unknown';
}

function settleToolStatuses(
  tools: readonly ChatToolCall[],
  status: ChatRunStatus,
): ChatToolCall[] {
  return tools.map((tool) =>
    isTerminalStatus(status) && tool.status === 'running'
      ? { ...tool, status: 'unknown' }
      : tool,
  );
}

function mapPlanStatus(status: unknown): ChatStepStatus {
  if (status === 'completed') return 'completed';
  if (status === 'inProgress') return 'running';
  return 'pending';
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is Record<string, unknown> =>
        Boolean(part && typeof part === 'object'),
    )
    .map((part) =>
      part.type === 'text' && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestampMs(seconds: unknown): number | null {
  const value = numberOrNull(seconds);
  return value === null ? null : Math.round(value * 1000);
}

function titleFromInput(input: SendChatMessageInput): string {
  const line =
    input.text
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.length > 0) ?? '';
  const title = line
    .replace(/[#>*_`~[\]()|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title) return title.slice(0, MAX_TITLE);
  const attachment = input.references.find(
    (reference) => reference.kind === 'attachment',
  );
  if (attachment) return `附件 · ${attachment.name}`.slice(0, MAX_TITLE);
  const reference = input.references[0];
  return reference ? `引用 · ${reference.name}`.slice(0, MAX_TITLE) : '新对话';
}

class PreSendError extends Error {
  readonly acceptance: 'not-sent' | 'unknown';

  constructor(message: string, acceptance: 'not-sent' | 'unknown' = 'not-sent') {
    super(message);
    this.name = 'PreSendError';
    this.acceptance = acceptance;
  }
}

interface InFlightSubmission {
  conversationId: string;
  projectId: string;
  submissionId: string;
  threadId: string | null;
  /** Runtime generation that actually carried the turn/start request. */
  connectionGeneration?: number;
  acceptance: Deferred<ChatSendReceipt>;
  accepted: boolean;
}

interface RunConnectionBinding {
  serviceId: string;
  conversationId: string;
  threadId: string | null;
  generation: number;
}

interface LiveMessageState {
  record: ChatMessageRecord;
  timer: NodeJS.Timeout | null;
  dirty: boolean;
  failed: boolean;
  error: string;
}

interface HistoryTurn {
  id: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  error?: Record<string, unknown> | null;
  items: Array<Record<string, unknown>>;
  itemTimes: Array<{ startedAtMs: number | null; completedAtMs: number | null }>;
}

interface HistoryResult {
  turns: HistoryTurn[];
  thread: Record<string, unknown>;
}

function runSettingsFromInput(
  input: SendChatMessageInput,
  serviceId: string,
  serviceName: string | undefined,
): ChatRunSettings {
  return {
    serviceId,
    ...(serviceName ? { serviceName } : {}),
    modelId: input.settings.modelId,
    ...(input.settings.modelLabel
      ? { modelLabel: input.settings.modelLabel }
      : {}),
    effortId: input.settings.effortId,
    ...(input.settings.effortLabel
      ? { effortLabel: input.settings.effortLabel }
      : {}),
    permissionId: input.settings.permissionId,
    ...(input.settings.permissionLabel
      ? { permissionLabel: input.settings.permissionLabel }
      : {}),
  };
}

function historyRunSettings(
  conversation: ChatConversationRecord,
): ChatRunSettings {
  return {
    serviceId: conversation.serviceId,
    ...(conversation.serviceName
      ? { serviceName: conversation.serviceName }
      : {}),
    modelId: conversation.settings.modelId,
    ...(conversation.settings.modelLabel
      ? { modelLabel: conversation.settings.modelLabel }
      : {}),
    effortId: conversation.settings.effortId,
    ...(conversation.settings.effortLabel
      ? { effortLabel: conversation.settings.effortLabel }
      : {}),
    permissionId: conversation.settings.permissionId,
    ...(conversation.settings.permissionLabel
      ? { permissionLabel: conversation.settings.permissionLabel }
      : {}),
  };
}

function normalizeReferenceList(
  references: readonly ChatReference[],
): ChatReference[] {
  if (!Array.isArray(references)) {
    throw new PreSendError('对话引用格式无效。');
  }
  if (references.length > CHAT_LIMITS.referencesPerMessage) {
    throw new PreSendError(
      `引用数量超过 ${CHAT_LIMITS.referencesPerMessage} 个上限，未发送。`,
    );
  }
  return references.map((reference, index) => {
    if (!reference || typeof reference !== 'object') {
      throw new PreSendError(`第 ${index + 1} 个引用格式无效。`);
    }
    const id = reference.id;
    if (typeof id !== 'string' || !id || id.length > 300) {
      throw new PreSendError(`第 ${index + 1} 个引用标识无效。`);
    }
    if (
      reference.kind !== 'file' &&
      reference.kind !== 'folder' &&
      reference.kind !== 'attachment'
    ) {
      throw new PreSendError(`第 ${index + 1} 个引用类型无效。`);
    }
    if (typeof reference.name !== 'string' || reference.name.length > 300) {
      throw new PreSendError(`第 ${index + 1} 个引用名称无效。`);
    }
    if (
      typeof reference.displayPath !== 'string' ||
      reference.displayPath.length > 2000 ||
      reference.displayPath.includes('\u0000')
    ) {
      throw new PreSendError(`第 ${index + 1} 个引用路径无效。`);
    }
    if (
      reference.kind === 'file' &&
      (typeof reference.fileIdentity !== 'string' ||
        !reference.fileIdentity)
    ) {
      throw new PreSendError(`文件引用「${reference.name}」缺少稳定身份。`);
    }
    if (
      reference.kind === 'folder' &&
      (typeof reference.directoryId !== 'string' ||
        !reference.directoryId)
    ) {
      throw new PreSendError(`目录引用「${reference.name}」缺少稳定身份。`);
    }
    if (
      reference.kind === 'attachment' &&
      (typeof reference.attachmentId !== 'string' ||
        !reference.attachmentId)
    ) {
      throw new PreSendError(`附件引用「${reference.name}」缺少附件标识。`);
    }
    return { ...reference, preview: undefined } as ChatReference;
  });
}

function validateSettings(
  settings: ChatConversationSettings,
  requireModel: boolean,
): ChatConversationSettings {
  if (!settings || typeof settings !== 'object') {
    throw new PreSendError('对话设置格式无效。');
  }
  if (requireModel && (typeof settings.modelId !== 'string' || !settings.modelId)) {
    throw new PreSendError('请选择模型。');
  }
  if (typeof settings.modelId !== 'string') {
    throw new PreSendError('对话设置格式无效。');
  }
  if (!isChatPermissionId(settings.permissionId)) {
    throw new PreSendError('权限模式无效，未发送。');
  }
  if (
    settings.effortId !== null &&
    typeof settings.effortId !== 'string'
  ) {
    throw new PreSendError('推理强度设置无效。');
  }
  return {
    modelId: settings.modelId,
    ...(typeof settings.modelLabel === 'string'
      ? { modelLabel: settings.modelLabel }
      : {}),
    effortId: settings.effortId,
    ...(typeof settings.effortLabel === 'string'
      ? { effortLabel: settings.effortLabel }
      : {}),
    permissionId: settings.permissionId,
    permissionLabel: permissionLabelFor(settings.permissionId),
  };
}

function validateUi(ui: ChatConversationUiState): ChatConversationUiState {
  if (!ui || typeof ui !== 'object') {
    throw new PreSendError('对话阅读位置格式无效。');
  }
  const scrollTop =
    typeof ui.scrollTop === 'number' && Number.isFinite(ui.scrollTop)
      ? Math.max(0, Math.min(ui.scrollTop, 100_000_000))
      : 0;
  const expandedRunIds = Array.isArray(ui.expandedRunIds)
    ? ui.expandedRunIds
        .filter((id): id is string => typeof id === 'string')
        .slice(0, 100)
    : [];
  return {
    scrollTop,
    followLatest: ui.followLatest !== false,
    expandedRunIds,
  };
}

export interface ToolboxExecutionContext {
  toolbox: ToolboxDefinition;
  /** Absent when the toolbox environment is not configured yet. */
  environmentPath?: string;
  interpreterPath?: string;
  interpreterVersion?: string;
  developerInstructions: string;
  shellEnvironment: Record<string, string>;
  execution: ChatRunExecution;
}

function permissionLabelFor(permissionId: string): string {
  return (
    chatPermissionOptions().find((option) => option.id === permissionId)
      ?.label ?? '只读'
  );
}

/**
 * Builds the per-thread professional instructions from the loaded toolbox
 * resources. The toolbox files stay in place; only this bounded summary and
 * the real file paths are sent. Codex still loads the project's own AGENTS.md
 * from the workspace cwd on its own.
 */
export function buildToolboxDeveloperInstructions(input: {
  toolbox: ToolboxDefinition;
  agentsText: string | null;
  interpreterPath?: string;
  environmentPath?: string;
  projectRoot: string;
}): string {
  const sections: string[] = [];
  sections.push(`## Flamelet 工具箱：${input.toolbox.name}`);
  sections.push(
    '工具箱资源保持原位加载：AGENTS.md、skills、tools 不复制到项目、应用缓存或 CODEX_HOME，也不覆盖项目已有的 AGENTS.md。',
  );
  if (input.agentsText && input.agentsText.trim()) {
    sections.push('### 工具箱专业说明（AGENTS.md）');
    sections.push(input.agentsText.slice(0, MAX_TOOLBOX_AGENTS).trim());
  }
  if (input.toolbox.skills.length > 0) {
    sections.push('### 可用技能（按需读取完整 SKILL.md）');
    for (const skill of input.toolbox.skills) {
      sections.push(
        `- ${skill.name}：${skill.description || '（无描述）'}\n  SKILL.md 真实路径：${skill.skillPath}`,
      );
    }
    sections.push(
      '技能中的相对资源路径以对应 SKILL.md 所在目录为基准解析；只有任务需要时才读取完整技能与工具，不要预先加载全部内容。',
    );
  }
  sections.push('### Python 运行环境');
  if (input.interpreterPath && input.environmentPath) {
    sections.push(`环境根目录：${input.environmentPath}`);
    sections.push(`真实解释器：${input.interpreterPath}`);
    sections.push(
      '当前 thread 的命令环境已把该环境放在 PATH 最前，并提供 CHATFGM_PYTHON 变量。执行工具箱脚本时必须使用该真实解释器（PowerShell 可用 $env:CHATFGM_PYTHON），不得退回系统 Python，也不要手动 activate。',
    );
  } else {
    sections.push(
      '该工具箱尚未在依赖设置中配置 Python 运行环境。可以继续普通对话和阅读工具箱资料，但不要执行专业工具或假装环境可用；需要计算时先提示用户在依赖设置中为该工具箱选择 venv/Conda 环境根目录。不得退回系统 Python。',
    );
  }
  sections.push(
    `项目工作目录：${input.projectRoot}。需要写入项目时使用项目内相对路径；超出默认写范围的操作由运行层请求审批。`,
  );
  sections.push(
    '### Windows 命令 shell\n' +
      '工具命令由 Windows PowerShell 执行。调用命令工具时使用 PowerShell 语法，不要用 cmd.exe /c 包装 PowerShell 命令；如果工具参数需要指定 shell，请选择 powershell，不要选择 bash。只有任务明确需要 cmd 语义时才作为程序调用 cmd.exe /c。',
  );
  const text = sections.join('\n\n');
  return text.length > MAX_TOOLBOX_INSTRUCTIONS
    ? `${text.slice(0, MAX_TOOLBOX_INSTRUCTIONS)}\n\n（工具箱说明已截断）`
    : text;
}

interface ApprovalDisplayPayload {
  title: string;
  command?: string;
  paths?: string[];
  cwd?: string;
  reason?: string;
  availableDecisions?: unknown;
  permissionDisplay?: ChatApprovalPermissions;
  grant?: unknown;
  permissions?: unknown;
}

interface NormalizedApprovalPermissions {
  display: ChatApprovalPermissions;
  grant: unknown;
  supported: boolean;
}

function normalizeApprovalPermissions(
  value: unknown,
  scope: 'turn' | 'command',
  networkContext?: unknown,
): NormalizedApprovalPermissions {
  const readPaths: string[] = [];
  const writePaths: string[] = [];
  const denyPaths: string[] = [];
  const networkTargets: Array<{ host: string; protocol?: string }> = [];
  let network = false;
  let supported = true;
  if (value !== null && value !== undefined) {
    if (typeof value !== 'object' || Array.isArray(value)) supported = false;
    else if (Object.keys(value).some((key) => key !== 'fileSystem' && key !== 'network')) supported = false;
  }
  const add = (target: string[], candidate: unknown) => {
    if (typeof candidate !== 'string' || !candidate) {
      supported = false;
      return;
    }
    if (!target.includes(candidate)) target.push(candidate);
  };
  const fileSystem =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>).fileSystem
      : null;
  if (fileSystem !== null && fileSystem !== undefined) {
    if (!fileSystem || typeof fileSystem !== 'object') {
      supported = false;
    } else {
      const record = fileSystem as Record<string, unknown>;
      for (const key of ['read', 'write'] as const) {
        const list = record[key];
        if (list === null || list === undefined) continue;
        if (!Array.isArray(list)) {
          supported = false;
          continue;
        }
        for (const item of list) {
          add(key === 'read' ? readPaths : writePaths, item);
        }
      }
      const entries = record.entries;
      if (entries !== null && entries !== undefined) {
        if (!Array.isArray(entries)) supported = false;
        else {
          for (const entry of entries) {
            if (!entry || typeof entry !== 'object') {
              supported = false;
              continue;
            }
            const access = (entry as Record<string, unknown>).access;
            const pathValue = (entry as Record<string, unknown>).path;
            if (!pathValue || typeof pathValue !== 'object') {
              supported = false;
              continue;
            }
            const pathRecord = pathValue as Record<string, unknown>;
            let displayPath: string;
            if (pathRecord.type === 'path' && typeof pathRecord.path === 'string') {
              displayPath = pathRecord.path;
            } else if (
              pathRecord.type === 'glob_pattern' &&
              typeof pathRecord.pattern === 'string'
            ) {
              displayPath = `匹配模式：${pathRecord.pattern}`;
            } else if (
              pathRecord.type === 'special' &&
              pathRecord.value !== undefined
            ) {
              displayPath = `系统目录：${JSON.stringify(pathRecord.value)}`;
            } else {
              supported = false;
              continue;
            }
            if (access === 'read') add(readPaths, displayPath);
            else if (access === 'write') add(writePaths, displayPath);
            else if (access === 'deny') add(denyPaths, displayPath);
            else supported = false;
          }
        }
      }
      for (const key of Object.keys(record)) {
        if (
          key !== 'read' &&
          key !== 'write' &&
          key !== 'entries' &&
          key !== 'globScanMaxDepth'
        ) {
          supported = false;
        }
      }
    }
  }
  const networkValue =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>).network
      : null;
  if (networkValue !== null && networkValue !== undefined) {
    if (!networkValue || typeof networkValue !== 'object') supported = false;
    else {
      if (Object.keys(networkValue).some((key) => key !== 'enabled')) supported = false;
      const enabled = (networkValue as Record<string, unknown>).enabled;
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        supported = false;
      }
      network = enabled === true;
    }
  }
  if (networkContext && typeof networkContext === 'object') {
    const record = networkContext as Record<string, unknown>;
    if (typeof record.host === 'string' && record.host) {
      network = true;
      networkTargets.push({
        host: record.host,
        ...(typeof record.protocol === 'string' && record.protocol
          ? { protocol: record.protocol }
          : {}),
      });
    }
  }
  return {
    display: {
      readPaths,
      writePaths,
      denyPaths,
      network,
      networkTargets,
      scope,
    },
    grant:
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {},
    supported,
  };
}

function approvalPayloadFor(
  method: string,
  params: Record<string, unknown>,
): {
  kind: 'command' | 'file-change' | 'permissions';
  payload: ApprovalDisplayPayload;
  supported: boolean;
} | null {
  const reason =
    typeof params.reason === 'string' && params.reason
      ? params.reason.slice(0, 2000)
      : undefined;
  const cwd =
    typeof params.cwd === 'string' && params.cwd
      ? params.cwd
      : undefined;
  if (method === 'item/commandExecution/requestApproval') {
    const command =
      typeof params.command === 'string'
        ? params.command
        : undefined;
    const normalized = normalizeApprovalPermissions(
      params.additionalPermissions ?? null,
      'command',
      params.networkApprovalContext,
    );
    const hasPermissions =
      params.additionalPermissions != null ||
      params.networkApprovalContext != null ||
      normalized.display.readPaths.length > 0 ||
      normalized.display.writePaths.length > 0 ||
      normalized.display.denyPaths.length > 0 ||
      normalized.display.network;
    return {
      kind: 'command',
      supported: normalized.supported,
      payload: {
        title: '命令执行审批',
        ...(command ? { command } : {}),
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
        ...(hasPermissions
          ? { permissionDisplay: normalized.display }
          : {}),
        ...(params.availableDecisions !== undefined
          ? { availableDecisions: params.availableDecisions }
          : {}),
      },
    };
  }
  if (method === 'item/fileChange/requestApproval') {
    const grantRoot =
      typeof params.grantRoot === 'string' && params.grantRoot
        ? params.grantRoot
        : undefined;
    return {
      kind: 'file-change',
      supported: true,
      payload: {
        title: '文件变更审批',
        ...(grantRoot ? { paths: [grantRoot] } : {}),
        ...(reason ? { reason } : {}),
        ...(params.availableDecisions !== undefined
          ? { availableDecisions: params.availableDecisions }
          : {}),
      },
    };
  }
  if (method === 'item/permissions/requestApproval') {
    const normalized = normalizeApprovalPermissions(params.permissions, 'turn');
    return {
      kind: 'permissions',
      supported: normalized.supported,
      payload: {
        title: '额外权限审批',
        ...(reason ? { reason } : {}),
        ...(cwd ? { cwd } : {}),
        ...(normalized.display.readPaths.length +
          normalized.display.writePaths.length +
          normalized.display.denyPaths.length >
        0
          ? {
              paths: [
                ...normalized.display.readPaths,
                ...normalized.display.writePaths,
                ...normalized.display.denyPaths,
              ],
            }
          : {}),
        permissionDisplay: normalized.display,
        grant: normalized.grant,
      },
    };
  }
  return null;
}

function approvalDecisionResult(
  record: ChatApprovalRecord,
  decision: 'approve' | 'deny',
): unknown {
  if (record.kind === 'permissions') {
    if (decision === 'approve') {
      const grant = record.payload.grant ?? record.payload.permissions;
      return {
        permissions: grant && typeof grant === 'object' ? grant : {},
        scope: 'turn',
      };
    }
    return { permissions: {}, scope: 'turn' };
  }
  if (decision === 'approve') return { decision: 'accept' };
  const available = Array.isArray(record.payload.availableDecisions)
    ? record.payload.availableDecisions
    : [];
  // `cancel` interrupts the turn (the runtime decides the final result); when
  // the server offers `decline`, the agent simply continues after the denial.
  return { decision: available.includes('decline') ? 'decline' : 'cancel' };
}

export class ChatService implements ChatSettingsGuard {
  private readonly store: ChatStore;
  private readonly logger: Logger;
  private readonly projectService: ProjectService;
  private readonly settingsService: SettingsService;
  private readonly runtime: ChatRuntimeManager;
  private readonly attachments: AttachmentService;
  private readonly screenshot?: ScreenshotService;
  private readonly fileSync?: ProjectFileSyncService;
  private readonly listeners = new Set<ChatUpdateListener>();
  private readonly threadIndex = new Map<string, string>();
  private readonly orphanEvents = new Map<
    string,
    Array<{ connection: ChatRuntimeConnection; notification: CodexNotification }>
  >();
  /** Pending server requests keyed by the opaque approval id. */
  private readonly pendingApprovals = new Map<
    string,
    {
      request: CodexServerRequest;
      serviceId: string;
      generation: number;
    }
  >();
  private readonly commandOutputs = new Map<
    string,
    { turnId: string; text: string }
  >();
  private readonly commandOutputWrites = new Map<
    string,
    { turnId: string; at: number }
  >();
  private readonly runCommandItems = new Map<string, Set<string>>();
  /**
   * Detailed CLI errors that arrived before their run row existed. They are
   * merged when the run is accepted/finalized so the concrete reason survives
   * an early generic thread-status event.
   */
  private readonly pendingRunErrors = new Map<
    string,
    { message: string; updatedAt: number }
  >();
  private readonly threadInstructionSignatures = new Map<string, string>();
  /** Paths reported by in-progress fileChange items, used for approvals. */
  private readonly fileChangePaths = new Map<
    string,
    { turnId: string; paths: string[] }
  >();
  private readonly lastFileActivity = new Map<string, number>();
  private readonly inFlight = new Map<string, InFlightSubmission>();
  private readonly sendQueues = new Map<string, Promise<void>>();
  private readonly runConnections = new Map<string, RunConnectionBinding>();
  private cliDetectionActive = false;
  private readonly liveMessages = new Map<string, LiveMessageState>();
  private readonly conversationLocks = new Map<string, Promise<unknown>>();
  private readonly executionLocks = new Map<string, Promise<unknown>>();
  private readonly preparationToolboxUses = new Map<string, number>();
  private readonly accepting = new Map<string, Promise<ChatSendReceipt>>();
  /** Newest complete context snapshot; older reads never replace it. */
  private latestContext: ChatCapabilityContext | null = null;
  /** Identity assigned when a context read starts; readers publish this id. */
  private contextRequestSequence = 0;
  private readonly unsubscribeRuntime: Array<() => void> = [];
  private readonly runtimeInstanceId = randomUUID();
  private disposed = false;

  constructor(options: ChatServiceOptions) {
    this.store = new ChatStore(options.database);
    this.logger = options.logger;
    this.projectService = options.projectService;
    this.settingsService = options.settingsService;
    this.fileSync = options.fileSync;
    const deepSeek =
      options.deepSeek ?? new DeepSeekClient(options.logger);
    this.runtime = new ChatRuntimeManager({
      logger: options.logger,
      codexRoot: path.join(options.userDataPath, 'codex'),
      deepSeek,
      getConfig: () => options.settingsService.getChatConfig(),
      getCli: () => options.settingsService.getChatCliRuntime(),
      getInvocation: () => options.settingsService.getChatInvocation(),
      getAuthProcess: () => options.settingsService.getChatAuthProcess(),
      getAccount: () => options.settingsService.getChatAccount(),
      getServiceKey: (serviceId) =>
        options.settingsService.decryptChatServiceKey(serviceId),
      ...(options.exitConfirmationTimeoutMs
        ? {
            exitConfirmationTimeoutMs:
              options.exitConfirmationTimeoutMs,
          }
        : {}),
    });
    this.screenshot = options.screenshot
      ? undefined
      : new ScreenshotService({
          logger: options.logger,
          overlayHtmlPath: options.screenshotOverlayPath,
          preloadPath: options.screenshotPreloadPath,
          getMainWindow: options.getMainWindow,
        });
    const screenshotProvider: ScreenshotProvider =
      options.screenshot ??
      ({
        capture: () => this.screenshot!.capture(),
      } satisfies ScreenshotProvider);
    this.attachments = new AttachmentService({
      store: this.store,
      projectService: options.projectService,
      logger: options.logger,
      userDataPath: options.userDataPath,
      getMainWindow: options.getMainWindow,
      screenshot: screenshotProvider,
    });
  }

  start(): void {
    if (this.disposed) return;
    const recoveredRuns = this.store.markStaleRunsUnknown();
    const prepared = this.store.resolvePreparedSubmissionsNotSent();
    const expiredApprovals = this.store.expireStaleApprovals();
    if (recoveredRuns > 0 || prepared > 0 || expiredApprovals > 0) {
      this.logger.info('chat-startup-recovery', {
        runsUnknown: recoveredRuns,
        submissionsNotSent: prepared,
        approvalsExpired: expiredApprovals,
      });
    }
    this.unsubscribeRuntime.push(
      this.runtime.onNotification((connection, notification) =>
        this.handleNotification(connection, notification),
      ),
    );
    this.unsubscribeRuntime.push(
      this.runtime.onExit((connection, message) =>
        this.handleConnectionExit(connection, message),
      ),
    );
    this.unsubscribeRuntime.push(
      this.runtime.onServerRequest((connection, request) =>
        this.handleServerRequest(connection, request),
      ),
    );
    this.unsubscribeRuntime.push(
      this.runtime.onServerRequestResolved((connection, resolved) =>
        this.handleServerRequestResolved(connection, resolved),
      ),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.expireAllApprovalsOnDispose();
    this.flushAllLiveMessages();
    for (const timer of this.liveMessages.values()) {
      if (timer.timer) clearTimeout(timer.timer);
    }
    this.liveMessages.clear();
    this.runConnections.clear();
    this.latestContext = null;
    this.inFlight.clear();
    this.pendingApprovals.clear();
    this.commandOutputs.clear();
    this.commandOutputWrites.clear();
    this.runCommandItems.clear();
    this.pendingRunErrors.clear();
    this.threadInstructionSignatures.clear();
    this.fileChangePaths.clear();
    this.lastFileActivity.clear();
    this.recreationContexts.clear();
    this.recreatingProjects.clear();
    this.cliDetectionActive = false;
    for (const unsubscribe of this.unsubscribeRuntime) unsubscribe();
    this.unsubscribeRuntime.length = 0;
    this.listeners.clear();
    this.runtime.dispose();
    this.attachments.dispose();
    this.screenshot?.dispose();
  }

  subscribeUpdates(listener: ChatUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getAttachmentPreviewRegistry() {
    return this.attachments.previews;
  }

  private nextContextRequestId(): number {
    this.contextRequestSequence += 1;
    return this.contextRequestSequence;
  }

  getContext(input?: {
    projectId?: string;
    refresh?: boolean;
  }): Promise<ChatCapabilityContext> {
    const contextRequestId = this.nextContextRequestId();
    return this.runtime.getContext(input).then((context) => {
      const versioned: ChatCapabilityContext = {
        ...context,
        contextRequestId,
      };
      if (
        !this.latestContext ||
        (this.latestContext.contextRequestId ?? -1) <= contextRequestId
      ) {
        this.latestContext = versioned;
      }
      const listeners = [...this.listeners];
      for (const listener of listeners) {
        try {
          listener({ type: 'context', context: versioned });
        } catch {
          // Renderer listener failures are not service failures.
        }
      }
      return versioned;
    });
  }

  async listConversations(
    input: ListChatConversationsInput,
  ): Promise<readonly ChatConversationSummary[]> {
    this.assertProject(input.projectId);
    const records = this.store.listConversations(input.projectId);
    return records.slice(0, 100).map((record) => this.store.summary(record));
  }

  async createConversation(
    input: CreateChatConversationInput,
  ): Promise<ChatConversationSnapshot> {
    this.assertProject(input.projectId);
    const serviceId =
      input.serviceId?.trim() || this.runtime.getCurrentServiceId();
    if (!serviceId) {
      throw new ChatStoreError(
        'chat-service-unavailable',
        '尚未配置模型服务，暂不能新建对话。',
      );
    }
    const service = await this.runtime.getServiceContext(serviceId, true);
    if (service.connection !== 'connected') {
      throw new ChatStoreError(
        'chat-service-unavailable',
        service.connectionMessage ??
          `模型服务「${service.serviceName}」未连接，暂不能新建对话。`,
      );
    }
    const requestedModelId =
      typeof input.modelId === 'string' ? input.modelId.trim() || null : null;
    let model: (typeof service.models)[number] | null = null;
    if (requestedModelId) {
      model =
        service.models.find(
          (item) => item.modelId === requestedModelId,
        ) ?? null;
      if (!model) {
        throw new ChatStoreError(
          'chat-model-unavailable',
          `所选模型「${requestedModelId}」已不在服务「${service.serviceName}」的可用目录中，请重新选择模型。`,
        );
      }
      if (!model.available) {
        throw new ChatStoreError(
          'chat-model-unavailable',
          model.reason ??
            `所选模型「${requestedModelId}」当前不可用，请重新选择模型。`,
        );
      }
    } else {
      model =
        service.models.find(
          (item) => item.modelId === service.defaultModelId,
        ) ??
        service.models[0] ??
        null;
    }
    const settings: ChatConversationSettings = {
      modelId: model?.modelId ?? '',
      ...(model ? { modelLabel: model.label } : {}),
      effortId: model?.efforts
        ? model.defaultEffortId ?? model.efforts[0]?.id ?? null
        : null,
      ...(model?.efforts
        ? {
            effortLabel:
              model.efforts.find(
                (effort) =>
                  effort.id ===
                  (model.defaultEffortId ?? model.efforts?.[0]?.id),
              )?.label,
          }
        : {}),
      permissionId: CHAT_READ_ONLY_PERMISSION,
      permissionLabel: '只读',
    };
    const conversation = this.store.createConversation({
      projectId: input.projectId,
      serviceId: service.serviceId,
      serviceName: service.serviceName,
      settings,
    });
    try {
      const projectState = this.store.getProjectState(input.projectId);
      this.store.setActiveConversation(
        input.projectId,
        conversation.id,
        projectState.revision,
      );
    } catch {
      // The active pointer is a convenience; creation itself already succeeded.
    }
    return this.snapshot(conversation);
  }

  async loadConversation(
    input: LoadChatConversationInput,
  ): Promise<ChatConversationSnapshot> {
    if (this.recreatingProjects.has(input.projectId)) {
      throw new ChatStoreError('project-recreate-running', '原项目正在退出路径归属，不能重新读取历史。');
    }
    this.historyLoads.set(input.projectId, (this.historyLoads.get(input.projectId) ?? 0) + 1);
    try {
      return await this.loadConversationSnapshot(input);
    } finally {
      const remaining = (this.historyLoads.get(input.projectId) ?? 1) - 1;
      if (remaining > 0) this.historyLoads.set(input.projectId, remaining);
      else this.historyLoads.delete(input.projectId);
    }
  }

  private async loadConversationSnapshot(
    input: LoadChatConversationInput,
  ): Promise<ChatConversationSnapshot> {
    this.assertProject(input.projectId);
    let conversation = this.requireConversation(
      input.projectId,
      input.conversationId,
    );
    this.registerThread(conversation);
    if (!conversation.threadId) {
      const updated = this.store.updateConversation(conversation.id, {
        historyStatus: 'ready',
        historyError: null,
        touch: false,
      });
      return this.snapshot(updated);
    }
    // Never read remote history while this conversation is actively running.
    // An active app-server turn owns the writer; querying it can interrupt the
    // turn and would race the streamed UI state. The local snapshot is
    // authoritative until the terminal event arrives.
    if (
      this.inFlight.has(conversation.id) ||
      this.store
        .listRuns(conversation.id)
        .some((run) => run.status === 'running')
    ) {
      return this.snapshot(conversation);
    }
    try {
      const history = await this.withExecutionLock(
        conversation.id,
        async () => {
          const connection = await this.ensureHistoryConnection(conversation);
          await this.verifyAccount(connection, conversation);
          return this.readHistory(connection, conversation.threadId!);
        },
      );
      await this.mergeHistory(conversation, history.turns);
      conversation = this.requireConversation(
        input.projectId,
        input.conversationId,
      );
      conversation = this.store.updateConversation(conversation.id, {
        historyStatus: 'ready',
        historyError: null,
        touch: false,
      });
      return this.snapshot(conversation);
    } catch (error) {
      const message = sanitizeSummary(
        `历史暂时无法核实：${errorMessage(error)}`,
      );
      conversation = this.store.updateConversation(conversation.id, {
        historyStatus: 'error',
        historyError: message,
        touch: false,
      });
      this.logger.warn('chat-history-load-failed', {
        serviceId: conversation.serviceId,
        message: message.slice(0, 200),
      });
      return this.snapshot(conversation);
    }
  }

  saveConversationState(
    input: SaveChatConversationStateInput,
  ): SaveChatConversationStateResult {
    this.assertProject(input.projectId);
    const conversation = this.requireConversation(
      input.projectId,
      input.conversationId,
    );
    const draft = enforceTextLimit(
      input.draft,
      CHAT_LIMITS.draftChars,
      '草稿',
    );
    const references = normalizeReferenceList(input.references);
    const settings = validateSettings(input.settings, false);
    const ui = validateUi(input.ui);
    const failedMessages = this.failedLiveMessages(conversation.id);
    if (failedMessages.length > 0) {
      for (const live of failedMessages) {
        this.flushLiveMessage(live.record.id, true);
      }
      if (this.failedLiveMessages(conversation.id).length > 0) {
        throw new ChatStoreError(
          'chat-message-save-failed',
          '助手回复尚未成功保存到本地；草稿已保留，请恢复存储后重试。',
        );
      }
    }
    const stateRevision = this.store.saveConversationState(
      input.projectId,
      conversation.id,
      {
        draft,
        references,
        settings,
        ui,
        ...(input.expectedStateRevision !== undefined
          ? { expectedStateRevision: input.expectedStateRevision }
          : {}),
      },
    );
    return { stateRevision };
  }

  async selectAttachment(
    input: SelectChatAttachmentInput,
  ): Promise<ChatAttachment | null> {
    if (this.recreatingProjects.has(input.projectId)) throw new ChatStoreError('project-recreate-running', '项目正在重新创建，不能添加附件。');
    this.assertProject(input.projectId);
    const conversation = this.requireConversation(
      input.projectId,
      input.conversationId,
    );
    const service = await this.runtime.getServiceContext(
      conversation.serviceId,
    );
    if (service.connection !== 'connected') {
      throw new ChatStoreError(
        'chat-service-mismatch',
        service.connectionMessage ??
          `该对话绑定的服务「${service.serviceName}」未连接，暂不能添加附件。`,
      );
    }
    return this.attachments.select(input);
  }

  releaseAttachmentPreview(input: ReleaseChatAttachmentInput): void {
    this.assertProject(input.projectId);
    if (!/^[a-f0-9]{48}$/.test(input.token)) {
      throw new ChatStoreError('chat-invalid-input', '附件预览标识无效。');
    }
    this.attachments.releasePreview(input.projectId, input.token);
  }

  getProjectState(projectId: string): ChatProjectChatState {
    this.assertProject(projectId);
    return this.store.getProjectState(projectId);
  }

  setActiveConversation(
    input: SetActiveChatConversationInput,
  ): ChatProjectChatState {
    this.assertProject(input.projectId);
    return this.store.setActiveConversation(
      input.projectId,
      input.conversationId,
      input.expectedRevision,
    );
  }

  async sendMessage(input: SendChatMessageInput): Promise<ChatSendResult> {
    if (this.recreatingProjects.has(input?.projectId)) {
      return this.notSent('原项目正在退出路径归属，不能提交新的任务。');
    }
    const conversationId =
      input && typeof input.conversationId === 'string'
        ? input.conversationId
        : '';
    if (!conversationId) {
      return this.performSend(input);
    }
    const release = await this.acquireSendLock(conversationId);
    try {
      if (this.cliDetectionActive) {
        return {
          status: 'error',
          message: '正在检测 Codex CLI，暂不能发送。',
          acceptance: 'not-sent',
        };
      }
      return await this.performSend(input);
    } catch (error) {
      if (error instanceof PreSendError) {
        return {
          status: 'error',
          message: error.message,
          acceptance: error.acceptance,
        };
      }
      return {
        status: 'error',
        message: errorMessage(error),
        acceptance: 'not-sent',
      };
    } finally {
      release();
    }
  }

  private acquireSendLock(conversationId: string): Promise<() => void> {
    const previous = this.sendQueues.get(conversationId) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.sendQueues.set(conversationId, tail);
    return previous.catch(() => undefined).then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseGate();
        if (this.sendQueues.get(conversationId) === tail) {
          this.sendQueues.delete(conversationId);
        }
      };
    });
  }

  async stopRun(input: StopChatRunInput): Promise<void> {
    this.assertRegisteredProject(input.projectId);
    const conversation = this.requireConversation(
      input.projectId,
      input.conversationId,
    );
    const run = this.store.getRun(input.runId);
    if (!run || run.conversationId !== conversation.id) {
      throw new ChatStoreError(
        'chat-run-not-found',
        '运行记录不存在或不属于当前对话。',
      );
    }
    if (run.status !== 'running' && run.status !== 'unknown') {
      throw new ChatStoreError('chat-run-finished', '运行已经结束，无法停止。');
    }
    if (
      run.runtimeInstanceId !== this.runtimeInstanceId ||
      !this.isRunLive(run, conversation)
    ) {
      throw new ChatStoreError(
        'chat-run-orphaned',
        '该运行所属的 Codex 进程已不在当前应用实例中，只能保留待核实记录。',
      );
    }
    if (!run.turnId) {
      throw new ChatStoreError(
        'chat-run-unbound',
        '正在等待发送确认，暂不能停止。',
      );
    }
    const connection = this.runtime.getConversationConnection(
      conversation.id,
    );
    if (!connection || connection.disposed || connection.process.hasExited) {
      throw new ChatStoreError(
        'chat-service-unavailable',
        '所属对话执行进程不可用。',
      );
    }
    if (connection.connection !== 'connected') {
      throw new ChatStoreError(
        'chat-service-unavailable',
        connection.connectionMessage ?? '所属运行进程不可用。',
      );
    }
    if (run.status === 'unknown') {
      const retryError = await this.finalizeExecutionSessions(
        conversation,
        run.id,
        'interrupted',
      );
      if (retryError) {
        throw new ChatStoreError(
          'chat-stop-failed',
          `执行链仍未确认结束：${retryError}`,
        );
      }
      await this.withConversationLock(conversation.id, async () => {
        const current = this.store.getRun(run.id);
        if (!current || current.status !== 'unknown') return;
        const stoppedRun: ChatRunRecord = {
          ...current,
          status: 'stopped',
          tools: settleToolStatuses(current.tools, 'stopped'),
          revision: current.revision + 1,
          finishedAt: Date.now(),
          updatedAt: new Date().toISOString(),
        };
        if (this.store.upsertRun(stoppedRun)) this.publishRun(stoppedRun);
      });
      this.runCommandItems.delete(run.id);
      this.runConnections.delete(run.id);
      for (const [messageId, live] of this.liveMessages) {
        if (live.record.turnId === run.id) this.liveMessages.delete(messageId);
      }
      this.expireRunApprovals(run.id, 'cancelled');
      if (this.fileSync) {
        try {
          await this.fileSync.finalize(conversation.projectId);
        } catch (error) {
          await this.appendRunWarning(
            conversation,
            run.id,
            `最终文件同步失败：${errorMessage(error)}`,
          );
        }
      }
      return;
    }
    try {
      await connection.process.interruptTurn(
        conversation.threadId ?? run.turnId,
        run.turnId,
      );
    } catch (error) {
      throw new ChatStoreError(
        'chat-stop-failed',
        `停止请求失败，运行状态未改变：${errorMessage(error)}`,
      );
    }
    // A run waiting for approval can only finish after the pending request is
    // settled. The interrupt itself stays authoritative for the final status.
    this.expireRunApprovals(run.id, 'cancelled');
    const stopDeadline = Date.now() + 15_000;
    while (Date.now() < stopDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const current = this.store.getRun(run.id);
      if (!current) return;
      if (current.status === 'unknown') {
        throw new ChatStoreError(
          'chat-stop-failed',
          current.summary ??
            '执行链尚未确认结束，运行保留为待核实，请重试停止。',
        );
      }
      if (current.status !== 'running') return;
    }
    throw new ChatStoreError(
      'chat-stop-failed',
      '停止请求已提交，但执行链尚未确认结束；运行仍保留为进行中，请重试。',
    );
  }

  async listRunningTasks(projectId: string): Promise<RunningTask[]> {
    // Task state lives in the run layer. The project directory may already be
    // gone; that must not hide a live run or block stopping it.
    this.assertRegisteredProject(projectId);
    const tasks: RunningTask[] = [];
    for (const run of this.store.listUnsettledRunsByProject(projectId)) {
      const conversation = this.store.getConversationById(
        run.conversationId,
      );
      if (!conversation) continue;
      // A run from another application instance, or from a replaced
      // connection, must never be presented as a live run of this process.
      if (
        run.runtimeInstanceId !== this.runtimeInstanceId ||
        !this.isRunLive(run, conversation)
      ) {
        this.runConnections.delete(run.id);
        this.markRunUnknown(
          run,
          '所属 Codex 进程已不再控制该运行，执行状态待核实。',
        );
        continue;
      }
      const hasApproval = this.store
        .listPendingApprovals()
        .some((approval) => approval.runId === run.id);
      tasks.push({
        id: run.id,
        title: conversation.title,
        status: hasApproval
          ? '等待审批'
          : run.status === 'running'
            ? '运行中'
            : '待核实',
        projectId,
        conversationId: conversation.id,
        runId: run.id,
      });
    }
    for (const conversationId of this.sendQueues.keys()) {
      const conversation = this.store.getConversationById(conversationId);
      if (!conversation || conversation.projectId !== projectId) continue;
      const entry = this.inFlight.get(conversationId);
      tasks.push({
        id: entry
          ? `submission:${entry.submissionId}`
          : `conversation:${conversationId}`,
        title: '正在提交对话消息',
        status: '正在提交',
        projectId,
        conversationId,
      });
    }
    return tasks;
  }

  private readonly recreatingProjects = new Set<string>();
  private readonly historyLoads = new Map<string, number>();
  private readonly recreationContexts = new Map<string, {
    conversations: Set<string>; threads: Set<string>; runs: Set<string>;
  }>();

  /** Block new sends while retiring every owned process, including pending exits. */
  async beginProjectRecreation(projectId: string): Promise<() => void> {
    const live = this.store.listUnsettledRunsByProject(projectId).length > 0;
    const unresolved = this.store.hasUnresolvedSubmissions(projectId);
    const approval = this.store.listPendingApprovals().some((record) => record.projectId === projectId);
    const pending = [...this.sendQueues.keys(), ...this.inFlight.keys()].some(
      (id) => this.store.getConversationById(id)?.projectId === projectId,
    );
    if (live || pending || unresolved || approval || this.historyLoads.has(projectId)) {
      throw new ChatStoreError('project-recreate-running',
        '原项目仍有未结算或状态不确定的任务、审批或历史读取，请先停止或核实并等待结束。');
    }
    if (this.recreatingProjects.has(projectId)) {
      throw new ChatStoreError('project-recreate-running', '原项目正在退出路径归属，请稍候。');
    }
    const conversations = this.store.listConversations(projectId);
    for (const live of this.liveMessages.values()) {
      if (live.record.projectId === projectId && live.dirty) {
        this.flushLiveMessage(live.record.id, true);
        if (live.failed) throw new ChatStoreError('chat-message-save-failed', '原项目回复尚未保存，不能清除项目。');
      }
    }
    this.recreationContexts.set(projectId, {
      conversations: new Set(conversations.map((conversation) => conversation.id)),
      threads: new Set(conversations.flatMap((conversation) => conversation.threadId ? [conversation.threadId] : [])),
      runs: new Set(conversations.flatMap((conversation) => this.store.listRuns(conversation.id).map((run) => run.id))),
    });
    this.recreatingProjects.add(projectId);
    try {
      await Promise.all(this.store.listConversations(projectId).map(
        (conversation) => this.runtime.disposeConversationConnection(conversation.id),
      ));
      return () => {
        this.recreatingProjects.delete(projectId);
        if (this.store.listConversations(projectId).length > 0) this.recreationContexts.delete(projectId);
      };
    } catch (error) {
      this.recreatingProjects.delete(projectId);
      this.recreationContexts.delete(projectId);
      throw error;
    }
  }

  forgetProject(projectId: string): void {
    this.attachments.previews.revokeProject(projectId);
    for (const [id, live] of this.liveMessages) {
      if (live.record.projectId !== projectId) continue;
      if (live.timer) clearTimeout(live.timer);
      this.liveMessages.delete(id);
    }
    const context = this.recreationContexts.get(projectId);
    if (context) {
      for (const conversationId of context.conversations) {
        this.conversationLocks.delete(conversationId);
        this.executionLocks.delete(conversationId);
      }
      for (const thread of context.threads) {
        this.threadIndex.delete(thread);
        this.orphanEvents.delete(thread);
      }
      for (const key of this.threadInstructionSignatures.keys()) {
        if (context.threads.has(key.split('\u0000')[1])) this.threadInstructionSignatures.delete(key);
      }
      for (const [key, entry] of this.commandOutputs) {
        if (context.runs.has(entry.turnId)) { this.commandOutputs.delete(key); this.commandOutputWrites.delete(key); }
      }
      for (const [key, entry] of this.fileChangePaths) {
        if (context.runs.has(entry.turnId)) this.fileChangePaths.delete(key);
      }
      for (const run of context.runs) { this.runConnections.delete(run); this.runCommandItems.delete(run); }
      this.recreationContexts.delete(projectId);
    }
    this.lastFileActivity.delete(projectId);
  }

  async stopTask(input: {
    projectId: string;
    taskId: string;
    conversationId?: string;
    runId?: string;
  }): Promise<void> {
    this.assertRegisteredProject(input.projectId);
    const runId = input.runId ?? input.taskId;
    const run = this.store.getRun(runId);
    if (!run || run.projectId !== input.projectId) {
      throw new ChatStoreError('chat-run-not-found', '当前没有可停止的任务。');
    }
    await this.stopRun({
      projectId: input.projectId,
      conversationId: run.conversationId,
      runId: run.id,
    });
  }

  validateSettingsChange(change: ChatSettingsChange): void {
    const active = this.activeChatActivities();
    if (active.length > 0) {
      if (change.cliPathChanged) {
        throw new ChatStoreError(
          'chat-settings-blocked',
          '仍有未结束的对话运行，不能更换 Codex CLI。请先等待完成或停止。',
        );
      }
      if (change.modeChanged || change.activeServiceChanged) {
        throw new ChatStoreError(
          'chat-settings-blocked',
          '仍有未结束的对话运行，不能切换当前模型服务或模式。请先等待完成或停止。',
        );
      }
      const affected = new Set<string>();
      for (const serviceId of change.changedServiceIds) {
        affected.add(serviceId);
      }
      for (const serviceId of change.removedServiceIds) {
        affected.add(serviceId);
      }
      if (active.some((serviceId) => affected.has(serviceId))) {
        throw new ChatStoreError(
          'chat-settings-blocked',
          '仍有未结束的对话运行，不能修改或删除对应模型服务。请先等待完成或停止。',
        );
      }
    }
    if (change.changedToolboxEnvironmentIds.length > 0) {
      const activeToolboxes = this.protectedToolboxNames();
      const blocked = change.changedToolboxEnvironmentIds.filter((name) =>
        activeToolboxes.has(name),
      );
      if (blocked.length > 0) {
        throw new ChatStoreError(
          'chat-settings-blocked',
          `工具箱「${blocked.join('、')}」正在使用中，暂不能修改运行环境。`,
        );
      }
    }
  }

  private protectedToolboxNames(): Set<string> {
    const names = new Set(this.activeToolboxNames());
    for (const name of this.preparationToolboxUses.keys()) {
      names.add(name);
    }
    return names;
  }

  /**
   * Holds one reference on a toolbox from the moment this send freezes its
   * environment until its run (or failure) has been registered. Multiple
   * preparations of the same toolbox must all release their own reference.
   */
  private beginToolboxPreparation(toolboxName: string): () => void {
    this.preparationToolboxUses.set(
      toolboxName,
      (this.preparationToolboxUses.get(toolboxName) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.preparationToolboxUses.get(toolboxName) ?? 0;
      if (count <= 1) {
        this.preparationToolboxUses.delete(toolboxName);
      } else {
        this.preparationToolboxUses.set(toolboxName, count - 1);
      }
    };
  }

  private activeToolboxNames(): Set<string> {
    const names = new Set<string>();
    for (const run of this.store.listAllUnsettledRuns()) {
      const conversation = this.store.getConversationById(
        run.conversationId,
      );
      if (!conversation) continue;
      if (!this.isRunLive(run, conversation)) continue;
      try {
        const toolbox = this.projectService.getProjectToolbox(
          conversation.projectId,
        );
        if (toolbox) names.add(toolbox.name);
      } catch {
        // A missing toolbox cannot be protected by a settings change.
      }
    }
    return names;
  }

  validateCliReplacement(pathValue: string, currentPath: string): void {
    void pathValue;
    void currentPath;
    if (this.activeChatActivities().length === 0) return;
    throw new ChatStoreError(
      'chat-settings-blocked',
      '仍有未结束的对话运行，不能检测或替换实际 Codex CLI。请先等待完成或停止。',
    );
  }

  beginCliDetection(): () => void {
    if (this.cliDetectionActive) {
      throw new ChatStoreError(
        'chat-settings-blocked',
        'Codex CLI 检测已在进行中，请稍候。',
      );
    }
    if (this.activeChatActivities().length > 0) {
      throw new ChatStoreError(
        'chat-settings-blocked',
        '仍有未结束的对话运行，不能检测或替换实际 Codex CLI。请先等待完成或停止。',
      );
    }
    this.cliDetectionActive = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.cliDetectionActive = false;
    };
  }

  validateLogout(): void {
    if (
      this.activeChatActivities().includes(CHATGPT_SERVICE_ID)
    ) {
      throw new ChatStoreError(
        'chat-settings-blocked',
        'ChatGPT 对话仍有未结束的运行，不能退出当前账号。请先等待完成或停止。',
      );
    }
  }

  onSettingsApplied(change: ChatSettingsChange, applied: boolean): void {
    void applied;
    this.runtime.invalidateServiceCatalog();
    const resetAll =
      change.cliPathChanged ||
      change.modeChanged ||
      change.activeServiceChanged;
    if (resetAll) {
      for (const serviceId of this.connectedServiceIds()) {
        this.expireApprovalsForService(serviceId);
        this.runtime.disposeServiceConnection(serviceId);
        this.forgetRunBindingsForService(serviceId);
      }
      void this.getContext({ refresh: true }).catch(() => undefined);
      return;
    }
    for (const serviceId of change.removedServiceIds) {
      this.expireApprovalsForService(serviceId);
      this.runtime.disposeServiceConnection(serviceId);
      this.forgetRunBindingsForService(serviceId);
    }
    for (const serviceId of change.changedServiceIds) {
      this.expireApprovalsForService(serviceId);
      this.runtime.disposeServiceConnection(serviceId);
      this.forgetRunBindingsForService(serviceId);
    }
    if (
      change.removedServiceIds.length > 0 ||
      change.changedServiceIds.length > 0
    ) {
      void this.getContext({ refresh: true }).catch(() => undefined);
    }
  }

  onCliReplaced(): void {
    this.runtime.invalidateServiceCatalog();
    for (const serviceId of this.connectedServiceIds()) {
      this.expireApprovalsForService(serviceId);
      this.runtime.disposeServiceConnection(serviceId);
      this.forgetRunBindingsForService(serviceId);
    }
    void this.getContext({ refresh: true }).catch(() => undefined);
  }

  onAuthChanged(): void {
    this.runtime.invalidateServiceCatalog();
    this.expireApprovalsForService(CHATGPT_SERVICE_ID);
    this.runtime.disposeServiceConnection(CHATGPT_SERVICE_ID);
    this.forgetRunBindingsForService(CHATGPT_SERVICE_ID);
    void this.getContext({ refresh: true }).catch(() => undefined);
  }

  private assertProject(projectId: string): void {
    if (typeof projectId !== 'string' || !projectId) {
      throw new ChatStoreError('chat-invalid-input', '项目标识无效。');
    }
    this.projectService.getProjectRoot(projectId);
  }

  /**
   * Run-layer operations such as listing or stopping a task only need the
   * project registration. Requiring the directory would falsely report a
   * missing path instead of the actual run state.
   */
  private assertRegisteredProject(projectId: string): void {
    if (typeof projectId !== 'string' || !projectId) {
      throw new ChatStoreError('chat-invalid-input', '项目标识无效。');
    }
    this.projectService.requireRegisteredProject(projectId);
  }

  private requireConversation(
    projectId: string,
    conversationId: string,
  ): ChatConversationRecord {
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new ChatStoreError('chat-invalid-input', '对话标识无效。');
    }
    const conversation = this.store.getConversation(
      projectId,
      conversationId,
    );
    if (!conversation) {
      throw new ChatStoreError(
        'chat-not-found',
        '对话不存在或不属于当前项目。',
      );
    }
    this.registerThread(conversation);
    return conversation;
  }

  private registerThread(conversation: ChatConversationRecord): void {
    if (!conversation.threadId) return;
    const existing = this.threadIndex.get(conversation.threadId);
    if (existing && existing !== conversation.id) {
      this.logger.warn('chat-thread-identity-conflict', {
        serviceId: conversation.serviceId,
      });
      return;
    }
    this.threadIndex.set(conversation.threadId, conversation.id);
    const buffered = this.orphanEvents.get(conversation.threadId);
    if (buffered && buffered.length > 0) {
      this.orphanEvents.delete(conversation.threadId);
      for (const entry of buffered) {
        this.handleNotification(entry.connection, entry.notification);
      }
    }
  }

  private snapshot(
    conversation: ChatConversationRecord,
    pending?: ChatPendingSubmission | null,
  ): ChatConversationSnapshot {
    const snapshot = this.store.snapshot(conversation, pending);
    return {
      ...snapshot,
      approvals: this.store
        .listApprovals(conversation.id)
        .map(publicApprovalFromRecord),
      references: this.attachments.enrichReferences(
        conversation.projectId,
        conversation.id,
        snapshot.references,
      ),
      messages: snapshot.messages.map((message) => ({
        ...message,
        ...(message.references
          ? {
              references: this.attachments.enrichReferences(
                conversation.projectId,
                conversation.id,
                message.references,
              ),
            }
          : {}),
      })),
      ...(snapshot.pendingSubmission
        ? {
            pendingSubmission: {
              ...snapshot.pendingSubmission,
              submittedReferences: this.attachments.enrichReferences(
                conversation.projectId,
                conversation.id,
                snapshot.pendingSubmission.submittedReferences,
              ),
            },
          }
        : {}),
    };
  }

  private publish(update: ChatUpdate): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(update);
      } catch (error) {
        this.logger.warn('chat-update-listener-failed', {
          message: errorMessage(error).slice(0, 200),
        });
      }
    }
  }

  private publishRun(record: ChatRunRecord): void {
    this.publish({
      type: 'run',
      projectId: record.projectId,
      conversationId: record.conversationId,
      run: publicRunFromRecord(record),
    });
  }

  private logAsyncFailure(event: string, error: unknown): void {
    this.logger.warn(event, {
      message: sanitizeSummary(errorMessage(error)),
    });
  }

  private publishMessage(record: ChatMessageRecord): void {
    this.publish({
      type: 'message',
      projectId: record.projectId,
      conversationId: record.conversationId,
      message: publicMessageFromRecord(record),
    });
  }

  private publishSummary(conversation: ChatConversationRecord): void {
    this.publish({
      type: 'conversation',
      projectId: conversation.projectId,
      summary: this.store.summary(conversation),
    });
  }

  private withConversationLock<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.conversationLocks.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.conversationLocks.set(
      conversationId,
      next.catch(() => undefined),
    );
    return next;
  }

  private withExecutionLock<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.executionLocks.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.executionLocks.set(
      conversationId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async performSend(
    input: SendChatMessageInput,
  ): Promise<ChatSendResult> {
    if (!input || typeof input !== 'object') {
      return this.notSent('发送请求格式无效。');
    }
    const text = enforceTextLimit(
      input.text ?? '',
      CHAT_LIMITS.messageChars,
      '消息',
    );
    this.assertProject(input.projectId);
    const conversation = this.requireConversation(
      input.projectId,
      input.conversationId,
    );
    if (typeof input.submissionId !== 'string' || !input.submissionId) {
      return this.notSent('提交标识无效。');
    }
    const references = normalizeReferenceList(input.references ?? []);
    const settings = validateSettings(input.settings, true);
    if (!text.trim() && references.length === 0) {
      return this.notSent('消息内容为空。');
    }
    const context = await this.runtime.getServiceContext(
      conversation.serviceId,
    );
    if (!context.serviceId) {
      return this.notSent('当前没有可用的模型服务。');
    }
    if (input.serviceId !== conversation.serviceId) {
      return this.notSent('发送快照中的服务与对话绑定服务不一致。');
    }
    if (context.connection !== 'connected') {
      return this.notSent(
        context.connectionMessage ??
          '当前模型服务未连接，已保留草稿。',
      );
    }
    const model = context.models.find(
      (candidate) => candidate.modelId === settings.modelId,
    );
    if (!model) {
      return this.notSent('当前模型已不再提供，已保留草稿。');
    }
    if (!model.available) {
      return this.notSent(model.reason ?? '当前模型不可用。');
    }
    if (input.references.some((reference) => reference.kind === 'attachment')) {
      const hasImage = input.references.some(
        (reference) =>
          reference.kind === 'attachment' &&
          reference.mime?.startsWith('image/'),
      );
      if (hasImage && !model.input.image) {
        return this.notSent(
          '当前模型不支持图像输入，已保留图片引用和草稿。',
        );
      }
    }
    const effort =
      model.efforts && model.efforts.length > 0
        ? model.efforts.find(
            (candidate) => candidate.id === settings.effortId,
          ) ??
          model.efforts.find(
            (candidate) => candidate.id === model.defaultEffortId,
          ) ??
          model.efforts[0]!
        : null;
    const effectiveSettings: ChatConversationSettings = {
      ...settings,
      modelLabel: model.label,
      effortId: effort?.id ?? null,
      ...(effort?.label ? { effortLabel: effort.label } : {}),
      permissionLabel: permissionLabelFor(settings.permissionId),
    };
    const normalizedInput: SendChatMessageInput = {
      ...input,
      text,
      references,
      settings: effectiveSettings,
      serviceId: conversation.serviceId,
      serviceName: context.serviceName,
    };
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          projectId: input.projectId,
          conversationId: input.conversationId,
          submissionId: input.submissionId,
          text,
          references: stripReferencePreviews(references).map((reference) => ({
            id: reference.id,
            kind: reference.kind,
            name: reference.name,
            displayPath: reference.displayPath,
            fileIdentity: reference.fileIdentity,
            directoryId: reference.directoryId,
            attachmentId: reference.attachmentId,
            mime: reference.mime,
            invalid: reference.invalid === true,
          })),
          settings: effectiveSettings,
          serviceId: conversation.serviceId,
        }),
      )
      .digest('hex');

    const existing = this.store.getSubmission(
      input.projectId,
      input.conversationId,
      input.submissionId,
    );
    if (existing && existing.digest !== digest) {
      return this.notSent(
        '该提交标识已用于不同的消息或设置，已拒绝再次发送。',
      );
    }
    if (existing) {
      if (existing.stage === 'accepted' || existing.stage === 'finished') {
        const receipt = this.receiptForSubmission(existing);
        if (receipt) return { status: 'success', value: receipt };
        return this.unknown(
          '提交已记录为接受，但本地回执不完整；正在等待历史核实。',
        );
      }
      if (
        existing.stage === 'sending' ||
        existing.stage === 'unknown' ||
        existing.stage === 'prepared'
      ) {
        if (existing.stage === 'prepared') {
          // A persisted prepared stage proves the turn RPC was not written.
          this.store.updateSubmission(
            existing.projectId,
            existing.conversationId,
            existing.submissionId,
            {
              stage: 'not-sent',
              verification: 'prepared-before-retry',
            },
          );
        } else {
          const reconciled = await this.reconcileSubmission(
            conversation,
            existing,
          );
          if (reconciled) return reconciled;
          return this.unknown(
            '上次发送结果仍待核实。',
          );
        }
      }
    }

    const unsettled = this.store
      .listRuns(conversation.id)
      .filter(
        (run) => run.status === 'running' || run.status === 'unknown',
      );
    const pending = this.store
      .listPendingSubmissions(conversation.id)
      .filter(
        (submission) =>
          submission.submissionId !== input.submissionId &&
          (submission.stage === 'sending' ||
            submission.stage === 'unknown' ||
            submission.stage === 'accepted'),
      );
    if (unsettled.length > 0 || pending.length > 0) {
      return this.notSent(
        unsettled.some((run) => run.status === 'unknown') ||
          pending.length > 0
          ? '该对话有尚未核实的提交或运行，暂不能发送新消息。'
          : '该对话已有运行中的任务，暂不能发送新消息。',
      );
    }
    if (this.inFlight.has(conversation.id)) {
      return this.unknown('该对话已有提交正在发送，请等待回执。');
    }

    const projectRoot = this.projectService.getProjectRoot(input.projectId);
    const toolboxContext = this.resolveToolboxExecution(
      input.projectId,
      projectRoot,
      settings.permissionId,
    );
    const releasePreparation = toolboxContext
      ? this.beginToolboxPreparation(toolboxContext.toolbox.name)
      : undefined;
    try {
    const content = await this.buildSubmissionContent(
      normalizedInput,
      conversation,
      model.input.image,
    );
    const frozenInput: SendChatMessageInput = {
      ...normalizedInput,
      references: stripReferencePreviews(references),
    };
    let submission = existing;
    if (
      !submission ||
      submission.stage === 'not-sent' ||
      submission.stage === 'rejected'
    ) {
      if (!submission) {
        submission = this.store.insertSubmission({
          projectId: input.projectId,
          conversationId: conversation.id,
          submissionId: input.submissionId,
          input: frozenInput,
          composedText: content.composedText,
          imagePaths: content.imagePaths,
          digest,
        });
      } else {
        submission = this.store.updateSubmission(
          submission.projectId,
          submission.conversationId,
          submission.submissionId,
          { stage: 'prepared', verification: null },
        );
      }
    }
    const reuseFrozenContent =
      Boolean(existing) &&
      (existing!.stage === 'not-sent' ||
        existing!.stage === 'rejected' ||
        existing!.stage === 'prepared');
    const composedText =
      reuseFrozenContent && existing!.composedText
        ? existing!.composedText
        : content.composedText;
    const imagePaths =
      reuseFrozenContent && existing!.imagePaths.length > 0
        ? existing!.imagePaths
        : content.imagePaths;
    // Validate/read an explicit in-place skill before writing the submission or
    // creating a turn. A missing/unreadable skill is a not-sent failure.
    const skillContext = toolboxContext
      ? explicitSkillContext(toolboxContext.toolbox, composedText)
      : null;

    const inFlight: InFlightSubmission = {
      conversationId: conversation.id,
      projectId: conversation.projectId,
      submissionId: input.submissionId,
      threadId: conversation.threadId,
      acceptance: deferred<ChatSendReceipt>(),
      accepted: false,
    };
    this.inFlight.set(conversation.id, inFlight);
    let stageWritten = false;
    let connection: ChatRuntimeConnection;
    let threadId: string;
    try {
      const prepared = await this.withExecutionLock(
        conversation.id,
        async () => {
          const parent = await this.runtime.ensureConnection(
            conversation.serviceId,
          );
          if (parent.connection !== 'connected') {
            throw new PreSendError(
              parent.connectionMessage ?? '模型服务未连接，未发送。',
            );
          }
          const execution = await this.prepareExecutionConnection(
            conversation,
            toolboxContext,
            projectRoot,
            parent,
          );
          await this.verifyAccount(execution.connection, conversation);
          const resumedThreadId = await this.ensureThread(
            conversation,
            execution.connection,
            projectRoot,
            model,
            toolboxContext,
            settings.permissionId,
            settings.effortId ?? 'low',
          );
          this.runtime.markConversationExecution(
            conversation.id,
            execution.connection,
            resumedThreadId,
            execution.fingerprint,
          );
          return {
            connection: execution.connection,
            threadId: resumedThreadId,
          };
        },
      );
      connection = prepared.connection;
      threadId = prepared.threadId;
      inFlight.threadId = threadId;
      inFlight.connectionGeneration = connection.generation;
      this.store.updateSubmission(
        submission.projectId,
        submission.conversationId,
        submission.submissionId,
        {
          stage: 'sending',
          threadId,
        },
      );
      stageWritten = true;
      const sandboxPolicy = chatSandboxPolicy(
        settings.permissionId,
        projectRoot,
      );
      const turnParams: Record<string, unknown> = {
        threadId,
        input: [
          ...(composedText.trim()
            ? [{ type: 'text', text: composedText }]
            : []),
          ...(skillContext ? [skillContext.input] : []),
          ...imagePaths.map((imagePath) => ({
            type: 'localImage',
            path: imagePath,
          })),
        ],
        clientUserMessageId: input.submissionId,
        cwd: projectRoot,
        model: model.modelId,
        approvalPolicy: sandboxPolicy.approvalPolicy,
        sandboxPolicy: sandboxPolicy.sandboxPolicy,
        ...(effort ? { effort: effort.id } : {}),
      };
      const rpc = connection.process
        .startTurn(turnParams)
        .then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const raced = await Promise.race([
        rpc,
        inFlight.acceptance.promise.then((receipt) => ({
          ok: 'accepted' as const,
          receipt,
        })),
      ]);
      if (raced.ok === 'accepted') {
        return { status: 'success', value: raced.receipt };
      }
      if (!raced.ok) {
        const error = raced.error;
        if (this.isPreWriteError(error)) {
          this.markSubmissionNotSent(
            submission,
            errorMessage(error),
          );
          throw new PreSendError(
            `发送未发出：${errorMessage(error)}`,
            'not-sent',
          );
        }
        if (this.isExplicitRpcRejection(error)) {
          this.store.updateSubmission(
            submission.projectId,
            submission.conversationId,
            submission.submissionId,
            {
              stage: 'rejected',
              verification: 'rpc-rejected',
            },
          );
          throw new PreSendError(
            `模型服务拒绝了本次发送：${errorMessage(error)}`,
            'not-sent',
          );
        }
        this.store.updateSubmission(
          submission.projectId,
          submission.conversationId,
          submission.submissionId,
          {
            stage: 'unknown',
            verification: 'receipt-lost',
          },
        );
        return this.unknown(
          `发送结果未知，原提交已保留，请先核实：${errorMessage(error)}`,
        );
      }
      const turn = objectRecord(raced.result.turn);
      const turnId = typeof turn.id === 'string' ? turn.id : '';
      if (!turnId) {
        this.store.updateSubmission(
          submission.projectId,
          submission.conversationId,
          submission.submissionId,
          {
            stage: 'unknown',
            verification: 'invalid-turn-response',
          },
        );
        return this.unknown(
          'Codex 返回的 turn 回执无效，原提交已保留待核实。',
        );
      }
      const receipt = await this.acceptSubmission(
        conversation,
        submission,
        turnId,
        typeof turn.status === 'string' ? turn.status : 'inProgress',
        timestampMs(turn.startedAt),
        connection.generation,
        toolboxContext?.execution,
      );
      return { status: 'success', value: receipt };
    } catch (error) {
      if (error instanceof PreSendError) {
        if (error.acceptance === 'not-sent' && stageWritten) {
          // The caller already knows whether the RPC write happened; a
          // not-sent error after stageWritten only comes from the explicit
          // rejection/pre-write branches above.
          this.markSubmissionNotSent(submission, error.message);
        }
        throw error;
      }
      if (stageWritten) {
        this.store.updateSubmission(
          submission.projectId,
          submission.conversationId,
          submission.submissionId,
          {
            stage: 'unknown',
            verification: 'send-failed-after-write',
          },
        );
        return this.unknown(
          `发送结果未知，原提交已保留，请先核实：${errorMessage(error)}`,
        );
      }
      this.markSubmissionNotSent(submission, errorMessage(error));
      return this.notSent(errorMessage(error));
    } finally {
      if (this.inFlight.get(conversation.id) === inFlight) {
        this.inFlight.delete(conversation.id);
      }
    }
    } finally {
      releasePreparation?.();
    }
  }

  private notSent(message: string): ChatSendResult {
    return { status: 'error', message, acceptance: 'not-sent' };
  }

  private unknown(message: string): ChatSendResult {
    return { status: 'error', message, acceptance: 'unknown' };
  }

  private markSubmissionNotSent(
    submission: ChatSubmissionRecord,
    message: string,
  ): void {
    try {
      const current = this.store.getSubmission(
        submission.projectId,
        submission.conversationId,
        submission.submissionId,
      );
      if (current?.stage === 'rejected') return;
      this.store.updateSubmission(
        submission.projectId,
        submission.conversationId,
        submission.submissionId,
        {
          stage: 'not-sent',
          verification: sanitizeSummary(message),
        },
      );
    } catch {
      // The original send result remains authoritative.
    }
  }

  private isPreWriteError(error: unknown): boolean {
    return (
      error instanceof CodexProtocolError &&
      (error.code === 'codex-not-connected' ||
        error.code === 'codex-write-failed')
    );
  }

  private isExplicitRpcRejection(error: unknown): boolean {
    return (
      error instanceof CodexProtocolError &&
      error.code === 'codex-rpc-error'
    );
  }

  private async verifyAccount(
    connection: ChatRuntimeConnection,
    conversation: ChatConversationRecord,
  ): Promise<void> {
    if (connection.kind !== 'chatgpt') return;
    let account;
    try {
      account = await connection.process.readAccount();
    } catch (error) {
      throw new PreSendError(
        `无法确认 ChatGPT 账号身份，已限制续聊：${errorMessage(error)}`,
      );
    }
    if (account.type !== 'chatgpt' || !account.email) {
      throw new PreSendError(
        '无法确认 ChatGPT 账号身份，已限制续聊。',
      );
    }
    const hash = chatGptAccountHash({
      status: 'logged-in',
      email: account.email,
    });
    if (!hash) {
      throw new PreSendError(
        '无法确认 ChatGPT 账号身份，已限制续聊。',
      );
    }
    if (
      conversation.accountIdentityHash &&
      conversation.accountIdentityHash !== hash
    ) {
      throw new PreSendError(
        'ChatGPT 当前账号与对话创建时不一致，已限制续聊；请切回原账号或新建对话。',
      );
    }
    if (!conversation.accountIdentityHash) {
      this.store.updateConversation(conversation.id, {
        accountIdentityHash: hash,
        touch: false,
      });
    }
  }

  /**
   * Resolves the project's bound toolbox from the application-run cache and
   * reuses the settings Python resolution/detection facts. No toolbox rescan,
   * AGENTS.md reread or Python version probe happens per message.
   */
  private resolveToolboxExecution(
    projectId: string,
    projectRoot: string,
    permissionId: string,
  ): ToolboxExecutionContext | null {
    const toolbox = this.projectService.getProjectToolbox(projectId);
    if (!toolbox) {
      // An unbound folder still supports a normal project conversation.
      return null;
    }
    let environment: ChatToolboxEnvironment;
    try {
      environment = this.settingsService.getChatToolboxEnvironment(
        toolbox.name,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : errorMessage(error);
      throw new PreSendError(
        `工具箱「${toolbox.name}」的 Python 运行环境不可用：${message} 请先在依赖设置中修正该环境的根目录。`,
      );
    }
    const resolved =
      environment.environmentPath && environment.interpreterPath
        ? {
            environmentPath: environment.environmentPath,
            interpreterPath: environment.interpreterPath,
          }
        : undefined;
    const interpreterVersion = environment.interpreterVersion ?? '';
    const developerInstructions = buildToolboxDeveloperInstructions({
      toolbox,
      agentsText: toolbox.agentsText,
      ...(resolved
        ? {
            interpreterPath: resolved.interpreterPath,
            environmentPath: resolved.environmentPath,
          }
        : {}),
      projectRoot,
    });
    const toolboxEnvironment: Record<string, string> = {
      CHATFGM_TOOLBOX: toolbox.name,
      CHATFGM_TOOLBOX_DIR: toolbox.directory,
      CHATFGM_PROJECT_ROOT: projectRoot,
    };
    const shellEnvironment = resolved
      ? buildToolboxShellEnvironment(resolved, toolboxEnvironment)
      : toolboxEnvironment;
    if (
      permissionId === CHAT_WORKSPACE_WRITE_PERMISSION ||
      permissionId === CHAT_FULL_ACCESS_PERMISSION
    ) {
      const sandbox = this.settingsService.getChatSandboxStatus();
      if (sandbox.state === 'unavailable') {
        throw new PreSendError(
          `Windows 沙箱不可用，未发送写权限请求：${sandbox.message} 只读权限仍可继续使用；不会回退为完全访问。`,
        );
      }
    }
    return {
      toolbox,
      ...(resolved
        ? {
            environmentPath: resolved.environmentPath,
            interpreterPath: resolved.interpreterPath,
          }
        : {}),
      interpreterVersion,
      developerInstructions,
      shellEnvironment,
      execution: {
        toolboxName: toolbox.name,
        cwd: projectRoot,
        ...(resolved
          ? {
              environmentPath: resolved.environmentPath,
              interpreterPath: resolved.interpreterPath,
            }
          : {}),
        ...(interpreterVersion ? { interpreterVersion } : {}),
        sandbox: chatSandboxPolicy(permissionId, projectRoot).label,
      },
    };
  }

  private async refreshThreadDeveloperInstructions(
    connection: ChatRuntimeConnection,
    threadId: string,
    instructions: string,
    modelId: string,
    effortId: string,
  ): Promise<void> {
    const signature = createHash('sha256')
      .update(`${modelId}\u0000${effortId}\u0000${instructions}`)
      .digest('hex');
    const signatureKey = `${connection.generation}\u0000${threadId}`;
    if (this.threadInstructionSignatures.get(signatureKey) === signature) return;
    try {
      // thread/resume ignores developerInstructions for an already loaded
      // thread. thread/settings/update applies them to subsequent turns while
      // preserving the thread id and all history.
      await connection.process.updateThreadSettings({
        threadId,
        collaborationMode: {
          mode: 'default',
          settings: {
            model: modelId,
            reasoning_effort: effortId,
            developer_instructions: instructions,
          },
        },
      });
      this.threadInstructionSignatures.set(signatureKey, signature);
    } catch (error) {
      throw new PreSendError(
        `工具箱配置更新失败，未发送：${errorMessage(error)}`,
      );
    }
  }

  private executionFingerprint(
    conversation: ChatConversationRecord,
    toolboxContext: ToolboxExecutionContext | null,
    projectRoot: string,
  ): string {
    const environment = Object.entries(
      toolboxContext?.shellEnvironment ?? {},
    ).sort(([left], [right]) => left.localeCompare(right));
    return createHash('sha256')
      .update(
        JSON.stringify({
          projectId: conversation.projectId,
          projectRoot: path.resolve(projectRoot).toLowerCase(),
          toolbox: toolboxContext
            ? {
                name: toolboxContext.toolbox.name,
                directory: toolboxContext.toolbox.directory,
                environmentPath: toolboxContext.environmentPath ?? '',
                interpreterPath: toolboxContext.interpreterPath ?? '',
              }
            : null,
          environment,
        }),
      )
      .digest('hex');
  }

  private async prepareExecutionConnection(
    conversation: ChatConversationRecord,
    toolboxContext: ToolboxExecutionContext | null,
    projectRoot: string,
    parent: ChatRuntimeConnection,
  ): Promise<{
    connection: ChatRuntimeConnection;
    fingerprint: string;
  }> {
    const fingerprint = this.executionFingerprint(
      conversation,
      toolboxContext,
      projectRoot,
    );
    const existing = this.runtime.getConversationConnection(conversation.id);
    if (
      existing &&
      !existing.disposed &&
      existing.connection === 'connected' &&
      !existing.process.hasExited &&
      existing.environmentFingerprint === fingerprint &&
      existing.threadId === conversation.threadId
    ) {
      return { connection: existing, fingerprint };
    }
    if (existing) {
      await this.runtime.disposeConversationConnection(conversation.id);
    }
    const connection = await this.runtime.ensureConversationConnection({
      conversationId: conversation.id,
      serviceId: conversation.serviceId,
      serviceName: conversation.serviceName ?? parent.serviceName,
      kind: parent.kind,
      models: parent.models,
      defaultModelId: parent.defaultModelId,
      accountIdentityHash: parent.accountIdentityHash,
      environmentFingerprint: null,
    });
    return { connection, fingerprint };
  }

  private async ensureHistoryConnection(
    conversation: ChatConversationRecord,
  ): Promise<ChatRuntimeConnection> {
    const existing = this.runtime.getConversationConnection(conversation.id);
    if (
      existing &&
      !existing.disposed &&
      existing.connection === 'connected' &&
      !existing.process.hasExited
    ) {
      return existing;
    }
    const parent = await this.runtime.ensureConnection(conversation.serviceId);
    if (parent.connection !== 'connected') {
      throw new Error(parent.connectionMessage ?? '模型服务未连接。');
    }
    return this.runtime.ensureConversationConnection({
      conversationId: conversation.id,
      serviceId: conversation.serviceId,
      serviceName: conversation.serviceName ?? parent.serviceName,
      kind: parent.kind,
      models: parent.models,
      defaultModelId: parent.defaultModelId,
      accountIdentityHash: parent.accountIdentityHash,
      environmentFingerprint: null,
    });
  }

  private async ensureThread(
    conversation: ChatConversationRecord,
    connection: ChatRuntimeConnection,
    projectRoot: string,
    model: { modelId: string },
    toolboxContext: ToolboxExecutionContext | null,
    submittedPermissionId: string,
    effortId: string,
  ): Promise<string> {
    const permissionId = isChatPermissionId(submittedPermissionId)
      ? submittedPermissionId
      : CHAT_READ_ONLY_PERMISSION;
    const policy = chatSandboxPolicy(permissionId, projectRoot);
    // Tool shells receive an explicit environment and never inherit the
    // Codex process environment (which carries the service credential).
    const shellEnvironment = toolboxContext?.shellEnvironment ??
      buildShellEnvironmentBase({
        CHATFGM_PROJECT_ROOT: projectRoot,
      });
    const threadConfig: Record<string, unknown> = {
      shell_environment_policy:
        buildToolShellEnvironmentPolicy(shellEnvironment),
    };
    const threadExtras: Record<string, unknown> = {
      config: threadConfig,
      ...(toolboxContext
        ? { developerInstructions: toolboxContext.developerInstructions }
        : {}),
    };
    if (conversation.threadId) {
      try {
        const resumed = await connection.process.resumeThread({
          threadId: conversation.threadId,
          cwd: projectRoot,
          model: model.modelId,
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          excludeTurns: true,
          ...threadExtras,
        });
        const resumedThread = objectRecord(resumed.thread);
        if (
          typeof resumedThread.id === 'string' &&
          resumedThread.id !== conversation.threadId
        ) {
          throw new Error(
            'Codex thread/resume 返回了不同 thread，已拒绝替换历史。',
          );
        }
      } catch (error) {
        throw new PreSendError(
          `无法恢复原对话，历史已保留：${errorMessage(error)}`,
        );
      }
      if (toolboxContext) {
        await this.refreshThreadDeveloperInstructions(
          connection,
          conversation.threadId,
          toolboxContext.developerInstructions,
          model.modelId,
          effortId,
        );
      }
      return conversation.threadId;
    }
    const account =
      connection.kind === 'chatgpt'
        ? await connection.process.readAccount().catch(() => null)
        : null;
    if (connection.kind === 'chatgpt') {
      if (account?.type !== 'chatgpt' || !account.email) {
        throw new PreSendError(
          '无法确认 ChatGPT 账号身份，已限制建立新对话。',
        );
      }
    }
    let started: Record<string, unknown>;
    try {
      started = await connection.process.startThread({
        model: model.modelId,
        cwd: projectRoot,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ephemeral: false,
        ...threadExtras,
        ...(connection.kind === 'api'
          ? { modelProvider: 'deepseek' }
          : {}),
      });
    } catch (error) {
      throw new PreSendError(
        `无法创建 Codex thread，未发送：${errorMessage(error)}`,
      );
    }
    const thread = objectRecord(started.thread);
    const threadId = typeof thread.id === 'string' ? thread.id : '';
    if (!threadId) {
      throw new PreSendError('对话创建回执无效，未发送。');
    }
    const identity =
      connection.kind === 'chatgpt' && account?.type === 'chatgpt'
        ? chatGptAccountHash({
            status: 'logged-in',
            ...(account.email ? { email: account.email } : {}),
          })
        : null;
    this.store.updateConversation(conversation.id, {
      threadId,
      ...(identity ? { accountIdentityHash: identity } : {}),
      ...(connection.serviceName
        ? { serviceName: connection.serviceName }
        : {}),
      historyStatus: 'ready',
      historyError: null,
    });
    this.threadIndex.set(threadId, conversation.id);
    this.replayThreadEvents(threadId);
    return threadId;
  }

  private replayThreadEvents(threadId: string): void {
    const buffered = this.orphanEvents.get(threadId);
    if (!buffered || buffered.length === 0) return;
    this.orphanEvents.delete(threadId);
    for (const entry of buffered) {
      this.handleNotification(entry.connection, entry.notification);
    }
  }

  private async buildSubmissionContent(
    input: SendChatMessageInput,
    conversation: ChatConversationRecord,
    supportsImage: boolean,
  ): Promise<{ composedText: string; imagePaths: string[] }> {
    const sections: string[] = [];
    if (input.text.trim()) sections.push(input.text);
    const imagePaths: string[] = [];
    let attachmentCount = 0;
    for (const reference of input.references) {
      if (reference.kind === 'attachment') {
        if (!reference.attachmentId) {
          throw new PreSendError(`附件引用「${reference.name}」无效。`);
        }
        const record = this.attachments.get(
          conversation.projectId,
          reference.attachmentId,
        );
        if (!record || record.conversationId !== conversation.id) {
          throw new PreSendError(
            `附件「${reference.name}」不存在或不属于当前对话，未发送。`,
          );
        }
        attachmentCount += 1;
        if (attachmentCount > CHAT_LIMITS.attachmentsPerMessage) {
          throw new PreSendError(
            `附件数量超过 ${CHAT_LIMITS.attachmentsPerMessage} 个上限，未发送。`,
          );
        }
        if (record.mime.startsWith('image/')) {
          if (!supportsImage) {
            throw new PreSendError(
              '当前模型不支持图像输入，已保留图片引用和草稿。',
            );
          }
          const image = this.attachments.getImagePath(record);
          imagePaths.push(image.path);
        } else {
          const content = this.attachments.getText(record);
          sections.push(
            `--- 用户附件：${record.originalName}（${record.mime}，${record.byteSize} 字节）---\n${content}\n--- 附件结束 ---`,
          );
        }
        continue;
      }
      if (reference.kind === 'file') {
        if (!reference.fileIdentity) {
          throw new PreSendError(`文件引用「${reference.name}」无效。`);
        }
        // A project file reference is handed to the Agent as a path. The
        // workbench validates the project, identity, real path and read
        // permission, but never decodes the file as text: images, HDF5 files
        // and other formats are for the Agent's own tools to read or view.
        let file;
        try {
          file = this.projectService.resolveFileEntry(
            conversation.projectId,
            reference.fileIdentity,
          );
        } catch (error) {
          throw new PreSendError(
            `文件引用「${reference.name}」已失效：${errorMessage(error)}`,
          );
        }
        // Windows' fs.access(R_OK) only checks existence, not the ACL, so the
        // read permission probe opens the real file and closes it again. No
        // bytes are read and the file is never decoded here.
        let size: number;
        try {
          const descriptor = openSync(file.absolute, 'r');
          try {
            size = fstatSync(descriptor).size;
          } finally {
            closeSync(descriptor);
          }
        } catch (error) {
          throw new PreSendError(
            `项目文件「${reference.name}」不可访问：${errorMessage(error)}`,
          );
        }
        sections.push(
          [
            `--- 项目文件引用：${file.entry.relativePath} ---`,
            `绝对路径：${file.absolute}`,
            `大小：${size} 字节`,
            '说明：此处只提供文件路径，未预读或转换内容；如何读取、查看或分析该文件由你按任务决定。',
            '--- 项目文件引用结束 ---',
          ].join('\n'),
        );
        continue;
      }
      if (!reference.directoryId) {
        throw new PreSendError(`目录引用「${reference.name}」无效。`);
      }
      let entries;
      let directory;
      try {
        directory = this.projectService.describeEntry(
          conversation.projectId,
          reference.directoryId,
        );
        entries = this.projectService.listDirectoryEntries(
          conversation.projectId,
          reference.directoryId,
          CHAT_LIMITS.directoryEntries,
        );
      } catch (error) {
        throw new PreSendError(
          `目录引用「${reference.name}」已失效：${errorMessage(error)}`,
        );
      }
      if (directory.kind !== 'folder') {
        throw new PreSendError(`目录引用「${reference.name}」不是文件夹。`);
      }
      const lines = entries.map(
        (entry) => `- ${entry.kind === 'folder' ? '[目录]' : '[文件]'} ${entry.name}`,
      );
      const listing = lines.join('\n');
      if (utf8Bytes(listing) > CHAT_LIMITS.directoryListBytes) {
        throw new PreSendError(
          `目录引用「${reference.name}」的清单超过 ${CHAT_LIMITS.directoryListBytes} 字节上限，未发送。`,
        );
      }
      sections.push(
        `--- 项目目录：${directory.relativePath}（仅直接子项${entries.length >= CHAT_LIMITS.directoryEntries ? `，最多 ${CHAT_LIMITS.directoryEntries} 项` : ''}）---\n${listing || '（空目录）'}\n--- 目录结束 ---`,
      );
    }
    const composedText = sections.join('\n\n');
    if (
      utf8Bytes(composedText) > CHAT_LIMITS.composedTextBytes
    ) {
      throw new PreSendError(
        `组合后的发送内容超过 ${CHAT_LIMITS.composedTextBytes} 字节上限，未发送。`,
      );
    }
    return { composedText, imagePaths };
  }

  private async reconcileSubmission(
    conversation: ChatConversationRecord,
    submission: ChatSubmissionRecord,
  ): Promise<ChatSendResult | null> {
    if (!conversation.threadId) {
      this.store.updateSubmission(
        submission.projectId,
        submission.conversationId,
        submission.submissionId,
        {
          stage: 'not-sent',
          verification: 'no-thread',
        },
      );
      return null;
    }
    try {
      const history = await this.withExecutionLock(
        conversation.id,
        async () => {
          const connection = await this.ensureHistoryConnection(conversation);
          await this.verifyAccount(connection, conversation);
          return this.readHistory(connection, conversation.threadId!);
        },
      );
      await this.mergeHistory(conversation, history.turns);
      const refreshed = this.store.getSubmission(
        submission.projectId,
        submission.conversationId,
        submission.submissionId,
      );
      if (
        refreshed &&
        (refreshed.stage === 'accepted' ||
          refreshed.stage === 'finished')
      ) {
        const receipt = this.receiptForSubmission(refreshed);
        if (receipt) return { status: 'success', value: receipt };
      }
      for (const turn of history.turns) {
        const userItem = turn.items.find(
          (item) => item.type === 'userMessage',
        );
        if (userItem?.clientId === submission.submissionId) {
          const receipt = this.receiptForSubmission(refreshed ?? submission);
          if (receipt) return { status: 'success', value: receipt };
        }
      }
      return null;
    } catch (error) {
      this.logger.warn('chat-submission-reconcile-failed', {
        message: errorMessage(error).slice(0, 200),
      });
      return null;
    }
  }

  private receiptForSubmission(
    submission: ChatSubmissionRecord,
  ): ChatSendReceipt | null {
    const run =
      (submission.runId
        ? this.store.getRun(submission.runId)
        : null) ??
      this.store.getRunBySubmission(
        submission.conversationId,
        submission.submissionId,
      );
    const conversation = this.store.getConversationById(
      submission.conversationId,
    );
    if (!run || !conversation) return null;
    let message = submission.userMessageId
      ? this.store.getMessage(submission.userMessageId)
      : null;
    if (!message) {
      message = this.store
        .listMessages(conversation.id)
        .find(
          (candidate) =>
            candidate.role === 'user' &&
            (candidate.submissionId === submission.submissionId ||
              candidate.turnId === run.turnId),
        ) ?? null;
    }
    if (!message) return null;
    return {
      submissionId: submission.submissionId,
      userMessage: publicMessageFromRecord(message),
      stateRevision: conversation.stateRevision,
      run: publicRunFromRecord(run),
      summary: this.store.summary(conversation),
    };
  }

  private async readHistory(
    connection: ChatRuntimeConnection,
    threadId: string,
  ): Promise<HistoryResult> {
    // History reads use the paginated read-only APIs only. thread/resume or
    // thread/read can attach/cancel an active thread; list/turns/list and
    // items/list observe it without changing ownership or configuration.
    const thread: Record<string, unknown> = {
      id: threadId,
      historyMode: 'paginated',
    };
    const historyMode =
      typeof thread.historyMode === 'string' ? thread.historyMode : '';
    const turns: HistoryTurn[] = [];
    let itemCount = 0;
    let jsonBytes = 0;
    const pushTurn = (
      turnValue: unknown,
      itemEntries?: Array<{
        item: Record<string, unknown>;
        startedAtMs: number | null;
        completedAtMs: number | null;
      }>,
    ): void => {
      const turn = objectRecord(turnValue);
      const id = typeof turn.id === 'string' ? turn.id : '';
      if (!id) throw new Error('Codex 历史中的 turn 缺少 id。');
      if (turns.some((existing) => existing.id === id)) return;
      if (turns.length >= CHAT_LIMITS.historyTurns) {
        throw new Error(
          `历史 turn 数量超过 ${CHAT_LIMITS.historyTurns} 页上限，未读取更多内容。`,
        );
      }
      const items: Array<Record<string, unknown>> = [];
      const itemTimes: HistoryTurn['itemTimes'] = [];
      const rawItems = Array.isArray(turn.items) ? turn.items : [];
      if (itemEntries) {
        for (const entry of itemEntries) {
          items.push(entry.item);
          itemTimes.push({
            startedAtMs: entry.startedAtMs,
            completedAtMs: entry.completedAtMs,
          });
        }
      } else {
        for (const value of rawItems) {
          if (!value || typeof value !== 'object') continue;
          items.push(value as Record<string, unknown>);
          itemTimes.push({ startedAtMs: null, completedAtMs: null });
        }
      }
      itemCount += items.length;
      if (itemCount > CHAT_LIMITS.historyItems) {
        throw new Error(
          `历史 item 数量超过 ${CHAT_LIMITS.historyItems} 上限，未读取更多内容。`,
        );
      }
      jsonBytes += utf8Bytes(JSON.stringify(turnValue));
      if (jsonBytes > CHAT_LIMITS.historyJsonBytes) {
        throw new Error(
          `历史记录超过 ${CHAT_LIMITS.historyJsonBytes} 字节上限，未读取更多内容。`,
        );
      }
      turns.push({
        id,
        status: typeof turn.status === 'string' ? turn.status : 'unknown',
        startedAt: numberOrNull(turn.startedAt),
        completedAt: numberOrNull(turn.completedAt),
        error:
          turn.error && typeof turn.error === 'object'
            ? (turn.error as Record<string, unknown>)
            : null,
        items,
        itemTimes,
      });
    };

    if (historyMode === 'paginated') {
      let cursor: string | null = null;
      const turnCursors = new Set<string>();
      let turnPages = 0;
      let itemPages = 0;
      const accountPage = (page: unknown): void => {
        jsonBytes += utf8Bytes(JSON.stringify(page));
        if (jsonBytes > CHAT_LIMITS.historyJsonBytes) {
          throw new Error(`历史记录超过 ${CHAT_LIMITS.historyJsonBytes} 字节上限，未读取更多内容。`);
        }
      };
      const nextCursor = (value: unknown, seen: Set<string>): string | null => {
        if (typeof value !== 'string' || !value) return null;
        if (seen.has(value)) throw new Error('历史分页游标重复，已停止读取；请稍后重试。');
        seen.add(value);
        return value;
      };
      do {
        if (++turnPages > CHAT_LIMITS.historyTurns) {
          throw new Error('历史 turn 分页数量超过上限，已停止读取。');
        }
        const page = await connection.process.listThreadTurns({
          threadId,
          ...(cursor ? { cursor } : {}),
          limit: TURN_PAGE_SIZE,
          sortDirection: 'asc',
          itemsView: 'summary',
        });
        accountPage(page);
        const data = Array.isArray(page.data) ? page.data : [];
        for (const turn of data) pushTurn(turn);
        cursor = nextCursor(page.nextCursor, turnCursors);
      } while (cursor);
      for (const turn of turns) {
        let itemCursor: string | null = null;
        const itemCursors = new Set<string>();
        const entries: Array<{
          item: Record<string, unknown>;
          startedAtMs: number | null;
          completedAtMs: number | null;
        }> = [];
        do {
          if (++itemPages > CHAT_LIMITS.historyItems) {
            throw new Error('历史 item 分页数量超过上限，已停止读取。');
          }
          const page = await connection.process.listThreadItems({
            threadId,
            turnId: turn.id,
            ...(itemCursor ? { cursor: itemCursor } : {}),
            limit: ITEM_PAGE_SIZE,
            sortDirection: 'asc',
          });
          accountPage(page);
          const data = Array.isArray(page.data) ? page.data : [];
          itemCount += data.length;
          if (itemCount > CHAT_LIMITS.historyItems) {
            throw new Error(`历史 item 数量超过 ${CHAT_LIMITS.historyItems} 上限，未读取更多内容。`);
          }
          for (const value of data) {
            const entry = objectRecord(value);
            const item = objectRecord(entry.item);
            if (!item.type) continue;
            entries.push({
              item,
              startedAtMs: numberOrNull(entry.startedAtMs),
              completedAtMs: numberOrNull(entry.completedAtMs),
            });
          }
          itemCursor = nextCursor(page.nextCursor, itemCursors);
        } while (itemCursor);
        turn.items = entries.map((entry) => entry.item);
        turn.itemTimes = entries.map((entry) => ({
          startedAtMs: entry.startedAtMs,
          completedAtMs: entry.completedAtMs,
        }));
      }
      return { turns, thread };
    }

    if (Array.isArray(thread.turns) && thread.turns.length > 0) {
      for (const turn of thread.turns) pushTurn(turn);
      return { turns, thread };
    }
    // Older or unrecognized history mode: fall back to the paginated API.
    let cursor: string | null = null;
    do {
      const page = await connection.process.listThreadTurns({
        threadId,
        ...(cursor ? { cursor } : {}),
        limit: TURN_PAGE_SIZE,
        sortDirection: 'asc',
        itemsView: 'summary',
      });
      const data = Array.isArray(page.data) ? page.data : [];
      for (const turn of data) pushTurn(turn);
      cursor =
        typeof page.nextCursor === 'string' ? page.nextCursor : null;
    } while (cursor);
    for (const turn of turns) {
      let itemCursor: string | null = null;
      turn.items = [];
      turn.itemTimes = [];
      do {
        const page = await connection.process.listThreadItems({
          threadId,
          turnId: turn.id,
          ...(itemCursor ? { cursor: itemCursor } : {}),
          limit: ITEM_PAGE_SIZE,
          sortDirection: 'asc',
        });
        const data = Array.isArray(page.data) ? page.data : [];
        for (const value of data) {
          const entry = objectRecord(value);
          const item = objectRecord(entry.item);
          if (!item.type) continue;
          turn.items.push(item);
          turn.itemTimes.push({
            startedAtMs: numberOrNull(entry.startedAtMs),
            completedAtMs: numberOrNull(entry.completedAtMs),
          });
        }
        itemCursor =
          typeof page.nextCursor === 'string' ? page.nextCursor : null;
      } while (itemCursor);
      jsonBytes += utf8Bytes(JSON.stringify(turn.items));
      if (jsonBytes > CHAT_LIMITS.historyJsonBytes) {
        throw new Error(
          `历史记录超过 ${CHAT_LIMITS.historyJsonBytes} 字节上限，未读取更多内容。`,
        );
      }
      if (
        turn.items.length > CHAT_LIMITS.historyItems ||
        turns.reduce((sum, value) => sum + value.items.length, 0) >
          CHAT_LIMITS.historyItems
      ) {
        throw new Error(
          `历史 item 数量超过 ${CHAT_LIMITS.historyItems} 上限，未读取更多内容。`,
        );
      }
    }
    return { turns, thread };
  }

  private async mergeHistory(
    conversation: ChatConversationRecord,
    turns: readonly HistoryTurn[],
  ): Promise<void> {
    await this.withConversationLock(conversation.id, async () => {
      const existingMessages = new Map(
        this.store
          .listMessages(conversation.id)
          .map((message) => [message.id, message]),
      );
      const existingRuns = new Map(
        this.store
          .listRuns(conversation.id)
          .map((run) => [run.id, run]),
      );
      for (const [turnIndex, turn] of turns.entries()) {
        const userEntry = turn.items.find(
          (item) => item.type === 'userMessage',
        );
        const clientId =
          userEntry && typeof userEntry.clientId === 'string'
            ? userEntry.clientId
            : null;
        const submission = clientId
          ? this.store.getSubmission(
              conversation.projectId,
              conversation.id,
              clientId,
            )
          : this.store.getSubmissionByThreadTurn(
              conversation.threadId ?? '',
              turn.id,
            );
        const existingUserByTurn = [...existingMessages.values()].find(
          (message) =>
            message.turnId === turn.id && message.role === 'user',
        );
        const userText =
          submission?.input.text ||
          contentText(userEntry?.content) ||
          existingUserByTurn?.text ||
          '';
        const userMessageId =
          submission
            ? `user:${submission.submissionId}`
            : existingUserByTurn?.id ?? `user:${turn.id}`;
        const orderBase = turnIndex * 1_000_000;
        const startedMs =
          timestampMs(turn.startedAt) ??
          existingUserByTurn?.createdAt ??
          Date.now();
        const userReferences =
          submission?.input.references ??
          existingUserByTurn?.references ??
          [];
        const userChanged =
          !existingUserByTurn ||
          existingUserByTurn.text !== userText ||
          !referencesEqual(existingUserByTurn.references, userReferences);
        const userMessage: ChatMessageRecord = {
          id: userMessageId,
          conversationId: conversation.id,
          projectId: conversation.projectId,
          role: 'user',
          text: userText,
          format: 'text',
          order: orderBase + 1,
          createdAt: startedMs,
          revision: existingUserByTurn
            ? userChanged
              ? existingUserByTurn.revision + 1
              : existingUserByTurn.revision
            : 1,
          references: [...userReferences],
          runId: turn.id,
          turnId: turn.id,
          itemId:
            userEntry && typeof userEntry.id === 'string'
              ? userEntry.id
              : existingUserByTurn?.itemId ?? null,
          submissionId: submission?.submissionId ?? null,
        };
        this.mergeMessage(existingMessages, userMessage);

        const runStatus = mapTurnStatus(turn.status, false);
        const historyTools = turn.items
          .map((item) => this.toolCallFromItem(item))
          .filter((tool): tool is ChatToolCall => Boolean(tool));
        const existingRun = existingRuns.get(turn.id);
        const live = existingRun
          ? this.isRunLive(existingRun, conversation)
          : false;
        const executionUnsettled =
          existingRun?.status === 'unknown' &&
          /执行链|执行会话|最终文件同步|停止未完成/.test(
            existingRun.summary ?? '',
          );
        const effectiveStatus =
          existingRun && isTerminalStatus(existingRun.status)
            ? existingRun.status
            : executionUnsettled
              ? 'unknown'
              : turn.status === 'inProgress'
                ? live
                  ? 'running'
                  : 'unknown'
                : runStatus;
        const runTools = settleToolStatuses(
          historyTools.length > 0
            ? historyTools
            : existingRun?.tools ?? [],
          effectiveStatus,
        );
        // A terminal turn proves the run ended, but does not prove that an
        // incomplete historical tool item succeeded. Remove only our stale
        // restart notice; preserve real execution and persistence failures.
        const previousSummary =
          isTerminalStatus(effectiveStatus) &&
          (existingRun?.summary === '应用已重新启动，执行状态待核实。' ||
            existingRun?.summary === '应用重新启动后执行状态待核实。')
            ? null
            : existingRun?.summary ?? null;
        const runSteps = existingRun?.steps ?? null;
        const errorMessageText = codexErrorText(
          objectRecord(turn.error),
        );
        const run: ChatRunRecord = {
          id: turn.id,
          conversationId: conversation.id,
          projectId: conversation.projectId,
          submissionId:
            submission?.submissionId ?? `history:${turn.id}`,
          turnId: turn.id,
          status: effectiveStatus,
          revision: Math.max(1, (existingRun?.revision ?? 0) + 1),
          settings: submission
            ? runSettingsFromInput(
                submission.input,
                conversation.serviceId,
                conversation.serviceName ?? undefined,
              )
            : existingRun?.settings ?? historyRunSettings(conversation),
          startedAt: timestampMs(turn.startedAt) ?? existingRun?.startedAt ?? null,
          finishedAt:
            timestampMs(turn.completedAt) ?? existingRun?.finishedAt ?? null,
          summary:
            errorMessageText ??
            (executionUnsettled
              ? existingRun?.summary ?? null
              : effectiveStatus === 'unknown'
                ? '应用重新启动后执行状态待核实。'
                : previousSummary),
          tools: runTools,
          steps: runSteps,
          lastError: errorMessageText ?? existingRun?.lastError ?? null,
          runtimeInstanceId: existingRun?.runtimeInstanceId ?? null,
          execution: existingRun?.execution ?? null,
          createdAt: existingRun?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const changed =
          !existingRun ||
          existingRun.status !== run.status ||
          existingRun.finishedAt !== run.finishedAt ||
          existingRun.summary !== run.summary ||
          JSON.stringify(existingRun.tools) !== JSON.stringify(run.tools);
        if (changed) {
          if (this.store.upsertRun(run)) {
            existingRuns.set(run.id, run);
            this.publishRun(run);
          }
        }
        if (isTerminalStatus(effectiveStatus)) {
          this.runConnections.delete(turn.id);
        }

        let itemIndex = 1;
        for (const [index, item] of turn.items.entries()) {
          if (item.type !== 'agentMessage') continue;
          const itemId = typeof item.id === 'string' ? item.id : '';
          if (!itemId) continue;
          const text = typeof item.text === 'string' ? item.text : '';
          const messageId = `assistant:${itemId}`;
          const existing = existingMessages.get(messageId);
          const itemTimes = turn.itemTimes[index];
          const message: ChatMessageRecord = {
            id: messageId,
            conversationId: conversation.id,
            projectId: conversation.projectId,
            role: 'assistant',
            text,
            format: 'markdown',
            order: orderBase + 10 + itemIndex,
            createdAt:
              itemTimes?.startedAtMs ??
              itemTimes?.completedAtMs ??
              startedMs + 1,
            revision: existing
              ? existing.text === text
                ? existing.revision
                : existing.revision + 1
              : 1,
            references: existing?.references ?? [],
            runId: turn.id,
            turnId: turn.id,
            itemId,
            submissionId: submission?.submissionId ?? null,
          };
          itemIndex += 1;
          this.mergeMessage(existingMessages, message);
        }

        if (submission) {
          const stage = isTerminalStatus(effectiveStatus)
            ? 'finished'
            : submission.stage === 'unknown' ||
                submission.stage === 'sending'
              ? submission.stage
              : 'accepted';
          this.store.updateSubmission(
            submission.projectId,
            submission.conversationId,
            submission.submissionId,
            {
              stage:
                submission.stage === 'finished' ? 'finished' : stage,
              threadId: conversation.threadId,
              turnId: turn.id,
              userMessageId,
              runId: turn.id,
              verification: 'history-confirmed',
            },
          );
          this.store.clearSubmittedDraftIfUnchanged(
            conversation.id,
            submission.input,
          );
        }
      }
    });
  }

  private mergeMessage(
    existing: Map<string, ChatMessageRecord>,
    message: ChatMessageRecord,
  ): void {
    const current = existing.get(message.id);
    if (
      current &&
      current.text === message.text &&
      current.revision === message.revision &&
      referencesEqual(current.references, message.references) &&
      current.order === message.order
    ) {
      return;
    }
    if (this.store.upsertMessage(message)) {
      const saved = this.store.getMessage(message.id);
      if (saved) {
        existing.set(message.id, saved);
        this.publishMessage(saved);
        const live = this.liveMessages.get(message.id);
        if (live && live.record.text === saved.text) {
          if (live.timer) clearTimeout(live.timer);
          this.liveMessages.delete(message.id);
          if (live.failed) {
            this.clearMessagePersistenceFailure(
              live.record.turnId ?? '',
              live.error,
            );
          }
        }
      }
    }
  }

  private toolCallFromItem(
    item: Record<string, unknown>,
  ): ChatToolCall | null {
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) return null;
    const type = item.type;
    let name: string;
    let summary: string;
    let detail = '';
    let status: ChatToolCall['status'];
    let exitCode: number | undefined;
    if (type === 'commandExecution') {
      name = '命令执行';
      summary = typeof item.command === 'string' ? item.command : '';
      detail =
        typeof item.aggregatedOutput === 'string'
          ? item.aggregatedOutput
          : '';
      const rawExit =
        typeof item.exitCode === 'number'
          ? item.exitCode
          : typeof item.exit_code === 'number'
            ? item.exit_code
            : undefined;
      if (rawExit !== undefined && Number.isSafeInteger(rawExit)) {
        exitCode = rawExit;
      }
      status = mapToolStatus(item.status);
    } else if (type === 'mcpToolCall') {
      name = `${String(item.server ?? 'MCP')}/${String(item.tool ?? '工具')}`;
      summary =
        item.arguments && typeof item.arguments === 'object'
          ? JSON.stringify(item.arguments)
          : '';
      detail =
        item.error && typeof item.error === 'object'
          ? JSON.stringify(item.error)
          : '';
      status = mapToolStatus(item.status);
    } else if (type === 'dynamicToolCall') {
      name = typeof item.tool === 'string' ? item.tool : '动态工具';
      summary =
        item.arguments && typeof item.arguments === 'object'
          ? JSON.stringify(item.arguments)
          : '';
      status = mapToolStatus(item.status);
    } else if (type === 'fileChange') {
      name = '文件修改';
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((change) => {
          const record = objectRecord(change);
          return typeof record.path === 'string' ? record.path : '';
        })
        .filter(Boolean);
      summary =
        paths.length > 0
          ? paths.slice(0, 5).join('、')
          : `${changes.length} 个文件`;
      detail = changes
        .map((change) => {
          const record = objectRecord(change);
          const pathValue =
            typeof record.path === 'string' ? record.path : '';
          const kind =
            record.kind && typeof record.kind === 'object'
              ? objectRecord(record.kind).type
              : record.kind;
          return `${String(kind ?? 'change')}: ${pathValue}`;
        })
        .filter((line) => line.trim().length > 0)
        .join('\n');
      status = mapToolStatus(item.status);
    } else if (type === 'webSearch') {
      name = '网络搜索';
      summary = typeof item.query === 'string' ? item.query : '';
      status = 'completed';
    } else if (type === 'imageView') {
      name = '查看图片';
      summary = typeof item.path === 'string' ? item.path : '';
      status = 'completed';
    } else if (type === 'imageGeneration') {
      name = '图像生成';
      summary = typeof item.result === 'string' ? item.result : '';
      status = mapToolStatus(item.status);
    } else {
      return null;
    }
    if (summary.length > 300) summary = `${summary.slice(0, 300)}…`;
    if (detail.length > MAX_MESSAGE_TOOL_DETAIL) {
      detail = `${detail.slice(0, MAX_MESSAGE_TOOL_DETAIL)}\n…（输出已截断，仅保留前 ${MAX_MESSAGE_TOOL_DETAIL} 字符）`;
    }
    return {
      id,
      name,
      ...(summary ? { summary } : {}),
      ...(detail ? { detail } : {}),
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }

  private async acceptSubmission(
    conversation: ChatConversationRecord,
    submission: ChatSubmissionRecord,
    turnId: string,
    turnStatus: string,
    startedAtMs: number | null,
    connectionGeneration?: number,
    execution?: ChatRunExecution,
  ): Promise<ChatSendReceipt> {
    const key = submission.submissionId;
    const existing = this.accepting.get(key);
    if (existing) return existing;
    const promise = this.withConversationLock(conversation.id, async () => {
      let run = this.store.getRun(turnId);
      const status = mapTurnStatus(turnStatus, true);
      const now = new Date().toISOString();
      if (!run) {
        run = {
          id: turnId,
          conversationId: conversation.id,
          projectId: conversation.projectId,
          submissionId: submission.submissionId,
          turnId,
          status,
          revision: 1,
          settings: runSettingsFromInput(
            submission.input,
            conversation.serviceId,
            conversation.serviceName ?? undefined,
          ),
          startedAt: startedAtMs ?? Date.now(),
          finishedAt: null,
          summary: null,
          tools: [],
          steps: null,
          lastError: null,
          runtimeInstanceId: this.runtimeInstanceId,
          execution: execution ?? null,
          createdAt: now,
          updatedAt: now,
        };
        if (this.store.upsertRun(run)) {
          this.publishRun(run);
        }
      } else if (
        !run.submissionId ||
        run.submissionId !== submission.submissionId ||
        ((run.status === 'running' || run.status === 'unknown') &&
          status !== 'running')
      ) {
        run = {
          ...run,
          submissionId: submission.submissionId,
          status:
            run.status === 'running' || run.status === 'unknown'
              ? status
              : run.status,
          revision: run.revision + 1,
          finishedAt:
            isTerminalStatus(status) && !run.finishedAt
              ? Date.now()
              : run.finishedAt,
          ...(execution && !run.execution ? { execution } : {}),
          updatedAt: now,
        };
        if (this.store.upsertRun(run)) this.publishRun(run);
      }
      const activeGeneration =
        connectionGeneration ??
        this.runtime.getConversationConnection(conversation.id)?.generation;
      if (!isTerminalStatus(run.status) && activeGeneration !== undefined) {
        const connection = this.runtime.getConversationConnection(
          conversation.id,
        );
        if (connection && connection.generation === activeGeneration) {
          this.rememberRunConnection(run.id, conversation, connection);
        }
      } else if (isTerminalStatus(run.status)) {
        this.runConnections.delete(run.id);
      }
      let userMessage = this.store.getMessage(
        `user:${submission.submissionId}`,
      );
      if (!userMessage) {
        userMessage = {
          id: `user:${submission.submissionId}`,
          conversationId: conversation.id,
          projectId: conversation.projectId,
          role: 'user',
          text: submission.input.text,
          format: 'text',
          order: this.store.nextMessageOrder(conversation.id),
          createdAt: Date.now(),
          revision: 1,
          references: [...submission.input.references],
          runId: run.id,
          turnId,
          itemId: null,
          submissionId: submission.submissionId,
        };
        if (this.store.upsertMessage(userMessage)) {
          this.publishMessage(userMessage);
        }
      }
      if (!userMessage) {
        throw new ChatStoreError(
          'chat-save-failed',
          '无法建立本次提交的用户消息记录。',
        );
      }
      this.store.updateSubmission(
        submission.projectId,
        submission.conversationId,
        submission.submissionId,
        {
          stage: isTerminalStatus(status) ? 'finished' : 'accepted',
          threadId: conversation.threadId,
          turnId,
          userMessageId: userMessage.id,
          runId: run.id,
          verification: 'accepted',
        },
      );
      this.store.clearSubmittedDraftIfUnchanged(
        conversation.id,
        submission.input,
      );
      let updatedConversation = this.store.getConversationById(
        conversation.id,
      ) ?? conversation;
      if (
        updatedConversation.title === '新对话' ||
        updatedConversation.title.trim() === ''
      ) {
        updatedConversation = this.store.updateConversation(
          conversation.id,
          { title: titleFromInput(submission.input) },
        );
        this.publishSummary(updatedConversation);
      }
      const savedRun = this.store.getRun(run.id) ?? run;
      const savedMessage =
        this.store.getMessage(userMessage.id) ?? userMessage;
      return {
        submissionId: submission.submissionId,
        userMessage: publicMessageFromRecord(savedMessage),
        stateRevision: updatedConversation.stateRevision,
        run: publicRunFromRecord(savedRun),
        summary: this.store.summary(updatedConversation),
      };
    });
    this.accepting.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.accepting.get(key) === promise) this.accepting.delete(key);
    }
  }

  private handleServerRequestResolved(
    connection: ChatRuntimeConnection,
    resolved: import('../settings/codex').CodexServerRequestResolved,
  ): void {
    let approvalId: string | null = null;
    for (const [id, entry] of this.pendingApprovals) {
      if (entry.request.key !== resolved.key) continue;
      if (
        entry.serviceId !== connection.serviceId ||
        entry.generation !== connection.generation
      ) {
        return;
      }
      approvalId = id;
      break;
    }
    if (!approvalId) return;
    this.pendingApprovals.delete(approvalId);
    const record = this.store.getApproval(approvalId);
    if (!record || record.status !== 'pending') return;
    this.store.setApprovalStatus(approvalId, 'expired');
    const conversation = this.store.getConversationById(record.conversationId);
    if (conversation) this.publishApprovals(conversation);
    this.logger.info('chat-approval-resolved-by-runtime', {
      method: resolved.method,
      threadId: resolved.threadId,
    });
  }

  private publishApprovals(conversation: ChatConversationRecord): void {
    this.publish({
      type: 'approvals',
      projectId: conversation.projectId,
      conversationId: conversation.id,
      approvals: this.store
        .listApprovals(conversation.id)
        .map(publicApprovalFromRecord),
    });
  }

  /**
   * Handles every request initiated by app-server. Only the three approval
   * kinds are surfaced to the user; all other current-protocol requests are
   * answered with a legal negative response so app-server never waits.
   */
  private handleServerRequest(
    connection: ChatRuntimeConnection,
    request: CodexServerRequest,
  ): void {
    if (this.disposed) {
      request.reject(-32001, 'Service disposed');
      return;
    }
    if (!request.pending) return;
    const params = objectRecord(request.params);
    if (request.method === 'item/tool/requestUserInput') {
      // Plan-mode questions are not part of the ChatFGM flow. Answering with an
      // empty but valid payload prevents a stable waiting deadlock.
      request.respond({ answers: {} });
      this.logger.info('chat-user-input-auto-empty', {
        serviceId: connection.serviceId,
      });
      return;
    }
    const mapped = approvalPayloadFor(request.method, params);
    if (!mapped) {
      request.reject(-32601, 'Unsupported request');
      this.logger.warn('chat-server-request-unsupported', {
        method: request.method,
        serviceId: connection.serviceId,
      });
      return;
    }
    if (!mapped.supported) {
      const available = Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : [];
      this.refuseApproval(request, mapped.kind, available);
      this.logger.warn('chat-approval-unsupported-permissions', {
        method: request.method,
        serviceId: connection.serviceId,
      });
      return;
    }
    const requestItemId =
      typeof params.itemId === 'string' ? params.itemId : '';
    if (
      mapped.kind === 'file-change' &&
      requestItemId &&
      !mapped.payload.paths?.length
    ) {
      const paths = this.fileChangePaths.get(requestItemId);
      if (paths?.paths.length) mapped.payload.paths = [...paths.paths];
    }
    const threadId =
      typeof params.threadId === 'string' ? params.threadId : '';
    const turnId =
      typeof params.turnId === 'string'
        ? params.turnId
        : typeof params.turnId === 'number'
          ? String(params.turnId)
          : '';
    const itemId = typeof params.itemId === 'string' ? params.itemId : null;
    const conversationId = threadId
      ? this.threadIndex.get(threadId)
      : undefined;
    const conversation = conversationId
      ? this.store.getConversationById(conversationId)
      : threadId
        ? this.store.getConversationByThread(threadId)
        : null;
    if (
      !conversation ||
      conversation.serviceId !== connection.serviceId ||
      !turnId
    ) {
      this.refuseApproval(request, mapped.kind);
      this.logger.warn('chat-approval-unowned', {
        method: request.method,
        serviceId: connection.serviceId,
      });
      return;
    }
    const run = this.store.getRun(turnId);
    if (
      !run ||
      run.conversationId !== conversation.id ||
      isTerminalStatus(run.status)
    ) {
      this.refuseApproval(request, mapped.kind);
      return;
    }
    let record: ChatApprovalRecord;
    try {
      record = this.store.insertApproval({
        id: randomUUID(),
        projectId: conversation.projectId,
        conversationId: conversation.id,
        runId: turnId,
        turnId,
        threadId: threadId || null,
        itemId,
        method: request.method,
        kind: mapped.kind,
        requestKey: request.key,
        payload: mapped.payload,
        runtimeInstanceId: this.runtimeInstanceId,
        connectionGeneration: connection.generation,
        createdAt: Date.now(),
      });
    } catch (error) {
      this.refuseApproval(request, mapped.kind);
      this.logAsyncFailure('chat-approval-save-failed', error);
      return;
    }
    this.pendingApprovals.set(record.id, {
      request,
      serviceId: connection.serviceId,
      generation: connection.generation,
    });
    if (!isTerminalStatus(run.status)) {
      this.rememberRunConnection(run.id, conversation, connection);
    }
    this.publishApprovals(conversation);
  }

  private refuseApproval(
    request: CodexServerRequest,
    kind: 'command' | 'file-change' | 'permissions',
    availableDecisions?: readonly unknown[],
  ): void {
    if (kind === 'permissions') {
      request.respond({ permissions: {}, scope: 'turn' });
    } else {
      request.respond({
        decision: availableDecisions?.includes('decline')
          ? 'decline'
          : 'cancel',
      });
    }
  }

  async respondApproval(input: RespondChatApprovalInput): Promise<void> {
    this.assertProject(input.projectId);
    const conversation = this.requireConversation(
      input.projectId,
      input.conversationId,
    );
    if (typeof input.approvalId !== 'string' || !input.approvalId) {
      throw new ChatStoreError('chat-invalid-input', '审批标识无效。');
    }
    if (input.decision !== 'approve' && input.decision !== 'deny') {
      throw new ChatStoreError('chat-invalid-input', '审批决定无效。');
    }
    const record = this.store.getApproval(input.approvalId);
    if (!record || record.conversationId !== conversation.id) {
      throw new ChatStoreError(
        'chat-approval-not-found',
        '审批请求不存在或不属于当前对话。',
      );
    }
    if (record.status !== 'pending') {
      throw new ChatStoreError(
        'chat-approval-resolved',
        '审批已处理或失效，无法再次答复。',
      );
    }
    if (
      record.runtimeInstanceId !== this.runtimeInstanceId ||
      record.connectionGeneration === null
    ) {
      this.store.setApprovalStatus(record.id, 'expired');
      this.publishApprovals(conversation);
      throw new ChatStoreError(
        'chat-approval-stale',
        '应用重启或连接替换后，旧审批请求不能再次批准。',
      );
    }
    const pending = this.pendingApprovals.get(record.id);
    const connection = this.runtime.getConversationConnection(conversation.id);
    if (
      !pending ||
      !pending.request.pending ||
      !connection ||
      connection.disposed ||
      connection.connection !== 'connected' ||
      connection.generation !== pending.generation ||
      pending.generation !== record.connectionGeneration
    ) {
      this.pendingApprovals.delete(record.id);
      this.store.setApprovalStatus(record.id, 'expired');
      this.publishApprovals(conversation);
      throw new ChatStoreError(
        'chat-approval-stale',
        '审批请求对应的运行已断开或已失效，不能再次答复。',
      );
    }
    const result = approvalDecisionResult(record, input.decision);
    if (!pending.request.respond(result)) {
      this.pendingApprovals.delete(record.id);
      this.store.setApprovalStatus(record.id, 'expired');
      this.publishApprovals(conversation);
      throw new ChatStoreError(
        'chat-approval-stale',
        '审批请求已由运行层结束，无法再答复。',
      );
    }
    this.pendingApprovals.delete(record.id);
    const updated = this.store.setApprovalStatus(
      record.id,
      input.decision === 'approve' ? 'approved' : 'denied',
    );
    if (!updated) {
      throw new ChatStoreError(
        'chat-approval-stale',
        '审批状态已变化，答复未重复应用。',
      );
    }
    this.publishApprovals(conversation);
  }

  /** Settles any still-open transport request, then marks approvals expired. */
  private expireRunApprovals(
    runId: string,
    status: 'expired' | 'cancelled',
  ): void {
    const pending = this.store
      .listPendingApprovals()
      .filter((record) => record.runId === runId);
    let conversationId: string | null = null;
    for (const record of pending) {
      conversationId = record.conversationId;
      const entry = this.pendingApprovals.get(record.id);
      if (entry?.request.pending) {
        try {
          this.refuseApproval(entry.request, record.kind);
        } catch {
          // The process may already be gone.
        }
      }
      this.pendingApprovals.delete(record.id);
    }
    this.store.expireApprovalsForRun(runId, status);
    for (const [itemId, entry] of this.fileChangePaths) {
      if (entry.turnId === runId) this.fileChangePaths.delete(itemId);
    }
    for (const [itemId, entry] of this.commandOutputs) {
      if (entry.turnId === runId) {
        this.commandOutputs.delete(itemId);
        this.commandOutputWrites.delete(itemId);
      }
    }
    if (conversationId) {
      const conversation = this.store.getConversationById(conversationId);
      if (conversation) this.publishApprovals(conversation);
    }
  }

  private expireAllApprovalsOnDispose(): void {
    for (const record of this.store.listPendingApprovals()) {
      const entry = this.pendingApprovals.get(record.id);
      if (entry?.request.pending) {
        try {
          this.refuseApproval(entry.request, record.kind);
        } catch {
          // Process disposal is already in progress.
        }
      }
      try {
        this.store.setApprovalStatus(record.id, 'cancelled');
      } catch {
        // Preserve the shutdown path.
      }
    }
    this.pendingApprovals.clear();
  }

  /** Marks approvals of a disconnected service as expired. */
  private expireApprovalsForService(serviceId: string): void {
    const affected = new Set<string>();
    for (const record of this.store.listPendingApprovals()) {
      const service = this.store.serviceIdForConversation(
        record.conversationId,
      );
      if (service !== serviceId) continue;
      const entry = this.pendingApprovals.get(record.id);
      if (entry?.request.pending) {
        try {
          this.refuseApproval(entry.request, record.kind);
        } catch {
          // The connection may already be gone.
        }
      }
      this.pendingApprovals.delete(record.id);
      this.store.setApprovalStatus(record.id, 'expired');
      affected.add(record.conversationId);
    }
    for (const conversationId of affected) {
      const conversation = this.store.getConversationById(conversationId);
      if (conversation) this.publishApprovals(conversation);
    }
  }

  private expireApprovalsForConnectionGeneration(generation: number): void {
    const affected = new Set<string>();
    for (const [approvalId, entry] of this.pendingApprovals) {
      if (entry.generation !== generation) continue;
      const record = this.store.getApproval(approvalId);
      if (!record) {
        this.pendingApprovals.delete(approvalId);
        continue;
      }
      if (entry.request.pending) {
        try {
          this.refuseApproval(entry.request, record.kind);
        } catch {
          // The process may already be gone.
        }
      }
      this.pendingApprovals.delete(approvalId);
      this.store.setApprovalStatus(approvalId, 'expired');
      affected.add(record.conversationId);
    }
    for (const conversationId of affected) {
      const conversation = this.store.getConversationById(conversationId);
      if (conversation) this.publishApprovals(conversation);
    }
  }

  private handleNotification(
    connection: ChatRuntimeConnection,
    notification: CodexNotification,
  ): void {
    if (this.disposed) return;
    if (connection.disposed) return;
    const method = notification.method;
    const params = objectRecord(notification.params);
    const threadId =
      typeof params.threadId === 'string' ? params.threadId : '';
    if (!threadId) return;
    const conversationId = this.threadIndex.get(threadId);
    const conversation = conversationId
      ? this.store.getConversationById(conversationId)
      : this.store.getConversationByThread(threadId);
    if (!conversation) {
      if (
        method === 'turn/started' ||
        method === 'turn/completed' ||
        method === 'item/agentMessage/delta' ||
        method === 'item/completed'
      ) {
        const buffer = this.orphanEvents.get(threadId) ?? [];
        if (buffer.length < 1000) {
          buffer.push({ connection, notification });
          this.orphanEvents.set(threadId, buffer);
        }
      }
      return;
    }
    if (conversation.serviceId !== connection.serviceId) {
      // A notification from a replaced/different service instance must never
      // update a conversation owned by another service.
      return;
    }
    this.registerThread(conversation);
    const turn = objectRecord(params.turn);
    const turnId =
      typeof turn.id === 'string'
        ? turn.id
        : typeof params.turnId === 'string'
          ? params.turnId
          : '';
    const knownRun = turnId ? this.store.getRun(turnId) : null;
    if (turnId && (!knownRun || !isTerminalStatus(knownRun.status))) {
      this.rememberRunConnection(turnId, conversation, connection);
    }
    if (
      knownRun &&
      isTerminalStatus(knownRun.status) &&
      (method === 'item/agentMessage/delta' ||
        method === 'item/commandExecution/outputDelta' ||
        method === 'item/started' ||
        method === 'item/completed' ||
        method === 'turn/plan/updated')
    ) {
      // Late streaming/tool events must not reopen a terminal run. A late
      // `error` is still allowed through: recordRunError may enrich a generic
      // reason but never changes the terminal status or appends messages.
      return;
    }
    if (method === 'turn/started') {
      if (!turnId) return;
      const inFlight = this.inFlight.get(conversation.id);
      if (!inFlight || inFlight.accepted) return;
      // A started event may only confirm the submission whose turn/start
      // request was written on the same thread and runtime connection. A late
      // or replayed event from an older task must never rebind this one.
      if (!inFlight.threadId || inFlight.threadId !== threadId) return;
      if (
        inFlight.connectionGeneration !== undefined &&
        connection.generation !== inFlight.connectionGeneration
      ) {
        return;
      }
      const submission = this.store.getSubmission(
        conversation.projectId,
        conversation.id,
        inFlight.submissionId,
      );
      if (!submission) return;
      // The submission is written to "sending" immediately before the
      // turn/start RPC; anything earlier cannot own a server turn.
      if (submission.stage !== 'sending') return;
      if (
        knownRun &&
        (isTerminalStatus(knownRun.status) ||
          knownRun.submissionId !== inFlight.submissionId)
      ) {
        // This turn already belongs to another (or a finished) task. The event
        // is a duplicate or a stale replay; do not reopen or rebind it.
        return;
      }
      inFlight.accepted = true;
      void this.acceptSubmission(
        conversation,
        submission,
        turnId,
        typeof turn.status === 'string' ? turn.status : 'inProgress',
        timestampMs(turn.startedAt),
        connection.generation,
      ).then(
        (receipt) => inFlight.acceptance.resolve(receipt),
        (error) => inFlight.acceptance.reject(error),
      );
      return;
    }
    if (method === 'turn/completed') {
      if (!turnId) return;
      void this.finishTurn(
        conversation,
        turnId,
        typeof turn.status === 'string' ? turn.status : 'completed',
        turn,
        connection,
      ).catch((error) =>
        this.logAsyncFailure('chat-turn-finalize-failed', error),
      );
      return;
    }
    if (method === 'item/agentMessage/delta') {
      if (!turnId || typeof params.itemId !== 'string') return;
      if (typeof params.delta !== 'string' || !params.delta) return;
      this.onAgentDelta(
        conversation,
        turnId,
        params.itemId,
        params.delta,
      );
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (!turnId) return;
      const item = objectRecord(params.item);
      const itemType = item.type;
      if (itemType === 'commandExecution') {
        const itemId = typeof item.id === 'string' ? item.id : '';
        if (itemId) {
          let items = this.runCommandItems.get(turnId);
          if (!items) {
            items = new Set<string>();
            this.runCommandItems.set(turnId, items);
          }
          items.add(itemId);
        }
      }
      if (itemType === 'fileChange') {
        const itemId = typeof item.id === 'string' ? item.id : '';
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes
          .map((change) => {
            const record = objectRecord(change);
            return typeof record.path === 'string' ? record.path : '';
          })
          .filter((pathValue): pathValue is string => Boolean(pathValue));
        if (itemId && paths.length > 0) {
          this.fileChangePaths.set(itemId, {
            turnId,
            paths: paths.slice(0, 20),
          });
        }
      }
      if (itemType === 'agentMessage' && method === 'item/completed') {
        this.onAgentComplete(conversation, turnId, item);
        return;
      }
      const tool = this.toolCallFromItem(item);
      if (tool) {
        void this.upsertTool(conversation, turnId, tool).catch((error) =>
          this.logAsyncFailure('chat-tool-save-failed', error),
        );
      }
      if (
        method === 'item/completed' &&
        (itemType === 'commandExecution' || itemType === 'fileChange')
      ) {
        if (itemType === 'commandExecution') {
          const itemId = typeof item.id === 'string' ? item.id : '';
          if (itemId) {
            this.commandOutputs.delete(itemId);
            this.commandOutputWrites.delete(itemId);
          }
        }
        this.fileSync?.schedule(conversation.projectId);
      }
      return;
    }
    if (method === 'item/commandExecution/outputDelta') {
      if (!turnId) return;
      const itemId =
        typeof params.itemId === 'string' ? params.itemId : '';
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (!itemId || !delta) return;
      this.appendCommandOutput(conversation, turnId, itemId, delta);
      // Long commands may write files while still running. Bounded, coalesced
      // checks keep the tree reasonably current without a request backlog.
      const now = Date.now();
      const last = this.lastFileActivity.get(conversation.projectId) ?? 0;
      if (now - last > 1500) {
        this.lastFileActivity.set(conversation.projectId, now);
        this.fileSync?.schedule(conversation.projectId);
      }
      return;
    }
    if (method === 'turn/plan/updated') {
      if (!turnId) return;
      const plan = Array.isArray(params.plan) ? params.plan : [];
      const steps: ChatStep[] = plan
        .map((value, index) => {
          const step = objectRecord(value);
          const title =
            typeof step.step === 'string' ? step.step.trim() : '';
          if (!title) return null;
          return {
            id: `plan-${index}`,
            title: title.slice(0, 200),
            status: mapPlanStatus(step.status),
            ...(typeof params.explanation === 'string' &&
            params.explanation.trim()
              ? { detail: params.explanation.slice(0, 500) }
              : {}),
          } satisfies ChatStep;
        })
        .filter((step): step is ChatStep => Boolean(step));
      void this.upsertSteps(conversation, turnId, steps).catch((error) =>
        this.logAsyncFailure('chat-plan-save-failed', error),
      );
      return;
    }
    if (method === 'error') {
      if (!turnId) return;
      const error = objectRecord(params.error);
      const message =
        codexErrorText(error) ?? 'Codex 返回了执行错误。';
      if (params.willRetry === true) return;
      void this.recordRunError(conversation, turnId, message).catch(
        (error) => this.logAsyncFailure('chat-run-error-save-failed', error),
      );
      return;
    }
    if (method === 'thread/status/changed') {
      const status = objectRecord(params.status);
      if (status.type === 'systemError') {
        const run = this.store
          .listRuns(conversation.id)
          .filter((candidate) => candidate.status === 'running')
          .at(-1);
        if (run) {
          // A concrete error that arrived first must win over the generic
          // thread status; only fall back when no detail is available.
          const detail =
            this.pendingRunErrors.get(run.id)?.message ??
            this.systemErrorText(status);
          void this.finishTurn(
            conversation,
            run.id,
            'failed',
            {
              id: run.id,
              status: 'failed',
              error: { message: detail },
            },
            connection,
          ).catch((error) =>
            this.logAsyncFailure('chat-thread-error-finalize-failed', error),
          );
        }
      }
    }
  }

  private systemErrorText(status: Record<string, unknown>): string {
    const direct = ['message', 'reason', 'detail'];
    for (const key of direct) {
      if (typeof status[key] === 'string' && status[key].trim()) {
        return sanitizeSummary(status[key].trim());
      }
    }
    const nested = objectRecord(status.error);
    return codexErrorText(nested) ?? GENERIC_SYSTEM_ERROR;
  }

  private onAgentDelta(
    conversation: ChatConversationRecord,
    turnId: string,
    itemId: string,
    delta: string,
  ): void {
    const id = `assistant:${itemId}`;
    let live = this.liveMessages.get(id);
    if (!live) {
      const existing = this.store.getMessage(id);
      if (existing) {
        live = {
          record: existing,
          timer: null,
          dirty: false,
          failed: false,
          error: '',
        };
      } else {
        live = {
          record: {
            id,
            conversationId: conversation.id,
            projectId: conversation.projectId,
            role: 'assistant',
            text: '',
            format: 'markdown',
            order: this.store.nextMessageOrder(conversation.id),
            createdAt: Date.now(),
            revision: 1,
            references: [],
            runId: turnId,
            turnId,
            itemId,
            submissionId: null,
          },
          timer: null,
          dirty: false,
          failed: false,
          error: '',
        };
      }
      this.liveMessages.set(id, live);
    }
    live.record.text += delta;
    live.dirty = true;
    if (live.timer) return;
    live.timer = setTimeout(() => {
      live.timer = null;
      this.flushLiveMessage(id, false);
    }, MESSAGE_FLUSH_MS);
  }

  private onAgentComplete(
    conversation: ChatConversationRecord,
    turnId: string,
    item: Record<string, unknown>,
  ): void {
    const itemId = typeof item.id === 'string' ? item.id : '';
    if (!itemId) return;
    const text = typeof item.text === 'string' ? item.text : '';
    const id = `assistant:${itemId}`;
    const existing = this.store.getMessage(id);
    const live = this.liveMessages.get(id);
    if (
      existing &&
      existing.text === text &&
      existing.runId === turnId &&
      !live?.failed
    ) {
      if (live?.timer) clearTimeout(live.timer);
      this.liveMessages.delete(id);
      return;
    }
    const record: ChatMessageRecord = {
      id,
      conversationId: conversation.id,
      projectId: conversation.projectId,
      role: 'assistant',
      text,
      format: 'markdown',
      order:
        live?.record.order ??
        existing?.order ??
        this.store.nextMessageOrder(conversation.id),
      createdAt:
        live?.record.createdAt ??
        existing?.createdAt ??
        Date.now(),
      revision: Math.max(
        existing?.revision ?? 0,
        live?.record.revision ?? 0,
      ) + 1,
      references: existing?.references ?? [],
      runId: turnId,
      turnId,
      itemId,
      submissionId: existing?.submissionId ?? null,
    };
    if (live?.timer) clearTimeout(live.timer);
    try {
      if (this.store.upsertMessage(record)) {
        const saved = this.store.getMessage(id);
        if (saved) this.publishMessage(saved);
      }
      this.liveMessages.delete(id);
    } catch (error) {
      const message = sanitizeSummary(
        `助手回复写入本地数据库失败：${errorMessage(error)}`,
      );
      if (live) {
        live.record = record;
        live.timer = null;
        live.dirty = true;
        live.failed = true;
        live.error = message;
      } else {
        this.liveMessages.set(id, {
          record,
          timer: null,
          dirty: true,
          failed: true,
          error: message,
        });
      }
      this.reportMessagePersistenceFailure(turnId, message);
      return;
    }
    if (live?.failed) {
      this.clearMessagePersistenceFailure(turnId, live.error);
    }
  }

  private flushLiveMessage(id: string, force: boolean): void {
    const live = this.liveMessages.get(id);
    if (!live) return;
    if (!live.dirty && !force) return;
    const existing = this.store.getMessage(id);
    if (
      existing &&
      existing.text === live.record.text &&
      !force
    ) {
      live.dirty = false;
      return;
    }
    live.record.revision = Math.max(
      live.record.revision,
      existing?.revision ?? 0,
    ) + 1;
    try {
      if (this.store.upsertMessage(live.record)) {
        const saved = this.store.getMessage(id);
        if (saved) this.publishMessage(saved);
      }
      live.dirty = false;
      const previousError = live.error;
      live.failed = false;
      live.error = '';
      if (previousError) {
        this.clearMessagePersistenceFailure(
          live.record.turnId ?? '',
          previousError,
        );
      }
    } catch (error) {
      live.dirty = true;
      live.failed = true;
      live.error = sanitizeSummary(
        `助手回复写入本地数据库失败：${errorMessage(error)}`,
      );
      this.reportMessagePersistenceFailure(
        live.record.turnId ?? '',
        live.error,
      );
    }
  }

  private reportMessagePersistenceFailure(
    turnId: string,
    message: string,
  ): void {
    if (!turnId) return;
    const run = this.store.getRun(turnId);
    if (!run) return;
    const next: ChatRunRecord = {
      ...run,
      summary: message,
      lastError: message,
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    try {
      if (this.store.upsertRun(next)) this.publishRun(next);
    } catch (error) {
      this.logger.warn('chat-run-save-warning-failed', {
        message: errorMessage(error).slice(0, 200),
      });
      this.publishRun(next);
    }
    // The failed live message is intentionally kept; the history read path can
    // persist it after storage recovers without starting another turn.
  }

  private clearMessagePersistenceFailure(
    turnId: string,
    message: string,
  ): void {
    if (!turnId || !message) return;
    const run = this.store.getRun(turnId);
    if (
      !run ||
      (run.summary !== message && run.lastError !== message)
    ) {
      return;
    }
    const next: ChatRunRecord = {
      ...run,
      summary: run.summary === message ? null : run.summary,
      lastError: run.lastError === message ? null : run.lastError,
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    try {
      if (this.store.upsertRun(next)) this.publishRun(next);
    } catch (error) {
      this.logger.warn('chat-run-warning-clear-failed', {
        message: errorMessage(error).slice(0, 200),
      });
    }
  }

  private failedLiveMessages(conversationId: string): LiveMessageState[] {
    return [...this.liveMessages.values()].filter(
      (live) =>
        live.failed && live.record.conversationId === conversationId,
    );
  }

  private flushAllLiveMessages(): void {
    for (const [id, live] of this.liveMessages) {
      if (live.timer) clearTimeout(live.timer);
      live.timer = null;
      this.flushLiveMessage(id, true);
    }
  }

  /**
   * Streams command output into the existing run trace with a hard size bound.
   * Database writes are throttled; the completed item still replaces the
   * detail with the runtime's aggregated output.
   */
  private appendCommandOutput(
    conversation: ChatConversationRecord,
    turnId: string,
    itemId: string,
    delta: string,
  ): void {
    const previous = this.commandOutputs.get(itemId)?.text ?? '';
    let next = previous + delta;
    if (next.length > MAX_COMMAND_OUTPUT) {
      next = `${next.slice(0, MAX_COMMAND_OUTPUT)}\n…（输出已截断，仅保留前 ${MAX_COMMAND_OUTPUT} 字符）`;
    }
    this.commandOutputs.set(itemId, { turnId, text: next });
    const now = Date.now();
    const last = this.commandOutputWrites.get(itemId)?.at ?? 0;
    if (now - last < 250) return;
    this.commandOutputWrites.set(itemId, { turnId, at: now });
    const run = this.store.getRun(turnId);
    const existing = run?.tools.find((tool) => tool.id === itemId);
    const tool: ChatToolCall = {
      id: itemId,
      name: existing?.name ?? '命令执行',
      ...(existing?.summary ? { summary: existing.summary } : {}),
      detail: next,
      status: 'running',
    };
    void this.upsertTool(conversation, turnId, tool).catch((error) =>
      this.logAsyncFailure('chat-command-output-save-failed', error),
    );
  }

  private async upsertTool(
    conversation: ChatConversationRecord,
    turnId: string,
    tool: ChatToolCall,
  ): Promise<void> {
    await this.withConversationLock(conversation.id, async () => {
      let run = this.store.getRun(turnId);
      if (!run) {
        const submission = this.inFlight.get(conversation.id);
        run = {
          id: turnId,
          conversationId: conversation.id,
          projectId: conversation.projectId,
          submissionId: submission?.submissionId ?? null,
          turnId,
          status: 'running',
          revision: 1,
          settings: historyRunSettings(conversation),
          startedAt: Date.now(),
          finishedAt: null,
          summary: null,
          tools: [],
          steps: null,
          lastError: null,
          runtimeInstanceId: this.runtimeInstanceId,
          execution: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      // An already-final tool result is stronger evidence than a delayed
      // output fragment queued before the terminal turn was persisted.
      const previousTool = run.tools.find((item) => item.id === tool.id);
      if (
        isTerminalStatus(run.status) && tool.status === 'running' &&
        (previousTool?.status === 'completed' || previousTool?.status === 'failed')
      ) return;
      const tools = [...run.tools];
      const index = tools.findIndex((item) => item.id === tool.id);
      if (index >= 0) {
        if (
          tools[index]!.status === tool.status &&
          tools[index]!.detail === tool.detail &&
          tools[index]!.summary === tool.summary
        ) {
          return;
        }
        tools[index] = tool;
      } else {
        tools.push(tool);
      }
      const next: ChatRunRecord = {
        ...run,
        tools: settleToolStatuses(tools, run.status),
        revision: run.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (this.store.upsertRun(next)) this.publishRun(next);
    });
  }

  private async upsertSteps(
    conversation: ChatConversationRecord,
    turnId: string,
    steps: ChatStep[],
  ): Promise<void> {
    await this.withConversationLock(conversation.id, async () => {
      const run = this.store.getRun(turnId);
      if (!run) return;
      if (JSON.stringify(run.steps) === JSON.stringify(steps)) return;
      const next: ChatRunRecord = {
        ...run,
        steps,
        revision: run.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (this.store.upsertRun(next)) this.publishRun(next);
    });
  }

  private async recordRunError(
    conversation: ChatConversationRecord,
    turnId: string,
    message: string,
  ): Promise<void> {
    await this.withConversationLock(conversation.id, async () => {
      const run = this.store.getRun(turnId);
      if (!run) {
        // The run row may not exist yet (turn/started has not been accepted).
        // Keep the detail so finalization does not replace it with the generic
        // system-error text.
        this.pendingRunErrors.set(turnId, {
          message,
          updatedAt: Date.now(),
        });
        return;
      }
      if (run.status === 'completed') return;
      const current = run.lastError ?? run.summary;
      if (current === message) return;
      const incomingDetailed = hasDetailedError(message);
      // A generic event may only fill an empty slot; it never replaces a
      // concrete reason and never churns over another existing reason.
      if (!incomingDetailed && current) return;
      // A coded reason (usage_limit_exceeded, rate_limit_exceeded, ...) is
      // stronger than a prose-only fallback, but a later generic error must
      // not replace it.
      if (hasStableErrorCode(current) && !hasStableErrorCode(message)) {
        return;
      }
      if (hasStableErrorCode(current) && hasStableErrorCode(message)) {
        return;
      }
      if (hasDetailedError(current) && !hasStableErrorCode(message)) {
        return;
      }
      const next: ChatRunRecord = {
        ...run,
        summary: message,
        lastError: message,
        revision: run.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (this.store.upsertRun(next)) this.publishRun(next);
    });
  }

  /**
   * A terminal turn event only means the model turn ended. The CLI's execution
   * session may still own a live process tree. Terminate only sessions whose
   * item id belongs to this turn, and never report stopped until the CLI
   * confirms they are gone.
   */
  private async finalizeExecutionSessions(
    conversation: ChatConversationRecord,
    turnId: string,
    rawStatus: string,
  ): Promise<string | null> {
    const binding = this.runConnections.get(turnId);
    const connection = this.runtime.getConversationConnection(
      binding?.conversationId ?? conversation.id,
    );
    const threadId = conversation.threadId;
    const ownedItems = this.runCommandItems.get(turnId) ?? new Set<string>();
    if (!connection || connection.disposed || !threadId) {
      return ownedItems.size > 0 && rawStatus === 'interrupted'
        ? '连接已关闭，无法确认本轮执行链是否随停止而结束。'
        : null;
    }
    if (ownedItems.size === 0) return null;
    let terminals: Array<Record<string, unknown>>;
    try {
      terminals = await connection.process.listBackgroundTerminals(threadId);
    } catch (error) {
      return `无法确认本轮执行链是否结束：${errorMessage(error)}`;
    }
    const owned = terminals.filter((terminal) => {
      const itemId =
        typeof terminal.itemId === 'string' ? terminal.itemId : '';
      return itemId.length > 0 && ownedItems.has(itemId);
    });
    if (owned.length === 0) return null;
    const terminatedIds = new Set<string>();
    for (const terminal of owned) {
      const processId =
        typeof terminal.processId === 'string' ? terminal.processId : '';
      if (!processId) {
        return '执行会话缺少进程标识，无法确认停止结果。';
      }
      try {
        const terminated =
          await connection.process.terminateBackgroundTerminal(
            threadId,
            processId,
          );
        if (!terminated) {
          return `执行会话 ${processId} 拒绝终止，停止未完成。`;
        }
        terminatedIds.add(processId);
      } catch (error) {
        return `终止执行会话 ${processId} 失败：${errorMessage(error)}`;
      }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        terminals = await connection.process.listBackgroundTerminals(threadId);
      } catch (error) {
        return `终止后无法确认执行链结束：${errorMessage(error)}`;
      }
      const remaining = terminals.filter((terminal) => {
        const processId =
          typeof terminal.processId === 'string' ? terminal.processId : '';
        const itemId =
          typeof terminal.itemId === 'string' ? terminal.itemId : '';
        return (
          (processId && terminatedIds.has(processId)) ||
          (itemId && ownedItems.has(itemId))
        );
      });
      if (remaining.length === 0) return null;
    }
    return '执行链在停止后仍然存活，运行未被视为已停止。';
  }

  /**
   * Resolves the submission that owns a terminal turn without letting an
   * unrelated old event adopt the conversation's current in-flight submission.
   *
   * Reliable evidence, in order: the persisted run's submission, the
   * user-message client id carried inside the terminal event (Codex echoes the
   * submission id as clientId), or an unresolved submission journal already
   * bound to this turn. Only when a run is being created may the current
   * in-flight submission be used; it must still match the connection, thread
   * and the turn's start time, which a replayed older turn cannot satisfy.
   */
  private resolveTerminalTurnSubmission(
    conversation: ChatConversationRecord,
    turnId: string,
    turn: Record<string, unknown>,
    run: ChatRunRecord | null,
    connection?: ChatRuntimeConnection,
  ): ChatSubmissionRecord | null {
    if (run?.submissionId) {
      const fromRun = this.store.getSubmission(
        conversation.projectId,
        conversation.id,
        run.submissionId,
      );
      if (fromRun) return fromRun;
    }
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const value of items) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      if (item.type !== 'userMessage') continue;
      for (const key of [
        'clientId',
        'clientUserMessageId',
        'client_user_message_id',
      ]) {
        const clientId = item[key];
        if (typeof clientId !== 'string' || !clientId) continue;
        const fromEvent = this.store.getSubmission(
          conversation.projectId,
          conversation.id,
          clientId,
        );
        if (fromEvent) return fromEvent;
      }
    }
    // A finished journal still identifies its turn. Check every journal bound
    // to this conversation/turn before considering the current in-flight
    // submission; otherwise an old run whose terminal write failed could make
    // the old event look unowned and let the time window bind a new sending
    // submission.
    const bound = this.store.getSubmissionByConversationTurn(
      conversation.projectId,
      conversation.id,
      turnId,
    );
    if (bound) return bound;
    // An existing run already owns its turn. Never let it adopt a different
    // (new) in-flight submission.
    if (run) return null;
    const inFlight = this.inFlight.get(conversation.id);
    if (!inFlight) return null;
    const submission = this.store.getSubmission(
      inFlight.projectId,
      inFlight.conversationId,
      inFlight.submissionId,
    );
    if (!submission || submission.stage !== 'sending') return null;
    if (
      !inFlight.threadId ||
      !conversation.threadId ||
      inFlight.threadId !== conversation.threadId
    ) {
      return null;
    }
    if (
      inFlight.connectionGeneration !== undefined &&
      connection?.generation !== inFlight.connectionGeneration
    ) {
      return null;
    }
    if (!connection || connection.disposed) return null;
    const startedAtMs =
      timestampMs(turn.startedAt) ?? timestampMs(turn.completedAt);
    const createdAtMs = Date.parse(submission.createdAt);
    if (
      startedAtMs === null ||
      !Number.isFinite(createdAtMs) ||
      startedAtMs < createdAtMs - TURN_OWNERSHIP_TOLERANCE_MS
    ) {
      return null;
    }
    return submission;
  }

  /**
   * Late/duplicate terminal event: update only the stored reason when it is
   * more specific. Status, times, messages and file-sync side effects stay
   * untouched.
   */
  private async enrichTerminalRunError(
    conversation: ChatConversationRecord,
    turnId: string,
    turn: Record<string, unknown>,
  ): Promise<void> {
    const pendingError = this.pendingRunErrors.get(turnId)?.message ?? null;
    this.pendingRunErrors.delete(turnId);
    const incoming =
      codexErrorText(objectRecord(turn.error)) ?? pendingError;
    if (!incoming) return;
    await this.withConversationLock(conversation.id, async () => {
      const run = this.store.getRun(turnId);
      if (!run || !isTerminalStatus(run.status)) return;
      const current = run.lastError ?? run.summary;
      const canEnrich =
        (hasStableErrorCode(incoming) && !hasStableErrorCode(current)) ||
        (hasDetailedError(incoming) && !hasDetailedError(current));
      if (!canEnrich || current === incoming) return;
      const next: ChatRunRecord = {
        ...run,
        revision: run.revision + 1,
        summary: incoming,
        lastError: incoming,
        updatedAt: new Date().toISOString(),
      };
      if (this.store.upsertRun(next)) this.publishRun(next);
    });
  }

  private async finishTurn(
    conversation: ChatConversationRecord,
    turnId: string,
    rawStatus: string,
    turn: Record<string, unknown>,
    connection?: ChatRuntimeConnection,
  ): Promise<void> {
    const alreadyTerminal = this.store.getRun(turnId);
    if (alreadyTerminal && isTerminalStatus(alreadyTerminal.status)) {
      // A duplicate/late terminal event must not re-finalize items, execution
      // sessions or file sync. It may only enrich the stored reason.
      if (alreadyTerminal.status !== mapTurnStatus(rawStatus, false)) {
        return;
      }
      await this.enrichTerminalRunError(conversation, turnId, turn);
      return;
    }
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.type === 'agentMessage') {
        this.onAgentComplete(conversation, turnId, record);
      }
    }
    this.flushAllLiveMessages();
    const executionError = await this.finalizeExecutionSessions(
      conversation,
      turnId,
      rawStatus,
    );
    const effectiveRawStatus = executionError ? 'unknown' : rawStatus;
    const failedMessage = [...this.liveMessages.values()].find(
      (live) => live.record.turnId === turnId && live.failed,
    );
    const persistenceError = failedMessage
      ? `助手回复已生成，但本地保存失败：${failedMessage.error}`
      : null;
    const pendingError = this.pendingRunErrors.get(turnId)?.message ?? null;
    this.pendingRunErrors.delete(turnId);
    await this.withConversationLock(conversation.id, async () => {
      const existingRun = this.store.getRun(turnId);
      const error = objectRecord(turn.error);
      const turnErrorText = codexErrorText(error);
      const existingReason = existingRun?.lastError ?? null;
      const errorText = preferDetailedError(
        executionError,
        preferDetailedError(
          existingReason,
          preferDetailedError(
            turnErrorText,
            pendingError ?? persistenceError,
          ),
        ),
      );
      const status = mapTurnStatus(effectiveRawStatus, false);
      const submission = this.resolveTerminalTurnSubmission(
        conversation,
        turnId,
        turn,
        existingRun,
        connection,
      );
      let run: ChatRunRecord | null = existingRun;
      let persistRun = true;
      if (run) {
        if (isTerminalStatus(run.status)) {
          if (run.status !== status) return;
          // Duplicate terminal event: never re-finish, re-append messages or
          // move times. A late concrete error may only enrich the generic
          // reason already stored for this same run.
          const currentReason = run.lastError ?? run.summary;
          const canEnrich =
            (hasStableErrorCode(errorText) &&
              !hasStableErrorCode(currentReason)) ||
            (hasDetailedError(errorText) &&
              !hasDetailedError(currentReason));
          if (canEnrich) {
            run = {
              ...run,
              revision: run.revision + 1,
              summary: errorText!,
              lastError: errorText!,
              updatedAt: new Date().toISOString(),
            };
          } else {
            persistRun = false;
          }
        } else {
          run = {
            ...run,
            status,
            revision: run.revision + 1,
            ...(submission &&
            (!run.submissionId || run.submissionId.startsWith('history:'))
              ? { submissionId: submission.submissionId }
              : {}),
            tools: settleToolStatuses(run.tools, status),
            finishedAt: timestampMs(turn.completedAt) ?? Date.now(),
            summary: errorText ?? run.summary ?? persistenceError,
            lastError: errorText ?? run.lastError ?? persistenceError,
            updatedAt: new Date().toISOString(),
          };
        }
      } else {
        run = {
          id: turnId,
          conversationId: conversation.id,
          projectId: conversation.projectId,
          submissionId: submission?.submissionId ?? null,
          turnId,
          status,
          revision: 1,
          settings: submission
            ? runSettingsFromInput(
                submission.input,
                conversation.serviceId,
                conversation.serviceName ?? undefined,
              )
            : historyRunSettings(conversation),
          startedAt: timestampMs(turn.startedAt) ?? Date.now(),
          finishedAt: timestampMs(turn.completedAt) ?? Date.now(),
          summary: errorText ?? persistenceError,
          tools: [],
          steps: null,
          lastError: errorText ?? persistenceError,
          runtimeInstanceId: this.runtimeInstanceId,
          execution: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      if (run && persistRun) {
        let saveDetail: string | null = null;
        try {
          if (this.store.upsertRun(run)) {
            this.publishRun(run);
          } else {
            const current = this.store.getRun(turnId);
            if (!current || !isTerminalStatus(current.status)) {
              saveDetail = 'upsert 未写入终态';
            }
          }
        } catch (saveError) {
          saveDetail = errorMessage(saveError);
        }
        if (saveDetail) {
          this.logger.warn('chat-run-terminal-save-failed', {
            message: saveDetail.slice(0, 200),
          });
          // The journal must not claim a completed task while its run was not
          // persisted. Publish an uncertain state and keep the submission
          // recoverable so a replay/reconcile can finish it later.
          const failureText = '运行结果未能写入本地数据库，状态待核实。';
          // A failed persistence attempt is a transient projection, not a new
          // durable revision. Publishing the attempted revision would make the
          // recovered database row (which is written from the persisted
          // revision) look older than the transient UI state forever.
          const uncertain: ChatRunRecord = {
            ...run,
            status: 'unknown',
            revision: existingRun?.revision ?? 0,
            summary: failureText,
            lastError: failureText,
            updatedAt: new Date().toISOString(),
          };
          this.publishRun(uncertain);
          if (submission && submission.stage !== 'finished') {
            this.store.updateSubmission(
              submission.projectId,
              submission.conversationId,
              submission.submissionId,
              {
                stage: 'unknown',
                turnId,
                runId: turnId,
                verification: 'terminal-save-failed',
              },
            );
          }
          const pending = this.store.getConversationById(conversation.id);
          if (pending) this.publishSummary(pending);
          return;
        }
      }
      if (submission && submission.stage !== 'finished') {
        this.store.updateSubmission(
          submission.projectId,
          submission.conversationId,
          submission.submissionId,
          {
            stage: 'finished',
            turnId,
            runId: turnId,
            verification: 'terminal-event',
          },
        );
      }
      const updated = this.store.getConversationById(conversation.id);
      if (updated) this.publishSummary(updated);
      if (isTerminalStatus(status)) {
        this.runConnections.delete(turnId);
        for (const [messageId, live] of this.liveMessages) {
          if (live.record.turnId === turnId && !live.failed) {
            this.liveMessages.delete(messageId);
          }
        }
      }
    });
    const finalStatus = mapTurnStatus(effectiveRawStatus, false);
    if (isTerminalStatus(finalStatus)) {
      this.runCommandItems.delete(turnId);
      this.expireRunApprovals(
        turnId,
        finalStatus === 'stopped' ? 'cancelled' : 'expired',
      );
      // Final disk reconciliation happens only after the execution chain has
      // ended. A failed final scan is visible on the run, never reported as a
      // successful completion.
      if (this.fileSync) {
        try {
          await this.fileSync.finalize(conversation.projectId);
        } catch (error) {
          await this.appendRunWarning(
            conversation,
            turnId,
            `最终文件同步失败：${errorMessage(error)}`,
          );
        }
      }
    }
  }

  private async appendRunWarning(
    conversation: ChatConversationRecord,
    turnId: string,
    message: string,
  ): Promise<void> {
    try {
      await this.withConversationLock(conversation.id, async () => {
        const run = this.store.getRun(turnId);
        if (!run) return;
        const summary = run.summary
          ? `${run.summary}；${sanitizeSummary(message)}`
          : sanitizeSummary(message);
        const next: ChatRunRecord = {
          ...run,
          summary,
          lastError: sanitizeSummary(message),
          revision: run.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        if (this.store.upsertRun(next)) this.publishRun(next);
      });
    } catch (error) {
      this.logAsyncFailure('chat-run-sync-warning-failed', error);
    }
  }

  private rememberRunConnection(
    turnId: string,
    conversation: ChatConversationRecord,
    connection: ChatRuntimeConnection,
  ): void {
    const existing = this.runConnections.get(turnId);
    if (existing && existing.generation !== connection.generation) return;
    this.runConnections.set(turnId, {
      serviceId: conversation.serviceId,
      conversationId: conversation.id,
      threadId: conversation.threadId,
      generation: connection.generation,
    });
  }

  private isRunLive(
    run: ChatRunRecord,
    conversation: ChatConversationRecord,
  ): boolean {
    if (run.runtimeInstanceId !== this.runtimeInstanceId) return false;
    const binding = this.runConnections.get(run.id);
    if (!binding) return false;
    if (
      binding.serviceId !== conversation.serviceId ||
      binding.conversationId !== conversation.id
    ) {
      return false;
    }
    if (
      binding.threadId &&
      conversation.threadId &&
      binding.threadId !== conversation.threadId
    ) {
      return false;
    }
    const connection = this.runtime.getConversationConnection(
      binding.conversationId,
    );
    return Boolean(
      connection &&
        connection.connection === 'connected' &&
        !connection.process.hasExited &&
        connection.generation === binding.generation,
    );
  }

  private forgetRunBindingsForService(serviceId: string): void {
    for (const [turnId, binding] of this.runConnections) {
      if (binding.serviceId === serviceId) this.runConnections.delete(turnId);
    }
  }

  private markRunUnknown(
    run: ChatRunRecord,
    message: string,
  ): void {
    if (run.status !== 'running') return;
    const next: ChatRunRecord = {
      ...run,
      status: 'unknown',
      revision: run.revision + 1,
      summary: run.summary ?? message,
      lastError: run.lastError ?? message,
      updatedAt: new Date().toISOString(),
    };
    try {
      if (this.store.upsertRun(next)) this.publishRun(next);
    } catch (error) {
      this.logger.warn('chat-run-unknown-save-failed', {
        message: errorMessage(error).slice(0, 200),
      });
      this.publishRun(next);
    }
  }

  private async handleConnectionExit(
    connection: ChatRuntimeConnection,
    message: string,
  ): Promise<void> {
    const text = sanitizeSummary(
      `所属 Codex 进程已退出，执行状态待核实：${message}`,
    );
    const runs = this.store.listAllUnsettledRuns();
    const affectedProjects = new Set<string>();
    for (const run of runs) {
      const serviceId = this.store.serviceIdForRun(run.id);
      if (serviceId !== connection.serviceId) continue;
      const binding = this.runConnections.get(run.id);
      if (!binding || binding.generation !== connection.generation) continue;
      affectedProjects.add(run.projectId);
      this.markRunUnknown(run, text);
      this.runConnections.delete(run.id);
    }
    if (connection.execution) {
      this.expireApprovalsForConnectionGeneration(connection.generation);
    } else {
      this.expireApprovalsForService(connection.serviceId);
    }
    for (const projectId of affectedProjects) {
      if (!this.fileSync) continue;
      try {
        await this.fileSync.finalize(projectId);
      } catch (error) {
        const messageText = `最终文件同步失败：${errorMessage(error)}`;
        for (const run of this.store
          .listAllUnsettledRuns()
          .filter((candidate) => candidate.projectId === projectId)) {
          const conversation = this.store.getConversationById(
            run.conversationId,
          );
          if (conversation) {
            await this.appendRunWarning(conversation, run.id, messageText);
          }
        }
        this.logAsyncFailure(
          'chat-file-finalize-after-exit-failed',
          error,
        );
      }
    }
    const context = this.latestContext;
    if (context && !connection.execution) {
      const isCurrent = context.serviceId === connection.serviceId;
      const services = context.services?.map((service) =>
        service.serviceId === connection.serviceId
          ? {
              ...service,
              connection: 'error' as const,
              connectionMessage: text,
            }
          : service,
      );
      if (!isCurrent && !services) return;
      const next: ChatCapabilityContext = {
        ...context,
        ...(isCurrent
          ? {
              connection: 'error' as const,
              connectionMessage: text,
            }
          : {}),
        ...(services ? { services } : {}),
        contextRequestId: this.nextContextRequestId(),
      };
      this.latestContext = next;
      this.publish({ type: 'context', context: next });
    }
  }

  private activeChatActivities(): string[] {
    const services = new Set<string>();
    for (const run of this.store.listAllUnsettledRuns()) {
      const conversation = this.store.getConversationById(
        run.conversationId,
      );
      if (!conversation) continue;
      if (this.isRunLive(run, conversation)) {
        services.add(conversation.serviceId);
      }
    }
    for (const conversationId of this.sendQueues.keys()) {
      const serviceId = this.store.serviceIdForConversation(conversationId);
      if (serviceId) services.add(serviceId);
    }
    for (const entry of this.inFlight.values()) {
      const serviceId = this.store.serviceIdForConversation(
        entry.conversationId,
      );
      if (serviceId) services.add(serviceId);
    }
    return [...services];
  }

  private connectedServiceIds(): string[] {
    const ids: string[] = [];
    for (const serviceId of [
      CHATGPT_SERVICE_ID,
      ...(this.settingsService.getChatConfig()?.models.services.map(
        (service) => service.id,
      ) ?? []),
    ]) {
      if (this.runtime.getConnection(serviceId)) ids.push(serviceId);
    }
    return ids;
  }
}
