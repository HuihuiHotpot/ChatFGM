import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ChatCapabilityContext,
  ChatConnectionState,
  ChatEffortOption,
  ChatInputCapabilities,
  ChatModel,
  ChatPermissionOption,
  ChatServiceContext,
  SettingsChatGptAccount,
  SettingsCliRuntime,
} from '../ipc/capabilities';
import type { Logger } from '../platform/log';
import {
  CodexAppServerProcess,
  type CodexNotification,
  type CodexInvocation,
  type CodexServerRequest,
  type CodexServerRequestResolved,
} from '../settings/codex';
import {
  buildDeepSeekConfig,
  DeepSeekClient,
  type DeepSeekDiscovery,
} from '../settings/deepseek';
import type { StoredSettings } from '../settings/store';

export const CHATGPT_SERVICE_ID = 'chatgpt';
export const CHATGPT_SERVICE_NAME = 'ChatGPT';
export const CHAT_READ_ONLY_PERMISSION = 'read-only';
export const CHAT_WORKSPACE_WRITE_PERMISSION = 'workspace-write';
export const CHAT_FULL_ACCESS_PERMISSION = 'danger-full-access';

/** An owned execution process is still alive after the bounded exit wait. */
export class ChatExecutionExitPendingError extends Error {
  readonly code = 'chat-execution-exit-pending';

  constructor(message: string) {
    super(message);
    this.name = 'ChatExecutionExitPendingError';
  }
}

export type ChatPermissionId =
  | typeof CHAT_READ_ONLY_PERMISSION
  | typeof CHAT_WORKSPACE_WRITE_PERMISSION
  | typeof CHAT_FULL_ACCESS_PERMISSION;

const CHAT_PERMISSIONS: readonly ChatPermissionOption[] = [
  {
    id: CHAT_READ_ONLY_PERMISSION,
    label: '只读',
    description: '仅查看项目内容。',
    available: true,
  },
  {
    id: CHAT_WORKSPACE_WRITE_PERMISSION,
    label: '项目内读写',
    description:
      '可修改项目文件，超出范围需审批。',
    available: true,
  },
  {
    id: CHAT_FULL_ACCESS_PERMISSION,
    label: '完全访问',
    description: '后续运行拥有完全访问权限，不再逐项审批。',
    available: true,
  },
];

export function chatPermissionOptions(): readonly ChatPermissionOption[] {
  return CHAT_PERMISSIONS.map((permission) => ({ ...permission }));
}

export function isChatPermissionId(value: unknown): value is ChatPermissionId {
  return CHAT_PERMISSIONS.some((permission) => permission.id === value);
}

export interface ChatSandboxPolicy {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'on-request';
  sandboxPolicy: Record<string, unknown>;
  label: string;
}

export function chatSandboxPolicy(
  permissionId: string,
  projectRoot: string,
): ChatSandboxPolicy {
  switch (permissionId) {
    case CHAT_WORKSPACE_WRITE_PERMISSION:
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [projectRoot],
          networkAccess: false,
        },
        label: 'workspace-write',
      };
    case CHAT_FULL_ACCESS_PERMISSION:
      return {
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        label: 'danger-full-access',
      };
    default:
      return {
        sandbox: 'read-only',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        label: 'read-only',
      };
  }
}

export interface ChatRuntimeDependencies {
  logger: Logger;
  codexRoot: string;
  deepSeek: DeepSeekClient;
  getConfig: () => StoredSettings | undefined;
  getCli: () => SettingsCliRuntime;
  getInvocation: () => CodexInvocation | undefined;
  getAuthProcess: () => CodexAppServerProcess | undefined;
  getAccount: () => SettingsChatGptAccount;
  getServiceKey: (serviceId: string) => string;
  /** Bounded OS process-exit confirmation budget; expiration keeps ownership pending. */
  exitConfirmationTimeoutMs?: number;
}

export interface ChatRuntimeConnection {
  serviceId: string;
  serviceName: string;
  kind: 'chatgpt' | 'api';
  process: CodexAppServerProcess;
  ownedProcess: boolean;
  models: readonly ChatModel[];
  defaultModelId: string | null;
  accountIdentityHash: string | null;
  connection: ChatConnectionState;
  connectionMessage?: string;
  generation: number;
  /** Set for a conversation-owned execution process. */
  conversationId?: string;
  threadId?: string | null;
  /** Environment fingerprint actually applied to this process, if known. */
  environmentFingerprint?: string | null;
  /** True for on-demand conversation execution connections. */
  execution?: boolean;
  /** True once this connection was replaced or closed. */
  disposed: boolean;
  dispose(): void;
}

