import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Logger } from '../platform/log';

export class CodexLaunchError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexLaunchError';
    this.code = code;
  }
}

export interface CodexInvocation {
  /** The path shown to the user and stored in settings. */
  displayPath: string;
  /** Actual executable that receives the fixed app-server arguments. */
  command: string;
  argsPrefix: string[];
  kind: 'exe' | 'powershell' | 'npm-binary';
  resolvedPath: string;
}

export interface CodexLaunchEnvironment {
  codexHome: string;
  apiKeyEnv?: { name: string; value: string };
}

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_NOTIFICATION_RETENTION = 1000;

/**
 * The installed CLI (0.165.0-alpha.1.2) gates its Windows sandbox backend
 * behind this feature flag. Without it every write-sandboxed command is
 * rejected by policy and `windowsSandbox/readiness` reports `notConfigured`.
 * It is a CLI config override, not a protocol extension.
 */
export const CODEX_WINDOWS_SANDBOX_ARGS = [
  '-c',
  'features.experimental_windows_sandbox=true',
] as const;

const SAFE_ENV_NAMES = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'OS',
  'LANG',
  'LC_ALL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
] as const;

function assertSafePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CodexLaunchError('cli-path-missing', '请选择 Codex CLI 程序路径。');
  }
  if (
    trimmed.length > 4096 ||
    trimmed.includes('\u0000') ||
    trimmed.includes('\r') ||
    trimmed.includes('\n')
  ) {
    throw new CodexLaunchError('cli-path-invalid', 'Codex CLI 路径无效。');
  }
  if (!path.isAbsolute(trimmed)) {
    throw new CodexLaunchError('cli-path-invalid', 'Codex CLI 路径必须是绝对路径。');
  }
  return trimmed;
}

function currentPlatformTokens(): string[] {
  if (process.arch === 'x64') {
    return ['win32-x64', 'x86_64-pc-windows-msvc'];
  }
  if (process.arch === 'arm64') {
    return ['win32-arm64', 'aarch64-pc-windows-msvc'];
  }
  return [];
}

function findCodexBinaryInPackage(packageRoot: string): string | null {
  let rootReal: string;
  try {
    rootReal = realpathSync.native(packageRoot);
    if (!lstatSync(rootReal).isDirectory()) return null;
  } catch {
    return null;
  }
  const candidates: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (entry.name.toLowerCase() !== 'codex.exe') continue;
      const candidate = path.join(directory, entry.name);
      try {
        const stat = lstatSync(candidate);
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        const real = realpathSync.native(candidate);
        const relative = path.relative(rootReal, real);
        // Never follow a package link to an unrelated installation.
        if (
          relative.startsWith('..') ||
          path.isAbsolute(relative) ||
          !lstatSync(real).isFile()
        ) {
          continue;
        }
        candidates.push(real);
      } catch {
        // Continue with other package files.
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      walk(path.join(directory, entry.name), depth + 1);
    }
  };
  walk(rootReal, 0);
  if (candidates.length === 0) return null;
  const platformTokens = currentPlatformTokens();
  const platformMatch = candidates.find((candidate) => {
    const lower = candidate.toLowerCase();
    return platformTokens.some((token) =>
      lower.split(path.sep).some((segment) => segment === token),
    );
  });
  if (platformMatch) return platformMatch;
  // A legacy package layout may place codex.exe directly under bin/. If any
  // candidate is unmistakably for another architecture, refuse instead of
  // launching the wrong native program.
  const knownPlatformSegments = [
    'win32-x64',
    'win32-arm64',
    'x86_64-pc-windows-msvc',
    'aarch64-pc-windows-msvc',
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
  ];
  const hasPlatformSpecificCandidate = candidates.some((candidate) => {
    const segments = candidate.toLowerCase().split(path.sep);
    return knownPlatformSegments.some((segment) => segments.includes(segment));
  });
  if (hasPlatformSpecificCandidate) return null;
  return candidates.length === 1 ? candidates[0]! : null;
}

function findNpmPackageRoots(shimPath: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    try {
      const resolved = realpathSync.native(candidate);
      if (!lstatSync(resolved).isDirectory() || seen.has(resolved.toLowerCase())) {
        return;
      }
      seen.add(resolved.toLowerCase());
      roots.push(resolved);
    } catch {
      // Not this npm shape.
    }
  };
  let directory = path.dirname(shimPath);
  for (let depth = 0; depth < 4; depth += 1) {
    add(path.join(directory, 'node_modules', '@openai', 'codex'));
    add(path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex'));
    directory = path.dirname(directory);
  }
  // A shim may itself live in the package's bin directory.
  if (path.basename(path.dirname(shimPath)).toLowerCase() === 'bin') {
    add(path.dirname(path.dirname(shimPath)));
  }
  return roots;
}