type ChatNotificationListener = (
  connection: ChatRuntimeConnection,
  notification: CodexNotification,
) => void;
type ChatExitListener = (
  connection: ChatRuntimeConnection,
  message: string,
) => void;
type ChatServerRequestListener = (
  connection: ChatRuntimeConnection,
  request: CodexServerRequest,
) => void;
type ChatServerRequestResolvedListener = (
  connection: ChatRuntimeConnection,
  resolved: CodexServerRequestResolved,
) => void;

interface InternalConnection extends ChatRuntimeConnection {
  unsubscribeNotification: () => void;
  unsubscribeExit: () => void;
  unsubscribeServerRequest: () => void;
  unsubscribeServerRequestResolved: () => void;
  disposed: boolean;
}

function inputCapabilities(
  modalities: readonly string[] | undefined,
): ChatInputCapabilities {
  const values = modalities ?? ['text'];
  return {
    text: values.includes('text'),
    image: values.includes('image'),
    file: true,
    projectReference: true,
  };
}

function effortLabel(id: string): string {
  switch (id) {
    case 'none':
      return '关闭';
    case 'minimal':
      return '最低';
    case 'low':
      return '低';
    case 'medium':
      return '中';
    case 'high':
      return '高';
    case 'xhigh':
      return '极高';
    default:
      return id;
  }
}

export function chatGptAccountHash(
  account: SettingsChatGptAccount,
): string | null {
  if (account.status !== 'logged-in' || !account.email) return null;
  return createHash('sha256')
    .update(`chatgpt:${account.email.toLowerCase()}`)
    .digest('hex');
}

function modelFromDiscovery(
  serviceId: string,
  model: DeepSeekDiscovery['models'][number],
): ChatModel {
  const effortIds = model.effort?.supportedLevels ?? [];
  const efforts: readonly ChatEffortOption[] | null =
    effortIds.length > 0
      ? effortIds.map((id) => ({ id, label: effortLabel(id) }))
      : null;
  return {
    serviceId,
    modelId: model.id,
    label: model.name || model.id,
    available: true,
    efforts,
    defaultEffortId:
      model.effort?.defaultLevel ?? (efforts ? efforts[0]?.id ?? null : null),
    input: inputCapabilities(model.inputModalities),
  };
}

interface InitializationToken {
  cancelled: boolean;
}

export class ChatRuntimeManager {
  private readonly dependencies: ChatRuntimeDependencies;
  private readonly logger: Logger;
  private readonly connections = new Map<string, InternalConnection>();
  private readonly conversationConnections = new Map<
    string,
    InternalConnection
  >();
  private readonly conversationInitializing = new Map<
    string,
    Promise<InternalConnection>
  >();
  private readonly conversationTokens = new Map<string, InitializationToken>();
  private readonly pendingConversationExits = new Map<string, number>();
  private readonly initializing = new Map<
    string,
    Promise<ChatRuntimeConnection>
  >();
  private readonly initializationTokens = new Map<
    string,
    InitializationToken
  >();
  private readonly listeners = new Set<ChatNotificationListener>();
  private readonly exitListeners = new Set<ChatExitListener>();
  private readonly serverRequestListeners = new Set<ChatServerRequestListener>();
  private readonly serverRequestResolvedListeners = new Set<ChatServerRequestResolvedListener>();
  /**
   * Short-lived failure cache so an unavailable service is not probed on every
   * render/menu open/send. Explicit refresh or a settings/auth change clears it.
   */
  private readonly serviceFailures = new Map<
    string,
    { message: string; at: number }
  >();
  private readonly serviceContextReads = new Map<string, object>();
  private generation = 0;
  private disposed = false;

  constructor(dependencies: ChatRuntimeDependencies) {
    this.dependencies = dependencies;
    this.logger = dependencies.logger;
  }

  onNotification(listener: ChatNotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: ChatExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onServerRequest(listener: ChatServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onServerRequestResolved(
    listener: ChatServerRequestResolvedListener,
  ): () => void {
    this.serverRequestResolvedListeners.add(listener);
    return () => this.serverRequestResolvedListeners.delete(listener);
  }

  getConnection(serviceId: string): ChatRuntimeConnection | undefined {
    return this.connections.get(serviceId);
  }

  getConversationConnection(
    conversationId: string,
  ): ChatRuntimeConnection | undefined {
    return this.conversationConnections.get(conversationId);
  }

  /** Stable history home used by both service discovery and conversations. */
  conversationHome(serviceId: string, kind: 'chatgpt' | 'api'): string {
    return kind === 'chatgpt'
      ? path.join(this.dependencies.codexRoot, 'auth')
      : path.join(this.dependencies.codexRoot, 'services', serviceId);
  }

  /**
   * Starts an on-demand execution process owned by one conversation. The
   * service connection remains the shared source of authentication/models;
   * this process owns only this conversation's thread.
   */
  async ensureConversationConnection(input: {
    conversationId: string;
    serviceId: string;
    kind: 'chatgpt' | 'api';
    serviceName: string;
    models: readonly ChatModel[];
    defaultModelId: string | null;
    accountIdentityHash: string | null;
    environmentFingerprint?: string | null;
  }): Promise<ChatRuntimeConnection> {
    if (this.disposed) throw new Error('对话运行层已关闭。');
    this.assertNoPendingConversationExit(input.conversationId);
    const existing = this.conversationConnections.get(input.conversationId);
    if (
      existing &&
      !existing.disposed &&
      existing.connection === 'connected' &&
      !existing.process.hasExited
    ) {
      return existing;
    }
    const pending = this.conversationInitializing.get(input.conversationId);
    if (pending) return pending;
    if (existing) {
      await this.retireConversationConnection(
        input.conversationId,
        existing,
      );
    }
    const invocation = this.dependencies.getInvocation();
    if (!invocation) {
      throw new Error('Codex CLI 未连接，无法准备对话执行进程。');
    }
    const token: InitializationToken = { cancelled: false };
    const promise = this.startConversationConnection(input, invocation, token);
    this.conversationInitializing.set(input.conversationId, promise);
    this.conversationTokens.set(input.conversationId, token);
    try {
      return await promise;
    } finally {
      if (
        this.conversationInitializing.get(input.conversationId) === promise
      ) {
        this.conversationInitializing.delete(input.conversationId);
      }
      if (
        this.conversationTokens.get(input.conversationId) === token
      ) {
        this.conversationTokens.delete(input.conversationId);
      }
    }
  }

  private async startConversationConnection(
    input: {
      conversationId: string;
      serviceId: string;
      kind: 'chatgpt' | 'api';
      serviceName: string;
      models: readonly ChatModel[];
      defaultModelId: string | null;
      accountIdentityHash: string | null;
      environmentFingerprint?: string | null;
    },
    invocation: CodexInvocation,
    token: InitializationToken,
  ): Promise<InternalConnection> {
    const home = this.conversationHome(input.serviceId, input.kind);
    mkdirSync(home, { recursive: true });
    const process = new CodexAppServerProcess({
      invocation,
      codexHome: home,
      logger: this.logger,
      cwd: home,
      ...(input.kind === 'api'
        ? {
            apiKeyEnv: {
              name: 'CHATFGM_DEEPSEEK_API_KEY',
              value: this.dependencies.getServiceKey(input.serviceId),
            },
          }
        : {}),
      notificationRetention: 0,
    });
    const connection = this.createConnection({
      serviceId: input.serviceId,
      serviceName: input.serviceName,
      kind: input.kind,
      process,
      ownedProcess: true,
      models: input.models,
      defaultModelId: input.defaultModelId,
      accountIdentityHash: input.accountIdentityHash,
      connection: 'connecting',
      conversationId: input.conversationId,
      threadId: null,
      environmentFingerprint: input.environmentFingerprint ?? null,
      execution: true,
    });
    this.conversationConnections.set(input.conversationId, connection);
    try {
      await process.start();
      if (
        token.cancelled ||
        this.disposed ||
        connection.disposed ||
        process.hasExited
      ) {
        throw new Error('对话执行连接已被替换。');
      }
      connection.connection = 'connected';
      delete connection.connectionMessage;
      return connection;
    } catch (error) {
      this.disposeConnection(connection);
      throw error;
    }
  }

  private processPid(process: {
    stablePid?: number;
    pid?: number;
  }): number | undefined {
    return process.stablePid ?? process.pid;
  }

  private async retireConversationConnection(
    conversationId: string,
    connection: InternalConnection,
  ): Promise<void> {
    const pid = this.processPid(connection.process);
    this.disposeConnection(connection);
    try {
      await this.waitForProcessExit(pid);
      if (pid !== undefined) this.clearPendingExit(conversationId, pid);
    } catch (error) {
      throw new ChatExecutionExitPendingError(
        `旧执行进程（PID ${pid}）在限定时间内未退出，已阻止该对话创建后继执行连接。请稍后重试。${
          error instanceof Error ? ` ${error.message}` : ''
        }`,
      );
    }
  }

  /** Marks the environment/thread currently applied to a conversation owner. */
  markConversationExecution(
    conversationId: string,
    connection: ChatRuntimeConnection,
    threadId: string,
    environmentFingerprint: string,
  ): void {
    const current = this.conversationConnections.get(conversationId);
    if (!current || current !== connection || current.disposed) return;
    current.threadId = threadId;
    current.environmentFingerprint = environmentFingerprint;
  }

  /** Stops only the target conversation's owned process, never a service. */
  async disposeConversationConnection(conversationId: string): Promise<void> {
    this.assertNoPendingConversationExit(conversationId);
    const token = this.conversationTokens.get(conversationId);
    if (token) token.cancelled = true;
    const pending = this.conversationInitializing.get(conversationId);
    if (pending) await pending.catch(() => undefined);
    this.conversationTokens.delete(conversationId);
    this.conversationInitializing.delete(conversationId);
    const connection = this.conversationConnections.get(conversationId);
    if (!connection) return;
    await this.retireConversationConnection(conversationId, connection);
  }

  private assertNoPendingConversationExit(conversationId: string): void {
    const pid = this.pendingConversationExits.get(conversationId);
    if (pid === undefined) return;
    if (this.isProcessAlive(pid)) {
      throw new ChatExecutionExitPendingError(
        `旧执行进程（PID ${pid}）尚未确认退出，已阻止该对话创建后继执行连接。`,
      );
    }
    this.pendingConversationExits.delete(conversationId);
  }

  private recordPendingExit(
    conversationId: string,
    pid: number | undefined,
  ): void {
    if (pid === undefined) return;
    if (!this.pendingConversationExits.has(conversationId)) {
      this.pendingConversationExits.set(conversationId, pid);
    }
  }

  private clearPendingExit(conversationId: string, pid: number): void {
    if (this.pendingConversationExits.get(conversationId) === pid) {
      this.pendingConversationExits.delete(conversationId);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  async disposeExecutionConnectionsForService(
    serviceId: string,
  ): Promise<void> {
    const ids = [...this.conversationConnections.entries()]
      .filter(([, connection]) => connection.serviceId === serviceId)
      .map(([conversationId]) => conversationId);
    await Promise.all(
      ids.map((conversationId) =>
        this.disposeConversationConnection(conversationId),
      ),
    );
  }

  private async waitForProcessExit(pid: number | undefined): Promise<void> {
    if (!pid) return;
    const timeoutMs =
      this.dependencies.exitConfirmationTimeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.isProcessAlive(pid)) {
      throw new Error(`process ${pid} is still alive`);
    }
  }

  getCurrentServiceId(): string | null {
    const config = this.dependencies.getConfig();
    if (!config) return null;
    if (config.models.mode === 'chatgpt') return CHATGPT_SERVICE_ID;
    return config.models.activeServiceId;
  }

  getCurrentServiceName(): string {
    const config = this.dependencies.getConfig();
    if (!config || config.models.mode === 'chatgpt') {
      return CHATGPT_SERVICE_NAME;
    }
    return (
      config.models.services.find(
        (service) => service.id === config.models.activeServiceId,
      )?.name ?? '模型服务'
    );
  }

  permissions(): readonly ChatPermissionOption[] {
    return chatPermissionOptions();
  }

  private serviceDefinitions(
    config: StoredSettings,
  ): Array<{
    serviceId: string;
    serviceName: string;
    kind: 'chatgpt' | 'api';
  }> {
    return [
      {
        serviceId: CHATGPT_SERVICE_ID,
        serviceName: CHATGPT_SERVICE_NAME,
        kind: 'chatgpt' as const,
      },
      ...config.models.services.map((service) => ({
        serviceId: service.id,
        serviceName: service.name,
        kind: 'api' as const,
      })),
    ];
  }

  private serviceContextFromConnection(
    connection: ChatRuntimeConnection,
  ): ChatServiceContext {
    return {
      serviceId: connection.serviceId,
      serviceName: connection.serviceName,
      connection: connection.connection,
      ...(connection.connectionMessage
        ? { connectionMessage: connection.connectionMessage }
        : {}),
      models: connection.models.map((model) => ({ ...model })),
      defaultModelId: connection.defaultModelId,
    };
  }

  /**
   * A stuck provider/process must not block every other service's models.
   * The underlying initialization may still complete later and become cached.
   */
  private withServiceTimeout<T>(
    operation: Promise<T>,
    serviceName: string,
  ): Promise<T> {
    const timeoutMs = 25_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `模型服务「${serviceName}」在 ${Math.round(
              timeoutMs / 1000,
            )} 秒内未完成连接，已单独标记为不可用；其他服务不受影响。`,
          ),
        );
      }, timeoutMs);
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Ensures one service's connection and returns its own model catalog. A
   * failure is returned as that service's state, never thrown across other
   * services. Successful connections and recent failures are cached.
   */
  async getServiceContext(
    serviceId: string,
    refresh = false,
  ): Promise<ChatServiceContext> {
    if (this.disposed) throw new Error('对话运行层已关闭。');
    const config = this.dependencies.getConfig();
    const definition = config
      ? this.serviceDefinitions(config).find(
          (candidate) => candidate.serviceId === serviceId,
        )
      : undefined;
    const existing = this.connections.get(serviceId);
    if (!refresh && existing) {
      if (
        !existing.disposed &&
        existing.connection === 'connected' &&
        !existing.process.hasExited
      ) {
        return this.serviceContextFromConnection(existing);
      }
    }
    if (refresh && existing && !this.initializing.has(serviceId)) {
      // Explicit refresh must actually re-read the service catalog. Only the
      // shared discovery/auth connection is retired here; conversation
      // execution processes, thread ids and persisted history are separate,
      // so a completed (or even running) conversation does not block refresh.
      // An overlapping refresh joins discovery already in progress. Retiring
      // its connecting owner would invalidate the promise ensureConnection
      // is about to reuse for both callers.
      this.disposeConnection(existing);
    }
    if (!refresh && !this.initializing.has(serviceId)) {
      const failure = this.serviceFailures.get(serviceId);
      if (failure && Date.now() - failure.at < 30_000) {
        return {
          serviceId,
          serviceName: definition?.serviceName ?? existing?.serviceName ?? '模型服务',
          connection: 'error',
          connectionMessage: failure.message,
          models: [],
          defaultModelId: null,
        };
      }
    }
    // Cache-only reads do not own an in-flight discovery's cache writes.
    // Ordinary reads during an explicit retry join that newer discovery.
    const read = {};
    this.serviceContextReads.set(serviceId, read);
    try {
      this.logger.info('chat-service-context-start', { serviceId });
      const connection = await this.withServiceTimeout(
        this.ensureConnection(serviceId),
        definition?.serviceName ?? existing?.serviceName ?? '模型服务',
      );
      if (this.serviceContextReads.get(serviceId) === read) {
        this.serviceFailures.delete(serviceId);
      }
      this.logger.info('chat-service-context-ready', {
        serviceId,
        models: connection.models.length,
      });
      return this.serviceContextFromConnection(connection);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '模型服务连接失败。';
      this.logger.warn('chat-service-context-failed', {
        serviceId,
        message: message.slice(0, 200),
      });
      if (this.serviceContextReads.get(serviceId) === read) {
        this.serviceFailures.set(serviceId, { message, at: Date.now() });
      }
      return {
        serviceId,
        serviceName:
          definition?.serviceName ?? existing?.serviceName ?? '模型服务',
        connection: 'error',
        connectionMessage: message,
        models: [],
        defaultModelId: null,
      };
    }
  }