function resolveNpmShim(shimPath: string): string {
  const packageRoots = findNpmPackageRoots(shimPath);
  for (const root of packageRoots) {
    const found = findCodexBinaryInPackage(root);
    if (found) return found;
  }
  throw new CodexLaunchError(
    'cli-npm-entry-unresolved',
    '该 npm 启动入口中没有找到与当前 Windows 平台匹配的 codex.exe。请选择 Codex 安装目录中的 codex.exe，或重新安装官方 Codex CLI。',
  );
}

export function resolveCodexInvocation(value: string): CodexInvocation {
  const selected = assertSafePath(value);
  let resolved: string;
  try {
    resolved = realpathSync.native(selected);
  } catch (error) {
    throw new CodexLaunchError('cli-path-missing', 'Codex CLI 文件不存在。', {
      cause: error,
    });
  }
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch (error) {
    throw new CodexLaunchError('cli-path-missing', 'Codex CLI 文件不可访问。', {
      cause: error,
    });
  }
  if (!stat.isFile()) {
    throw new CodexLaunchError('cli-path-invalid', 'Codex CLI 路径不是文件。');
  }
  const extension = path.extname(resolved).toLowerCase();
  if (extension === '.exe') {
    return {
      displayPath: selected,
      command: resolved,
      argsPrefix: [],
      kind: 'exe',
      resolvedPath: resolved,
    };
  }
  if (extension === '.ps1') {
    // Official npm installs use a PowerShell shim. The shim does not preserve
    // bidirectional stdio reliably when launched through powershell.exe, so
    // resolve its platform package to the native binary first. Arbitrary user
    // PowerShell entry points without an npm package still use the fallback.
    if (findNpmPackageRoots(resolved).length > 0) {
      const binary = resolveNpmShim(resolved);
      return {
        displayPath: selected,
        command: binary,
        argsPrefix: [],
        kind: 'npm-binary',
        resolvedPath: binary,
      };
    }
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (!existsSync(powershell)) {
      throw new CodexLaunchError(
        'cli-powershell-missing',
        '找不到 Windows PowerShell，无法启动该 Codex 入口。',
      );
    }
    return {
      displayPath: selected,
      command: powershell,
      argsPrefix: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolved,
      ],
      kind: 'powershell',
      resolvedPath: resolved,
    };
  }
  if (extension === '.cmd' || extension === '.bat') {
    const binary = resolveNpmShim(resolved);
    return {
      displayPath: selected,
      command: binary,
      argsPrefix: [],
      kind: 'npm-binary',
      resolvedPath: binary,
    };
  }
  throw new CodexLaunchError(
    'cli-extension-unsupported',
    'Codex CLI 必须是 .exe、.cmd、.bat 或 .ps1 入口。',
  );
}

/**
 * A deliberately small environment. User provider variables, Codex tokens
 * and external CODEX_HOME values are removed; only OS essentials and the
 * isolated application Codex home are forwarded.
 */
export function buildCodexEnvironment(
  options: CodexLaunchEnvironment,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.CODEX_HOME = options.codexHome;
  env.NO_COLOR = '1';
  env.CI = '1';
  if (options.apiKeyEnv) {
    env[options.apiKeyEnv.name] = options.apiKeyEnv.value;
  }
  return env;
}

export interface CodexInitializeInfo {
  userAgent: string;
  codexHome: string;
  platformFamily?: string;
  platformOs?: string;
}

export interface CodexAccount {
  type: 'chatgpt' | 'apiKey' | 'other' | 'none';
  email?: string;
  planType?: string;
}

export interface CodexLoginStart {
  type: string;
  loginId?: string;
  authUrl?: string;
  userCode?: string;
  verificationUrl?: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>;
  inputModalities?: string[];
  contextWindow?: number;
  maxContextWindow?: number;
  supportsParallelToolCalls?: boolean;
}

export interface CodexNotification {
  method: string;
  params: unknown;
}

/**
 * A request initiated by app-server. The client must answer it exactly once;
 * answering an already settled, expired or disconnected request is a no-op.
 * There is deliberately no generic JSON-RPC surface outside this object.
 */
export interface CodexServerRequest {
  /** Stable identity derived from the JSON-RPC id and connection instance. */
  key: string;
  id: number | string;
  method: string;
  params: unknown;
  readonly pending: boolean;
  respond(result: unknown): boolean;
  reject(code: number, message: string): boolean;
}

export type CodexServerRequestListener = (
  request: CodexServerRequest,
) => void;

/** Notification that app-server itself settled a pending server request. */
export interface CodexServerRequestResolved {
  /** Connection-local key of the request that became invalid. */
  key: string;
  id: number | string;
  method: string;
  threadId: string;
  requestId: number | string;
}

export type CodexServerRequestResolvedListener = (
  resolved: CodexServerRequestResolved,
) => void;