  /** Clears cached per-service failures after settings/auth changes. */
  invalidateServiceCatalog(): void {
    this.serviceFailures.clear();
    this.serviceContextReads.clear();
  }

  /**
   * Returns the saved current service plus every configured service's own
   * connection/model state. Discovery is skipped when the CLI is unavailable
   * and is only forced by an explicit refresh.
   */
  async getContext(input?: {
    projectId?: string;
    refresh?: boolean;
  }): Promise<ChatCapabilityContext> {
    if (this.disposed) throw new Error('对话运行层已关闭。');
    const serviceId = this.getCurrentServiceId();
    const serviceName = this.getCurrentServiceName();
    if (!serviceId) {
      return {
        serviceId: '',
        serviceName,
        connection: 'disconnected',
        connectionMessage: '尚未选择模型服务，请先在依赖设置中配置。',
        models: [],
        defaultModelId: null,
        services: [],
        permissions: this.permissions(),
        defaultPermissionId: CHAT_READ_ONLY_PERMISSION,
      };
    }
    const config = this.dependencies.getConfig();
    if (!config) {
      return {
        serviceId,
        serviceName,
        connection: 'error',
        connectionMessage: '依赖设置尚未加载。',
        models: [],
        defaultModelId: null,
        services: [],
        permissions: this.permissions(),
        defaultPermissionId: CHAT_READ_ONLY_PERMISSION,
      };
    }
    const definitions = this.serviceDefinitions(config);
    const cli = this.dependencies.getCli();
    if (cli.state !== 'connected') {
      const connection =
        cli.state === 'connecting' ? 'connecting' : 'disconnected';
      const message = cli.message || 'Codex CLI 尚未连接。';
      const services: ChatServiceContext[] = definitions.map(
        (definition) => ({
          serviceId: definition.serviceId,
          serviceName: definition.serviceName,
          connection,
          connectionMessage: message,
          models: [],
          defaultModelId: null,
        }),
      );
      return {
        serviceId,
        serviceName,
        connection,
        connectionMessage: message,
        models: [],
        defaultModelId: null,
        services,
        permissions: this.permissions(),
        defaultPermissionId: CHAT_READ_ONLY_PERMISSION,
      };
    }
    const services = await Promise.all(
      definitions.map((definition) =>
        this.getServiceContext(
          definition.serviceId,
          input?.refresh === true,
        ),
      ),
    );
    const current = services.find(
      (service) => service.serviceId === serviceId,
    );
    return {
      serviceId,
      serviceName: current?.serviceName ?? serviceName,
      connection: current?.connection ?? 'error',
      ...(current?.connectionMessage
        ? { connectionMessage: current.connectionMessage }
        : {}),
      models: current?.models.map((model) => ({ ...model })) ?? [],
      defaultModelId: current?.defaultModelId ?? null,
      services,
      permissions: this.permissions(),
      defaultPermissionId: CHAT_READ_ONLY_PERMISSION,
    };
  }