interface PendingServerRequest {
  id: number | string;
  method: string;
  params: unknown;
  responded: boolean;
}

function requestThreadId(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const value = (params as Record<string, unknown>).threadId;
  return typeof value === 'string' ? value : '';
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: CodexProtocolError) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class CodexProtocolError extends Error {
  readonly code: string;
  readonly rpcCode?: number;

  constructor(code: string, message: string, rpcCode?: number) {
    super(message);
    this.name = 'CodexProtocolError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

function sanitizeExternalMessage(value: unknown): string {
  if (typeof value !== 'string') return 'Codex 返回了未知错误。';
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(sk|pk|ak)-[A-Za-z0-9._-]{6,}\b/g, '[redacted]')
    .replace(/([?&](?:key|token|code|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .slice(0, 600);
}

function parseRpcError(value: unknown): CodexProtocolError {
  if (!value || typeof value !== 'object') {
    return new CodexProtocolError('codex-protocol-error', 'Codex 返回了无效错误。');
  }
  const error = value as { code?: unknown; message?: unknown };
  return new CodexProtocolError(
    'codex-rpc-error',
    sanitizeExternalMessage(error.message),
    typeof error.code === 'number' ? error.code : undefined,
  );
}

function safeProcessExitMessage(code: number | null, signal: string | null): string {
  const parts = [];
  if (code !== null) parts.push(`退出码 ${code}`);
  if (signal) parts.push(`信号 ${signal}`);
  return parts.length > 0 ? `Codex CLI 已退出（${parts.join('，')}）。` : 'Codex CLI 已退出。';
}

export interface CodexProcessOptions {
  invocation: CodexInvocation;
  codexHome: string;
  logger: Logger;
  cwd?: string;
  apiKeyEnv?: { name: string; value: string };
  onNotification?: (notification: CodexNotification) => void;
  onExit?: (message: string) => void;
  /**
   * How many unconsumed notifications are retained for waitForNotification.
   * A long-lived chat process sets this to zero and consumes the listener
   * stream instead of keeping every event.
   */
  notificationRetention?: number;
}

/**
 * Owns one app-server stdio process. The public surface is intentionally
 * method-specific; there is no generic RPC bridge to the renderer.
 */
export class CodexAppServerProcess {
  private readonly invocation: CodexInvocation;
  private readonly codexHome: string;
  private readonly logger: Logger;
  private readonly cwd: string;
  private readonly apiKeyEnv?: { name: string; value: string };
  /**
   * PID captured immediately after spawn. Unlike child?.pid this survives the
   * transport's own dispose(), which must clear child before start() rejects.
   */
  private spawnedPid?: number;
  private readonly onNotification?: (notification: CodexNotification) => void;
  private readonly onExit?: (message: string) => void;
  private readonly notificationRetention: number;
  private readonly notificationListeners = new Set<
    (notification: CodexNotification) => void
  >();
  private readonly serverRequestListeners = new Set<CodexServerRequestListener>();
  private readonly serverRequestResolvedListeners = new Set<CodexServerRequestResolvedListener>();
  private readonly pendingServerRequests = new Map<
    string,
    PendingServerRequest
  >();
  private readonly exitListeners = new Set<(message: string) => void>();
  private child?: ReturnType<typeof spawn>;
  private stdout?: Readable;
  private stderr?: Readable;
  private stdin?: Writable;
  private outputBuffer = '';
  private stderrBytes = 0;
  private stderrLimitReported = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: CodexNotification[] = [];
  private readonly notificationWaiters = new Set<{
    predicate: (notification: CodexNotification) => boolean;
    resolve: (notification: CodexNotification) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private closed = false;
  private exitNotified = false;

  constructor(options: CodexProcessOptions) {
    this.invocation = options.invocation;
    this.codexHome = options.codexHome;
    this.logger = options.logger;
    this.cwd = options.cwd ?? options.codexHome;
    this.apiKeyEnv = options.apiKeyEnv;
    this.onNotification = options.onNotification;
    this.onExit = options.onExit;
    this.notificationRetention =
      options.notificationRetention ?? DEFAULT_NOTIFICATION_RETENTION;
  }

  /**
   * Adds a second consumer of app-server notifications without replacing the
   * settings/auth notification handler. Returns an unsubscribe function.
   */
  addNotificationListener(
    listener: (notification: CodexNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /**
   * Observes requests initiated by app-server. Every listener must answer or
   * deliberately leave the request pending; the transport never answers on its
   * own once a listener is installed.
   */
  addServerRequestListener(listener: CodexServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  /** Observes requests that app-server resolved before the client answered. */
  addServerRequestResolvedListener(
    listener: CodexServerRequestResolvedListener,
  ): () => void {
    this.serverRequestResolvedListeners.add(listener);
    return () => this.serverRequestResolvedListeners.delete(listener);
  }

  /** Number of server requests that still need an answer on this process. */
  get pendingServerRequestCount(): number {
    return this.pendingServerRequests.size;
  }

  /** Observes process termination in addition to the owner onExit callback. */
  addExitListener(listener: (message: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  get hasExited(): boolean {
    return this.closed;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * Stable identity of the spawned process. It is set synchronously after
   * spawn and is not erased by dispose(). Runtime exit protection must use
   * this value when start() fails and disposes the transport internally.
   */
  get stablePid(): number | undefined {
    return this.spawnedPid;
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.closed);
  }

  async start(): Promise<CodexInitializeInfo> {
    if (this.child) {
      throw new CodexProtocolError('codex-already-started', 'Codex CLI 已启动。');
    }
    const env = buildCodexEnvironment({      codexHome: this.codexHome,
      ...(this.apiKeyEnv ? { apiKeyEnv: this.apiKeyEnv } : {}),
    });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        this.invocation.command,
        [
          ...this.invocation.argsPrefix,
          ...CODEX_WINDOWS_SANDBOX_ARGS,
          'app-server',
          '--stdio',
        ],
        {
          cwd: this.cwd,
          env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      throw new CodexLaunchError(
        'cli-spawn-failed',
        '无法启动 Codex CLI。',
        { cause: error },
      );
    }
    this.child = child;
    this.spawnedPid = child.pid;
    this.stdin = child.stdin ?? undefined;
    this.stdout = child.stdout ?? undefined;
    this.stderr = child.stderr ?? undefined;
    child.on('error', (error) => {
      this.failAll(
        new CodexProtocolError('codex-spawn-error', 'Codex CLI 进程发生错误。'),
        'Codex CLI 进程错误。',
      );
      void error;
    });
    child.on('exit', (code, signal) => {
      const message = safeProcessExitMessage(code, signal);
      this.finish(message);
    });
    this.stdout?.setEncoding('utf8');
    this.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.stderr?.setEncoding('utf8');
    this.stderr?.on('data', (chunk: string) => {
      this.stderrBytes += Buffer.byteLength(chunk, 'utf8');
      // Stderr is never logged or forwarded. A healthy long-lived process may
      // legitimately accumulate warnings, so the bounded diagnostic only
      // records the first threshold instead of terminating the connection.
      if (
        this.stderrBytes > MAX_STDERR_BYTES &&
        !this.stderrLimitReported
      ) {
        this.stderrLimitReported = true;
        this.logger.warn('codex-stderr-observed', {
          bytes: this.stderrBytes,
          action: 'discarded',
        });
      }
    });

    const initialized = await this.request(
      'initialize',
      {
        clientInfo: {
          name: 'chatfgm',
          title: 'ChatFGM',
          version: '0.1.0',
        },
        // Needed for thread/settings/update, which is the supported way to
        // refresh developer instructions on an existing thread.
        capabilities: { experimentalApi: true },
      },
      12_000,
    );
    if (!initialized || typeof initialized !== 'object') {
      throw new CodexProtocolError(
        'codex-initialize-invalid',
        'Codex app-server 的 initialize 响应无效。',
      );
    }
    const info = initialized as Record<string, unknown>;
    if (typeof info.userAgent !== 'string') {
      throw new CodexProtocolError(
        'codex-initialize-invalid',
        'Codex app-server 没有返回 userAgent。',
      );
    }
    if (typeof info.codexHome !== 'string') {
      throw new CodexProtocolError(
        'codex-initialize-invalid',
        'Codex app-server 没有返回 CODEX_HOME。',
      );
    }
    let actualHome = info.codexHome;
    try {
      actualHome = realpathSync.native(actualHome);
    } catch {
      // Keep the reported value for the error.
    }
    let expectedHome = this.codexHome;
    try {
      expectedHome = realpathSync.native(expectedHome);
    } catch {
      // The caller creates it; fallback is still useful.
    }
    if (actualHome.toLowerCase() !== expectedHome.toLowerCase()) {
      this.dispose();
      throw new CodexProtocolError(
        'codex-home-not-isolated',
        'Codex CLI 没有使用应用隔离的 CODEX_HOME，已拒绝连接。',
      );
    }
    this.send({ method: 'initialized' });
    this.logger.info('codex-app-server-ready', {
      kind: this.invocation.kind,
      pid: this.pid ?? 0,
      userAgent: sanitizeExternalMessage(info.userAgent),
    });
    return {
      userAgent: info.userAgent,
      codexHome: actualHome,
      platformFamily:
        typeof info.platformFamily === 'string' ? info.platformFamily : undefined,
      platformOs:
        typeof info.platformOs === 'string' ? info.platformOs : undefined,
    };
  }

  async readAccount(): Promise<CodexAccount> {
    const result = await this.request('account/read', {
      refreshToken: false,
    });
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError(
        'codex-account-invalid',
        'Codex 账号响应格式无效。',
      );
    }
    const record = result as Record<string, unknown>;
    const account = record.account;
    if (!account || typeof account !== 'object') return { type: 'none' };
    const value = account as Record<string, unknown>;
    if (value.type === 'chatgpt') {
      return {
        type: 'chatgpt',
        email: typeof value.email === 'string' ? value.email : undefined,
        planType:
          typeof value.planType === 'string' ? value.planType : undefined,
      };
    }
    if (value.type === 'apiKey') return { type: 'apiKey' };
    return { type: 'other' };
  }

  async listModels(): Promise<CodexModel[]> {
    const result = await this.request('model/list', { includeHidden: false });
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError(
        'codex-models-invalid',
        'Codex 模型列表响应格式无效。',
      );
    }
    const data = (result as Record<string, unknown>).data;
    if (!Array.isArray(data)) {
      throw new CodexProtocolError(
        'codex-models-invalid',
        'Codex 模型列表缺少 data。',
      );
    }
    return data
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        model: typeof item.model === 'string' ? item.model : '',
        displayName:
          typeof item.displayName === 'string'
            ? item.displayName
            : typeof item.id === 'string'
              ? item.id
              : '',
        description:
          typeof item.description === 'string' ? item.description : undefined,
        hidden: item.hidden === true,
        isDefault: item.isDefault === true,
        defaultReasoningEffort:
          typeof item.defaultReasoningEffort === 'string'
            ? item.defaultReasoningEffort
            : undefined,
        supportedReasoningEfforts: Array.isArray(item.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts
              .filter(
                (option): option is Record<string, unknown> =>
                  Boolean(option && typeof option === 'object'),
              )
              .map((option) => ({
                reasoningEffort:
                  typeof option.reasoningEffort === 'string'
                    ? option.reasoningEffort
                    : '',
                description:
                  typeof option.description === 'string'
                    ? option.description
                    : undefined,
              }))
          : undefined,
        inputModalities: Array.isArray(item.inputModalities)
          ? item.inputModalities.filter(
              (modality): modality is string => typeof modality === 'string',
            )
          : undefined,
        contextWindow:
          typeof item.contextWindow === 'number' ? item.contextWindow : undefined,
        maxContextWindow:
          typeof item.maxContextWindow === 'number'
            ? item.maxContextWindow
            : undefined,
        supportsParallelToolCalls:
          item.supportsParallelToolCalls === true,
      }))
      .filter((model) => model.id.length > 0);
  }

  async startChatGptLogin(): Promise<CodexLoginStart> {
    const result = await this.request('account/login/start', {
      type: 'chatgpt',
      appBrand: 'chatgpt',
      useHostedLoginSuccessPage: false,
    });
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError(
        'codex-login-invalid',
        'Codex 登录响应格式无效。',
      );
    }
    const record = result as Record<string, unknown>;
    return {
      type: typeof record.type === 'string' ? record.type : '',
      loginId:
        typeof record.loginId === 'string' ? record.loginId : undefined,
      authUrl: typeof record.authUrl === 'string' ? record.authUrl : undefined,
      userCode:
        typeof record.userCode === 'string' ? record.userCode : undefined,
      verificationUrl:
        typeof record.verificationUrl === 'string'
          ? record.verificationUrl
          : undefined,
    };
  }

  async cancelChatGptLogin(loginId: string): Promise<string> {
    const result = await this.request('account/login/cancel', { loginId });
    if (!result || typeof result !== 'object') return 'unknown';
    const status = (result as Record<string, unknown>).status;
    return typeof status === 'string' ? status : 'unknown';
  }

  async logoutChatGpt(): Promise<void> {
    await this.request('account/logout', {});
  }

  /**
   * Reports the Windows sandbox readiness component of the installed CLI.
   * Older CLIs do not implement the method; callers treat that as unknown
   * rather than as a sandbox failure.
   */
  async readWindowsSandboxReadiness(): Promise<
    'ready' | 'notConfigured' | 'updateRequired' | 'unsupported'
  > {
    try {
      const result = await this.request('windowsSandbox/readiness', {}, 8_000);
      const status =
        result && typeof result === 'object'
          ? (result as Record<string, unknown>).status
          : undefined;
      return status === 'ready' ||
        status === 'notConfigured' ||
        status === 'updateRequired'
        ? status
        : 'unsupported';
    } catch (error) {
      if (
        error instanceof CodexProtocolError &&
        (error.code === 'codex-rpc-error' || error.code === 'codex-timeout')
      ) {
        return 'unsupported';
      }
      throw error;
    }
  }

  /**
   * Starts the CLI-owned Windows sandbox setup. The matching completion
   * notification is delivered on the normal notification stream.
   */
  async startWindowsSandboxSetup(
    mode: 'elevated' | 'unelevated',
    cwd?: string,
  ): Promise<boolean> {
    const result = await this.request(
      'windowsSandbox/setupStart',
      { mode, ...(cwd ? { cwd } : {}) },
      30_000,
    );
    return (
      Boolean(result) &&
      typeof result === 'object' &&
      (result as Record<string, unknown>).started === true
    );
  }

  async startThread(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.request('thread/start', params);
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError('codex-thread-invalid', 'Codex thread/start 响应无效。');
    }
    return result as Record<string, unknown>;
  }

  async startTurn(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.request('turn/start', params, 20_000);
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError('codex-turn-invalid', 'Codex turn/start 响应无效。');
    }
    return result as Record<string, unknown>;
  }

  async readThread(
    threadId: string,
    includeTurns = true,
  ): Promise<Record<string, unknown>> {
    const result = await this.request('thread/read', {
      threadId,
      includeTurns,
    });
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError('codex-thread-invalid', 'Codex thread/read 响应无效。');
    }
    return result as Record<string, unknown>;
  }

  async resumeThread(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.request('thread/resume', params);
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError(
        'codex-thread-invalid',
        'Codex thread/resume 响应无效。',
      );
    }
    return result as Record<string, unknown>;
  }

  async listThreadTurns(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.request('thread/turns/list', params);
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError(
        'codex-history-invalid',
        'Codex thread/turns/list 响应无效。',
      );
    }
    return result as Record<string, unknown>;
  }

  async listThreadItems(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.request('thread/items/list', params);
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError(
        'codex-history-invalid',
        'Codex thread/items/list 响应无效。',
      );
    }
    return result as Record<string, unknown>;
  }

  async interruptTurn(
    threadId: string,
    turnId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.request(
      'turn/interrupt',
      { threadId, turnId },
      10_000,
    );
    if (!result || typeof result !== 'object') {
      throw new CodexProtocolError(
        'codex-turn-invalid',
        'Codex turn/interrupt 响应无效。',
      );
    }
    return result as Record<string, unknown>;
  }

  /** Stops this connection's event subscription for a thread. */
  async unsubscribeThread(threadId: string): Promise<Record<string, unknown>> {    const result = await this.request(
      'thread/unsubscribe',
      { threadId },
      10_000,
    );
    return result && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : {};
  }

  async archiveThread(threadId: string): Promise<Record<string, unknown>> {
    return this.requestObject('thread/archive', { threadId });
  }

  async updateThreadSettings(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestObject('thread/settings/update', params);
  }

  async unarchiveThread(threadId: string): Promise<Record<string, unknown>> {
    return this.requestObject('thread/unarchive', { threadId });
  }

  private async requestObject(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.request(method, params);
    return result && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : {};
  }

  /** Active background terminals owned by a thread (if the CLI exposes them). */
  async listBackgroundTerminals(
    threadId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.request(
      'thread/backgroundTerminals/list',
      { threadId },
      10_000,
    );
    const data =
      result && typeof result === 'object'
        ? (result as Record<string, unknown>).data
        : null;
    return Array.isArray(data)
      ? data.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) && typeof entry === 'object',
        )
      : [];
  }

  async terminateBackgroundTerminal(
    threadId: string,
    processId: string,
  ): Promise<boolean> {
    const result = await this.request(
      'thread/backgroundTerminals/terminate',
      { threadId, processId },
      15_000,
    );
    return Boolean(
      result &&
        typeof result === 'object' &&
        (result as Record<string, unknown>).terminated === true,
    );
  }

  /** Thread ids currently loaded in the app-server process. */
  async listLoadedThreads(): Promise<string[]> {
    const result = await this.request(
      'thread/loaded/list',
      { limit: 200 },
      10_000,
    );
    const data =
      result && typeof result === 'object'
        ? (result as Record<string, unknown>).data
        : null;
    return Array.isArray(data)
      ? data.filter((id): id is string => typeof id === 'string')
      : [];
  }

  waitForNotification(
    predicate: (notification: CodexNotification) => boolean,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CodexNotification> {
    const existingIndex = this.notifications.findIndex(predicate);
    if (existingIndex >= 0) {
      return Promise.resolve(this.notifications.splice(existingIndex, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(
            new CodexProtocolError(
              'codex-notification-timeout',
              '等待 Codex 事件超时。',
            ),
          );
        }, timeoutMs),
      };
      this.notificationWaiters.add(waiter);
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.expireServerRequests();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new CodexProtocolError('codex-disposed', 'Codex CLI 连接已关闭。'),
      );
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new CodexProtocolError('codex-disposed', 'Codex CLI 连接已关闭。'),
      );
    }
    this.notificationWaiters.clear();
    try {
      this.stdin?.end();
    } catch {
      // Ignore a closed stdin.
    }
    const pid = this.child?.pid;
    if (pid) {
      try {
        spawnSync(
          'taskkill',
          ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore', timeout: 3000 },
        );
      } catch {
        // Fall through to kill.
      }
      try {
        this.child?.kill();
      } catch {
        // Ignore a process that already exited.
      }
    }
    this.child = undefined;
    this.stdout = undefined;
    this.stderr = undefined;
    this.stdin = undefined;
  }

  private async request(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed || !this.child) {
      throw new CodexProtocolError('codex-not-connected', 'Codex CLI 未连接。');
    }
    const id = this.nextId++;
    // Write before allocating the pending slot. A failed write proves that the
    // request never reached the server, which callers such as the chat send
    // path must be able to distinguish from a lost acknowledgement.
    this.send({ id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexProtocolError(
            'codex-timeout',
            `Codex 操作超时（${method}）。`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.stdin || this.closed) {
      throw new CodexProtocolError('codex-not-connected', 'Codex CLI 未连接。');
    }
    try {
      this.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      throw new CodexProtocolError(
        'codex-write-failed',
        '无法向 Codex CLI 写入请求。',
      );
    }
  }

  private serverRequestKey(id: number | string): string {
    return `${typeof id === 'number' ? 'n' : 's'}:${String(id)}`;
  }

  private dispatchServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    const key = this.serverRequestKey(id);
    if (this.pendingServerRequests.has(key)) {
      // A duplicate JSON-RPC id never replaces the original pending request.
      try {
        this.send({
          id,
          error: { code: -32600, message: 'Duplicate server request id' },
        });
      } catch {
        // The process is going away.
      }
      return;
    }
    if (this.serverRequestListeners.size === 0) {
      // Without an installed handler, refuse explicitly instead of letting
      // app-server wait forever. This is also the settings/auth behaviour.
      try {
        this.send({
          id,
          error: { code: -32601, message: 'Unsupported request' },
        });
      } catch {
        // The process is going away.
      }
      return;
    }
    const state: PendingServerRequest = {
      id,
      method,
      params,
      responded: false,
    };
    this.pendingServerRequests.set(key, state);
    const isPending = () =>
      !this.closed &&
      !state.responded &&
      this.pendingServerRequests.get(key) === state;
    const request: CodexServerRequest = {
      key,
      id,
      method,
      params,
      get pending() {
        return isPending();
      },
      respond: (result) =>
        this.settleServerRequest(key, state, { result }),
      reject: (code, message) =>
        this.settleServerRequest(key, state, { error: { code, message } }),
    };
    for (const listener of [...this.serverRequestListeners]) {
      try {
        listener(request);
      } catch (error) {
        this.logger.warn('codex-server-request-listener-failed', {
          method,
          message:
            error instanceof Error
              ? sanitizeExternalMessage(error.message)
              : 'unknown',
        });
        request.reject(-32603, 'Internal error');
      }
    }
  }

  private settleServerRequest(
    key: string,
    state: PendingServerRequest,
    payload: { result?: unknown; error?: { code: number; message: string } },
  ): boolean {
    // The callback belongs to one concrete pending-state object. A resolved
    // request whose JSON-RPC id is later reused must never settle its successor.
    if (
      this.pendingServerRequests.get(key) !== state ||
      state.responded ||
      this.closed
    ) {
      return false;
    }
    state.responded = true;
    this.pendingServerRequests.delete(key);
    try {
      this.send({
        id: state.id,
        ...(payload.error ? { error: payload.error } : { result: payload.result ?? null }),
      });
      return true;
    } catch {
      return false;
    }
  }

  private expireServerRequests(): void {
    for (const state of this.pendingServerRequests.values()) {
      state.responded = true;
    }
    this.pendingServerRequests.clear();
  }

  private onStdout(chunk: string): void {
    this.outputBuffer += chunk;
    if (Buffer.byteLength(this.outputBuffer, 'utf8') > MAX_BUFFER_BYTES) {
      this.failAll(
        new CodexProtocolError(
          'codex-buffer-limit',
          'Codex CLI 单条消息超过限制。',
        ),
        'Codex CLI 单条消息超过限制。',
      );
      return;
    }
    let newline = this.outputBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.outputBuffer.slice(0, newline).trim();
      this.outputBuffer = this.outputBuffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.outputBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failAll(
        new CodexProtocolError(
          'codex-protocol-error',
          'Codex CLI 返回了无效协议数据。',
        ),
        'Codex CLI 协议错误。',
      );
      return;
    }
    if (!message || typeof message !== 'object') {
      this.failAll(
        new CodexProtocolError(
          'codex-protocol-error',
          'Codex CLI 返回了无效协议数据。',
        ),
        'Codex CLI 协议错误。',
      );
      return;
    }
    const record = message as Record<string, unknown>;
    if (record.id !== undefined && typeof record.method !== 'string') {
      const id = Number(record.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (record.error !== undefined) {
        pending.reject(parseRpcError(record.error));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (
      (typeof record.id === 'string' || typeof record.id === 'number') &&
      typeof record.method === 'string'
    ) {
      this.dispatchServerRequest(record.id, record.method, record.params);
      return;
    }
    if (typeof record.method === 'string') {
      if (record.method === 'serverRequest/resolved') {
        this.resolveServerRequestNotification(record.params);
        return;
      }
      const notification: CodexNotification = {
        method: record.method,
        params: record.params,
      };
      try {
        this.onNotification?.(notification);
      } catch (error) {
        this.logger.warn('codex-notification-handler-failed', {
          method: notification.method,
          message:
            error instanceof Error
              ? sanitizeExternalMessage(error.message)
              : 'unknown',
        });
      }
      for (const listener of this.notificationListeners) {
        try {
          listener(notification);
        } catch (error) {
          this.logger.warn('codex-notification-listener-failed', {
            method: notification.method,
            message:
              error instanceof Error
                ? sanitizeExternalMessage(error.message)
                : 'unknown',
          });
        }
      }
      const waiter = [...this.notificationWaiters].find((item) =>
        item.predicate(notification),
      );
      if (waiter) {
        this.notificationWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(notification);
      } else if (this.notificationRetention > 0) {
        this.notifications.push(notification);
        if (this.notifications.length > this.notificationRetention) {
          this.notifications.shift();
        }
      }
    }
  }

  private resolveServerRequestNotification(params: unknown): void {
    const record =
      params && typeof params === 'object'
        ? (params as Record<string, unknown>)
        : {};
    const requestId = record.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') {
      return;
    }
    const threadId =
      typeof record.threadId === 'string' ? record.threadId : '';
    const key = this.serverRequestKey(requestId);
    const state = this.pendingServerRequests.get(key);
    if (!state) return;
    // A resolved notification is scoped to its thread. Do not expire a
    // same-id request that belongs to another thread.
    const stateThreadId = requestThreadId(state.params);
    if (threadId && stateThreadId && threadId !== stateThreadId) return;
    state.responded = true;
    this.pendingServerRequests.delete(key);
    const resolved: CodexServerRequestResolved = {
      key,
      id: state.id,
      method: state.method,
      threadId,
      requestId,
    };
    for (const listener of [...this.serverRequestResolvedListeners]) {
      try {
        listener(resolved);
      } catch (error) {
        this.logger.warn('codex-server-request-resolved-listener-failed', {
          method: state.method,
          message:
            error instanceof Error
              ? sanitizeExternalMessage(error.message)
              : 'unknown',
        });
      }
    }
  }

  private failAll(error: CodexProtocolError, message: string): void {
    if (this.closed) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
    this.logger.warn('codex-protocol-failure', { message });
    this.dispose();
    this.notifyExit(message);
  }

  private finish(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.expireServerRequests();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new CodexProtocolError('codex-exited', message),
      );
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new CodexProtocolError('codex-exited', message));
    }
    this.notificationWaiters.clear();
    this.notifyExit(message);
  }

  private notifyExit(message: string): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    try {
      this.onExit?.(message);
    } catch (error) {
      this.logger.warn('codex-exit-handler-failed', {
        message:
          error instanceof Error
            ? sanitizeExternalMessage(error.message)
            : 'unknown',
      });
    }
    for (const listener of this.exitListeners) {
      try {
        listener(message);
      } catch (error) {
        this.logger.warn('codex-exit-listener-failed', {
          message:
            error instanceof Error
              ? sanitizeExternalMessage(error.message)
              : 'unknown',
        });
      }
    }
  }
}

export function readCodexVersion(
  invocation: CodexInvocation,
  codexHome: string,
  logger: Logger,
): string {
  const env = buildCodexEnvironment({ codexHome });
  const result = spawnSync(
    invocation.command,
    [...invocation.argsPrefix, '--version'],
    {
      cwd: codexHome,
      env,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 6000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    logger.warn('codex-version-failed', {
      status: result.status ?? -1,
    });
    throw new CodexLaunchError(
      'cli-version-failed',
      'Codex CLI 版本检测失败。',
      result.error ? { cause: result.error } : undefined,
    );
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = output.match(/codex(?:-cli)?\s+([0-9][0-9A-Za-z.+-]*)/i);
  if (!match) {
    throw new CodexLaunchError(
      'cli-version-invalid',
      'Codex CLI 没有返回可识别的版本号。',
    );
  }
  return match[1]!;
}