  async ensureConnection(
    serviceId: string,
  ): Promise<ChatRuntimeConnection> {
    if (this.disposed) throw new Error('对话运行层已关闭。');
    if (serviceId === CHATGPT_SERVICE_ID) {
      const account = this.dependencies.getAccount();
      if (account.status !== 'logged-in') {
        this.cancelInitialization(serviceId);
        const stale = this.connections.get(serviceId);
        if (stale) this.disposeConnection(stale);
        throw new Error(
          account.message ||
            'ChatGPT 账号尚未登录，无法开始对话。',
        );
      }
    }
    const existing = this.connections.get(serviceId);
    if (
      existing &&
      !existing.disposed &&
      existing.connection === 'connected' &&
      !existing.process.hasExited
    ) {
      return existing;
    }
    const pending = this.initializing.get(serviceId);
    if (pending) return pending;
    if (existing) this.disposeConnection(existing);
    const config = this.dependencies.getConfig();
    if (!config) throw new Error('依赖设置尚未加载。');
    const token: InitializationToken = { cancelled: false };
    const promise = this.initializeConnection(serviceId, config, token);
    this.initializing.set(serviceId, promise);
    this.initializationTokens.set(serviceId, token);
    try {
      return await promise;
    } finally {
      if (this.initializing.get(serviceId) === promise) {
        this.initializing.delete(serviceId);
      }
      if (this.initializationTokens.get(serviceId) === token) {
        this.initializationTokens.delete(serviceId);
      }
    }
  }

  private async initializeConnection(
    serviceId: string,
    config: StoredSettings,
    token: InitializationToken,
  ): Promise<ChatRuntimeConnection> {
    if (serviceId === CHATGPT_SERVICE_ID) {
      return this.connectChatGpt(token);
    }
    const service = config.models.services.find(
      (candidate) => candidate.id === serviceId,
    );
    if (!service) {
      throw new Error('模型服务已删除，此对话仅可查看。');
    }
    return this.connectApi(service, token);
  }

  /** Disposes a service connection without deleting its stable history home. */
  disposeServiceConnection(serviceId: string): void {
    this.serviceContextReads.delete(serviceId);
    this.cancelInitialization(serviceId);
    const connection = this.connections.get(serviceId);
    if (connection) this.disposeConnection(connection);
    for (const [conversationId, execution] of this
      .conversationConnections) {
      if (execution.serviceId === serviceId) {
        const token = this.conversationTokens.get(conversationId);
        if (token) token.cancelled = true;
        this.disposeConnection(execution);
      }
    }
  }

  currentAuthProcess(): CodexAppServerProcess | undefined {
    return this.dependencies.getAuthProcess();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const token of this.conversationTokens.values()) {
      token.cancelled = true;
    }
    this.conversationTokens.clear();
    this.conversationInitializing.clear();
    for (const connection of this.conversationConnections.values()) {
      this.disposeConnection(connection);
    }
    this.pendingConversationExits.clear();
    this.conversationConnections.clear();
    for (const serviceId of new Set([
      ...this.connections.keys(),
      ...this.initializationTokens.keys(),
    ])) {
      this.cancelInitialization(serviceId);
      const connection = this.connections.get(serviceId);
      if (connection) this.disposeConnection(connection);
    }
    this.connections.clear();
    this.initializing.clear();
    this.initializationTokens.clear();
    this.serviceFailures.clear();
    this.serviceContextReads.clear();
    this.listeners.clear();
    this.exitListeners.clear();
    this.serverRequestListeners.clear();
    this.serverRequestResolvedListeners.clear();
  }

  private cancelInitialization(serviceId: string): void {
    const token = this.initializationTokens.get(serviceId);
    if (token) token.cancelled = true;
    this.initializationTokens.delete(serviceId);
    this.initializing.delete(serviceId);
  }

  private initializationActive(token: InitializationToken): boolean {
    return !token.cancelled && !this.disposed;
  }

  private async connectChatGpt(
    token: InitializationToken,
  ): Promise<ChatRuntimeConnection> {
    const process = this.dependencies.getAuthProcess();
    const invocation = this.dependencies.getInvocation();
    if (!process || !invocation || process.hasExited) {
      throw new Error('ChatGPT 登录进程未连接，请先在依赖设置中检测并连接 CLI。');
    }
    const account = this.dependencies.getAccount();
    if (account.status !== 'logged-in') {
      throw new Error(
        account.message ||
          'ChatGPT 账号尚未登录，无法开始对话。',
      );
    }
    if (!this.initializationActive(token)) {
      throw new Error('模型连接已被替换。');
    }
    const identity = chatGptAccountHash(account);
    const connection = this.createConnection({
      serviceId: CHATGPT_SERVICE_ID,
      serviceName: CHATGPT_SERVICE_NAME,
      kind: 'chatgpt',
      process,
      ownedProcess: false,
      models: [],
      defaultModelId: null,
      accountIdentityHash: identity,
      connection: 'connecting',
      ...(identity
        ? {}
        : {
            connectionMessage:
              '无法确认账号，请重新登录后继续；历史仍可查看。',
          }),
    });
    this.connections.set(CHATGPT_SERVICE_ID, connection);
    try {
      if (!this.initializationActive(token)) {
        throw new Error('模型连接已被替换。');
      }
      const models = await connection.process.listModels();
      if (
        connection.disposed ||
        connection.process.hasExited ||
        !this.initializationActive(token)
      ) {
        throw new Error('模型连接已被替换。');
      }
      const mapped = models
        .filter((model) => !model.hidden)
        .map((model) => {
          const effortIds = (model.supportedReasoningEfforts ?? [])
            .map((effort) => effort.reasoningEffort)
            .filter((id) => id.length > 0);
          return {
            serviceId: connection.serviceId,
            modelId: model.model || model.id,
            label: model.displayName || model.model || model.id,
            available: true,
            efforts:
              effortIds.length > 0
                ? effortIds.map((id) => ({
                    id,
                    label: effortLabel(id),
                  }))
                : null,
            defaultEffortId:
              model.defaultReasoningEffort ??
              (effortIds.length > 0 ? effortIds[0]! : null),
            input: inputCapabilities(model.inputModalities),
          } satisfies ChatModel;
        });
      if (mapped.length === 0) {
        throw new Error('ChatGPT 未返回可用模型。');
      }
      connection.models = mapped;
      connection.defaultModelId =
        models.find((model) => model.isDefault)?.model ??
        mapped[0]!.modelId;
      connection.connection = 'connected';
      return connection;
    } catch (error) {
      if (connection.disposed || !this.initializationActive(token)) {
        this.disposeConnection(connection);
        throw error;
      }
      connection.connection = 'error';
      connection.connectionMessage =
        error instanceof Error
          ? error.message
          : 'ChatGPT 模型列表读取失败。';
      connection.models = [];
      connection.defaultModelId = null;
      return connection;
    }
  }

  private async connectApi(
    service: StoredSettings['models']['services'][number],
    token: InitializationToken,
  ): Promise<ChatRuntimeConnection> {
    const invocation = this.dependencies.getInvocation();
    if (!invocation) {
      throw new Error('Codex CLI 未连接，无法准备模型运行层。');
    }
    const key = this.dependencies.getServiceKey(service.id);
    const discovery = await this.dependencies.deepSeek.discover({
      baseUrl: service.baseUrl,
      key,
    });
    if (!this.initializationActive(token)) {
      throw new Error('模型连接已被替换。');
    }
    const home = path.join(
      this.dependencies.codexRoot,
      'services',
      service.id,
    );
    // The service home is the stable history location for this service. It is
    // created/updated but never deleted when settings are saved.
    mkdirSync(home, { recursive: true });
    const catalogPath = path.join(home, 'models.json');
    writeFileSync(catalogPath, JSON.stringify(discovery.catalog), 'utf8');
    writeFileSync(
      path.join(home, 'config.toml'),
      buildDeepSeekConfig({
        selectedModel: discovery.selected,
        catalogPath,
      }),
      'utf8',
    );
    if (!this.initializationActive(token)) {
      throw new Error('模型连接已被替换。');
    }
    const generation = ++this.generation;
    const process = new CodexAppServerProcess({
      invocation,
      codexHome: home,
      logger: this.logger,
      cwd: home,
      apiKeyEnv: {
        name: 'CHATFGM_DEEPSEEK_API_KEY',
        value: key,
      },
      notificationRetention: 0,
    });
    const connection = this.createConnection({
      serviceId: service.id,
      serviceName: service.name,
      kind: 'api',
      process,
      ownedProcess: true,
      models: discovery.models.map((model) =>
        modelFromDiscovery(service.id, model),
      ),
      defaultModelId: discovery.selected.id,
      accountIdentityHash: null,
      connection: 'connecting',
      generation,
    });
    this.connections.set(service.id, connection);
    if (!this.initializationActive(token)) {
      this.disposeConnection(connection);
      throw new Error('模型连接已被替换。');
    }
    try {
      await process.start();
      if (
        !this.initializationActive(token) ||
        connection.disposed ||
        process.hasExited
      ) {
        throw new Error('模型连接已被替换。');
      }
      const listed = await process.listModels();
      if (
        !this.initializationActive(token) ||
        connection.disposed ||
        process.hasExited
      ) {
        throw new Error('模型连接已被替换。');
      }
      const available = new Set(listed.map((model) => model.model || model.id));
      if (
        !available.has(discovery.selected.id) ||
        connection.models.length === 0
      ) {
        throw new Error('Codex 未识别到 DeepSeek 模型目录。');
      }
      connection.connection = 'connected';
      delete connection.connectionMessage;
      this.logger.info('chat-service-connected', {
        serviceId: service.id,
        models: connection.models.length,
      });
      return connection;
    } catch (error) {
      this.disposeConnection(connection);
      throw new Error(
        `模型服务连接失败：${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  private createConnection(
    input: Omit<
      InternalConnection,
      | 'generation'
      | 'dispose'
      | 'unsubscribeNotification'
      | 'unsubscribeExit'
      | 'unsubscribeServerRequest'
      | 'unsubscribeServerRequestResolved'
      | 'disposed'
    > & { generation?: number },
  ): InternalConnection {
    const connection: InternalConnection = {
      ...input,
      generation: input.generation ?? ++this.generation,
      disposed: false,
      unsubscribeNotification: () => undefined,
      unsubscribeExit: () => undefined,
      unsubscribeServerRequest: () => undefined,
      unsubscribeServerRequestResolved: () => undefined,
      dispose: () => this.disposeConnection(connection),
    };
    connection.unsubscribeNotification = input.process.addNotificationListener(
      (notification) => {
        if (connection.disposed) return;
        for (const listener of this.listeners) {
          try {
            listener(connection, notification);
          } catch (error) {
            this.logger.warn('chat-runtime-listener-failed', {
              message:
                error instanceof Error
                  ? error.message.slice(0, 200)
                  : 'unknown',
            });
          }
        }
      },
    );
    connection.unsubscribeExit = input.process.addExitListener((message) => {
      if (connection.disposed) return;
      connection.connection = 'error';
      connection.connectionMessage = message;
      for (const listener of this.exitListeners) {
        try {
          listener(connection, message);
        } catch (error) {
          this.logger.warn('chat-runtime-exit-listener-failed', {
            message:
              error instanceof Error
                ? error.message.slice(0, 200)
                : 'unknown',
          });
        }
      }
    });
    connection.unsubscribeServerRequest =
      input.process.addServerRequestListener((request) => {
        if (connection.disposed) {
          // A late request from a replaced connection must never be silently
          // allowed. Refuse it explicitly so app-server does not wait.
          request.reject(-32001, 'Connection replaced');
          return;
        }
        for (const listener of this.serverRequestListeners) {
          try {
            listener(connection, request);
          } catch (error) {
            this.logger.warn('chat-server-request-listener-failed', {
              message:
                error instanceof Error
                  ? error.message.slice(0, 200)
                  : 'unknown',
            });
            request.reject(-32603, 'Internal error');
          }
        }
      });
    connection.unsubscribeServerRequestResolved =
      input.process.addServerRequestResolvedListener((resolved) => {
        if (connection.disposed) return;
        for (const listener of this.serverRequestResolvedListeners) {
          try {
            listener(connection, resolved);
          } catch (error) {
            this.logger.warn('chat-server-request-resolved-listener-failed', {
              message:
                error instanceof Error
                  ? error.message.slice(0, 200)
                  : 'unknown',
            });
          }
        }
      });
    return connection;
  }

  private disposeConnection(connection: InternalConnection): void {
    if (connection.disposed) return;
    const pid = this.processPid(connection.process);
    if (connection.conversationId) {
      this.recordPendingExit(connection.conversationId, pid);
    }
    connection.disposed = true;
    connection.unsubscribeNotification();
    connection.unsubscribeExit();
    connection.unsubscribeServerRequest();
    connection.unsubscribeServerRequestResolved();
    if (this.connections.get(connection.serviceId) === connection) {
      this.connections.delete(connection.serviceId);
    }
    if (
      connection.conversationId &&
      this.conversationConnections.get(connection.conversationId) ===
        connection
    ) {
      this.conversationConnections.delete(connection.conversationId);
    }
    if (connection.ownedProcess) {
      connection.process.dispose();
    }
    this.logger.info('chat-service-disconnected', {
      serviceId: connection.serviceId,
    });
  }
}

export function readOnlySandbox(): {
  sandbox: 'read-only';
  approvalPolicy: 'never';
} {
  return { sandbox: 'read-only', approvalPolicy: 'never' };
}

