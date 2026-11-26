import { detectionTiming } from './timing';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  SettingsChatGptAccount,
  SettingsCliDetection,
  SettingsModelRuntime,
  SettingsRuntimeState,
  SettingsToolboxRuntime,
} from '../ipc/capabilities';
import type { Logger } from '../platform/log';
import {
  CodexAppServerProcess,
  CodexLaunchError,
  readCodexVersion,
  resolveCodexInvocation,
  type CodexInvocation,
  type CodexNotification,
} from './codex';
import type { DeepSeekDiscovery } from './deepseek';
import { buildDeepSeekConfig, DeepSeekClient } from './deepseek';
import type { SecretCipher, SettingsStore, StoredSettings } from './store';

export class SettingsRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SettingsRuntimeError';
    this.code = code;
  }
}

export interface SettingsRuntimeDependencies {
  store: SettingsStore;
  cipher: SecretCipher;
  logger: Logger;
  codexRoot: string;
  openExternal: (url: string) => Promise<void>;
  deepSeek: DeepSeekClient;
}

type Listener = (runtime: SettingsRuntimeState) => void;

/**
 * One ChatGPT login attempt. `id` exists before the remote loginId is known so
 * every asynchronous result can be tied to the attempt that produced it.
 */
interface ChatGptLoginAttempt {
  readonly id: number;
  /** Auth instance that owns the remote authorization. */
  readonly auth: CodexAppServerProcess;
  /** Auth lifecycle generation captured when the attempt started. */
  readonly authGeneration: number;
  loginId?: string;
  /** Set once the attempt may no longer commit shared login state. */
  invalidated: boolean;
  /** Set before a cancel RPC for this attempt is sent, so it is sent once. */
  cancelSent: boolean;
}

/**
 * Login-state ownership captured before awaiting a current operation. A result
 * may commit only while the same auth, auth generation and login epoch remain
 * current and no attempt is pending.
 */
interface LoginOwnership {
  readonly auth: CodexAppServerProcess | undefined;
  readonly authGeneration: number;
  readonly loginEpoch: number;
}

type LoginCompletion = {
  success: boolean;
  error?: unknown;
};

function accountFromUnknown(value: unknown): SettingsChatGptAccount {
  if (!value || typeof value !== 'object') {
    return { status: 'logged-out' };
  }
  const account = value as Record<string, unknown>;
  if (account.type === 'chatgpt') {
    return {
      status: 'logged-in',
      ...(typeof account.email === 'string' && account.email
        ? { email: account.email }
        : {}),
    };
  }
  return { status: 'logged-out' };
}

function validAuthUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsRuntimeError(
      'chatgpt-auth-url-invalid',
      'ChatGPT 授权地址无效。',
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !(
      url.hostname === 'openai.com' ||
      url.hostname.endsWith('.openai.com') ||
      url.hostname === 'chatgpt.com' ||
      url.hostname.endsWith('.chatgpt.com')
    )
  ) {
    throw new SettingsRuntimeError(
      'chatgpt-auth-url-untrusted',
      'ChatGPT 返回了不受信任的授权地址，已拒绝打开。',
    );
  }
  return url.toString();
}

function sanitizeMessage(value: unknown): string {
  if (typeof value !== 'string') return 'ChatGPT 授权失败。';
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:code|token|state|key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .slice(0, 500);
}

export class SettingsRuntime {
  private readonly store: SettingsStore;
  private readonly cipher: SecretCipher;
  private readonly logger: Logger;
  private readonly codexRoot: string;
  private readonly authHome: string;
  private readonly modelHome: string;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly deepSeek: DeepSeekClient;
  private readonly listeners = new Set<Listener>();

  private config?: StoredSettings;
  private auth?: CodexAppServerProcess;
  private authInvocation?: CodexInvocation;
  private authPath = '';
  private authVersion = '';
  private model?: CodexAppServerProcess;
  private modelPreparation?: AbortController;
  private modelStatus: SettingsModelRuntime = { state: 'inactive' };
  private account: SettingsChatGptAccount = { status: 'logged-out' };
  private login?: ChatGptLoginAttempt;
  /** Monotonic local attempt identity; independent of any remote loginId. */
  private loginAttemptSequence = 0;
  /** Shared login-state version; every login transition invalidates it. */
  private loginEpoch = 0;
  private readonly cancelledLoginIds = new Set<string>();
  private readonly handledLoginIds = new Set<string>();
  private readonly earlyLoginCompletions = new Map<string, LoginCompletion>();
  private candidate?: CodexAppServerProcess;
  private candidateCancelled = false;
  /** Auth lifecycle generation; replaced/removed auth instances are not current. */
  private authGeneration = 0;
  private runtimeRevision = 1;
  private cliState: SettingsRuntimeState['cli'] = {
    state: 'not-configured',
  };
  private toolboxEnvironments: Record<string, SettingsToolboxRuntime> = {};
  private sandbox: {
    state: 'ready' | 'unavailable' | 'unknown';
    message: string;
  } = { state: 'unknown', message: '尚未检测 Windows 沙箱。' };
  private disposed = false;
  private initialization?: Promise<void>;

  constructor(dependencies: SettingsRuntimeDependencies) {
    this.store = dependencies.store;
    this.cipher = dependencies.cipher;
    this.logger = dependencies.logger;
    this.codexRoot = dependencies.codexRoot;
    this.authHome = path.join(this.codexRoot, 'auth');
    this.modelHome = path.join(this.codexRoot, 'model');
    this.openExternal = dependencies.openExternal;
    this.deepSeek = dependencies.deepSeek;
    mkdirSync(this.authHome, { recursive: true });
    const authConfig = path.join(this.authHome, 'config.toml');
    if (!existsSync(authConfig)) {
      writeFileSync(
        authConfig,
        '# ChatFGM-managed Codex home. Credentials remain managed by Codex.\n',
        'utf8',
      );
    }
  }

  get runtime(): SettingsRuntimeState {
    return {
      revision: this.runtimeRevision,
      cli: { ...this.cliState },
      chatgpt: { ...this.account },
      models: { ...this.modelStatus },
      toolboxEnvironments: { ...this.toolboxEnvironments },
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(config: StoredSettings): Promise<void> {
    if (this.initialization) return this.initialization;
    this.config = config;
    this.initialization = this.applyConfigInternal(config).catch((error) => {
      this.logger.error('settings-runtime-initialize-failed', {
        message: sanitizeMessage(error instanceof Error ? error.message : error),
      });
      this.authPath = config.cli.path;
      this.cliState = {
        state: config.cli.path ? 'error' : 'not-configured',
        ...(config.cli.path ? { path: config.cli.path } : {}),
        message:
          error instanceof Error
            ? sanitizeMessage(error.message)
            : 'Codex CLI 运行层初始化失败。',
      };
      this.account = { status: 'logged-out', message: this.cliState.message };
      this.emit();
    });
    return this.initialization;
  }

  async applyConfig(config: StoredSettings): Promise<void> {
    this.config = config;
    await this.applyConfigInternal(config);
  }

  /**
   * Updates the saved configuration reference without replacing the actual
   * auth/model processes. Used for field changes that cannot affect the
   * current runtime (display names, unrelated toolbox environments).
   */
  setConfigOnly(config: StoredSettings): void {
    this.config = config;
  }

  private async applyConfigInternal(config: StoredSettings): Promise<void> {
    this.authGeneration += 1;
    const generation = this.authGeneration;
    this.clearLoginState();
    this.stopAuth();
    this.authPath = config.cli.path;
    if (!config.cli.path) {
      this.cliState = { state: 'not-configured' };
      this.account = { status: 'logged-out' };
      this.modelStatus = { state: 'inactive' };
      this.stopModel();
      this.emit();
      return;
    }
    this.cliState = {
      state: 'connecting',
      path: config.cli.path,
    };
    this.account = { status: 'logged-out' };
    this.emit();
    try {
      const invocation = resolveCodexInvocation(config.cli.path);
      const version = readCodexVersion(invocation, this.authHome, this.logger);
      const auth = await this.startAuth(invocation, this.authHome);
      if (generation !== this.authGeneration || this.disposed) {
        auth.dispose();
        return;
      }
      this.candidate = undefined;
      this.auth = auth;
      this.authInvocation = invocation;
      this.authVersion = version;
      this.cliState = {
        state: 'connected',
        path: config.cli.path,
        version,
      };
      await this.refreshAccount();
      this.sandbox = await this.detectSandbox(auth);
      this.emit();
    } catch (error) {
      if (generation !== this.authGeneration || this.disposed) return;
      this.cliState = {
        state: 'error',
        path: config.cli.path,
        message: sanitizeMessage(
          error instanceof Error ? error.message : String(error),
        ),
      };
      this.account = {
        status: 'logged-out',
        message: this.cliState.message,
      };
      this.emit();
    }
    await this.prepareModel(config, generation);
  }

  async detectCli(pathValue: string): Promise<SettingsCliDetection> {
    const timing = detectionTiming(this.logger, 'cli');
    if (this.candidate) {
      this.candidate.dispose();
      this.candidate = undefined;
    }
    this.candidateCancelled = false;
    let invocation: CodexInvocation;
    let version: string;
    try {
      invocation = resolveCodexInvocation(pathValue);
      version = readCodexVersion(invocation, this.authHome, this.logger);
      timing('version');
    } catch (error) {
      const message = sanitizeMessage(
        error instanceof Error ? error.message : String(error),
      );
      if (!this.auth) {
        this.cliState = {
          state: 'error',
          path: pathValue,
          message,
        };
        this.account = { status: 'logged-out', message };
        this.emit();
      }
      throw new SettingsRuntimeError(
        error instanceof CodexLaunchError
          ? error.code
          : 'cli-version-failed',
        message,
        { cause: error },
      );
    }
    let candidate: CodexAppServerProcess;
    try {
      candidate = await this.startAuth(invocation, this.authHome, true);
      timing('handshake');
    } catch (error) {
      const message = sanitizeMessage(
        error instanceof Error ? error.message : String(error),
      );
      if (!this.auth) {
        this.cliState = {
          state: 'error',
          path: pathValue,
          message,
        };
        this.account = { status: 'logged-out', message };
        this.emit();
      }
      throw new SettingsRuntimeError(
        error instanceof CodexLaunchError
          ? error.code
          : 'cli-connect-failed',
        message,
        { cause: error },
      );
    }
    if (this.candidateCancelled) {
      candidate.dispose();
      throw new SettingsRuntimeError(
        'cli-cancelled',
        'Codex CLI 检测已取消。',
      );
    }
    // Candidate has completed the protocol handshake. Swap only now so a
    // failed candidate never destroys an older working instance.
    this.stopAuth();
    // A new auth instance starts a new lifecycle generation; attempts created
    // against the previous instance can never commit again.
    this.authGeneration += 1;
    const generation = this.authGeneration;
    this.auth = candidate;
    this.authInvocation = invocation;
    this.authVersion = version;
    this.authPath = pathValue;
    this.candidate = undefined;
    this.cliState = {
      state: 'connected',
      path: pathValue,
      version,
    };
    this.account = { status: 'logged-out' };
    await this.refreshAccount();
    timing('account');
    this.sandbox = await this.detectSandbox(this.auth);
    timing('sandbox');
    this.emit();
    if (this.config) {
      // CLI detection has already verified version, handshake, account and
      // sandbox. Model readiness has its own state and failure propagation;
      // API discovery must not hold the independent CLI result open.
      void this.prepareModel(this.config, generation);
      timing('model-preparation-started');
    }
    return {
      version,
      runtime: { ...this.cliState },
      message:
        this.sandbox.state === 'ready'
          ? 'Windows 沙箱可用。'
          : this.sandbox.message,
    };
  }

  cancelDetection(): void {
    this.candidateCancelled = true;
    this.candidate?.dispose();
    this.candidate = undefined;
  }

  /**
   * Verifies the Windows sandbox backend of the connected CLI. When the CLI
   * reports `notConfigured` the CLI-owned setup is requested once and the
   * readiness is re-read. Failure is reported, never bypassed by silently
   * selecting full access.
   */
  private async detectSandbox(
    process: CodexAppServerProcess,
  ): Promise<{ state: 'ready' | 'unavailable' | 'unknown'; message: string }> {
    try {
      let status = await process.readWindowsSandboxReadiness();
      if (status === 'ready') {
        return { state: 'ready', message: 'Windows 沙箱已就绪。' };
      }
      if (status === 'updateRequired') {
        return {
          state: 'unavailable',
          message:
            'Windows 沙箱组件版本不匹配，需要更新 Codex CLI；写权限执行不会被静默放行。',
        };
      }
      if (status === 'unsupported') {
        return {
          state: 'unknown',
          message: '当前 Codex CLI 未提供 Windows 沙箱状态接口，写权限执行结果以实际命令为准。',
        };
      }
      const completion = process
        .waitForNotification(
          (notification) =>
            notification.method === 'windowsSandbox/setupCompleted',
          25_000,
        )
        .catch(() => null);
      const started = await process
        .startWindowsSandboxSetup('unelevated')
        .catch(() => false);
      if (started) {
        const notification = await completion;
        const params =
          notification && notification.params && typeof notification.params === 'object'
            ? (notification.params as Record<string, unknown>)
            : {};
        if (params.success !== true) {
          return {
            state: 'unavailable',
            message: `Windows 沙箱初始化失败${
              typeof params.error === 'string' && params.error
                ? `：${sanitizeMessage(params.error)}`
                : '。'
            } 写权限执行不会被静默放行。`,
          };
        }
        status = await process.readWindowsSandboxReadiness();
      }
      if (status === 'ready') {
        return {
          state: 'ready',
          message: 'Windows 沙箱已初始化并通过检测。',
        };
      }
      return {
        state: 'unavailable',
        message:
          'Windows 沙箱不可用；只读对话仍可使用，写权限请求不会被静默放行。',
      };
    } catch (error) {
      return {
        state: 'unknown',
        message: `Windows 沙箱状态无法确认：${sanitizeMessage(
          error instanceof Error ? error.message : String(error),
        )}`,
      };
    }
  }

  async startChatGptLogin(): Promise<SettingsChatGptAccount> {
    const auth = this.requireAuth();
    if (this.login) {
      throw new SettingsRuntimeError(
        'chatgpt-login-pending',
        'ChatGPT 授权正在进行，请稍候。',
      );
    }
    if (this.account.status === 'logged-in') return { ...this.account };
    const attempt: ChatGptLoginAttempt = {
      id: ++this.loginAttemptSequence,
      auth,
      authGeneration: this.authGeneration,
      invalidated: false,
      cancelSent: false,
    };
    this.login = attempt;
    this.loginEpoch += 1;
    this.account = { status: 'authorizing' };
    this.emit();
    try {
      const login = await auth.startChatGptLogin();
      if (!this.canCommitLogin(attempt)) {
        // The attempt lost ownership while its start reply was in flight. It
        // may consume that reply and clean up its own remote authorization.
        await this.settleAbandonedAttempt(attempt, login.loginId);
        return { ...this.account };
      }
      if (login.loginId) {
        attempt.loginId = login.loginId;
        const early = this.earlyLoginCompletions.get(login.loginId);
        if (early) {
          this.earlyLoginCompletions.delete(login.loginId);
          await this.finishPendingLogin(attempt, early);
          return { ...this.account };
        }
        // No successor attempt can exist while this attempt is current, so
        // every other buffered id is unattributable and can be dropped.
        for (const id of this.earlyLoginCompletions.keys()) {
          if (id !== login.loginId) this.earlyLoginCompletions.delete(id);
        }
      }
      if (login.type !== 'chatgpt' || !login.loginId || !login.authUrl) {
        throw new SettingsRuntimeError(
          'chatgpt-login-invalid',
          'Codex 没有返回可用的 ChatGPT 授权地址。',
        );
      }
      const authUrl = validAuthUrl(login.authUrl);
      // Cancellation can occur between the RPC reply and this assignment.
      if (!this.canCommitLogin(attempt)) {
        await this.settleAbandonedAttempt(attempt, login.loginId);
        return { ...this.account };
      }
      // No shared login state is written after this await: a cancelled attempt
      // cannot open a page or commit a successor's state from a late result.
      await this.openExternal(authUrl);
      return { ...this.account };
    } catch (error) {
      if (!this.canCommitLogin(attempt)) {
        await this.settleAbandonedAttempt(attempt, attempt.loginId);
        return { ...this.account };
      }
      // The current authorization failed. Publish and invalidate only this
      // attempt before waiting for its remote cancellation; a successor may
      // start while the cancel RPC is pending.
      const failureMessage = sanitizeMessage(
        error instanceof Error ? error.message : String(error),
      );
      this.retireLogin(attempt);
      this.account = {
        status: 'logged-out',
        message: failureMessage,
      };
      this.emit();
      if (attempt.loginId) {
        await this.cancelAttempt(attempt, attempt.loginId);
      }
      if (error instanceof SettingsRuntimeError) throw error;
      throw new SettingsRuntimeError(
        'chatgpt-login-failed',
        failureMessage || 'ChatGPT 授权启动失败。',
        { cause: error },
      );
    }
  }

  async cancelChatGptLogin(): Promise<SettingsChatGptAccount> {
    const login = this.login;
    if (login) this.retireLogin(login);
    // Capture ownership only after the local invalidation: this cancel is a
    // current user operation, not a late result of the retired attempt. The
    // snapshot must not be re-sampled after the cancel RPC returns.
    const owner = this.captureLoginOwnership();
    if (login?.loginId) {
      await this.cancelAttempt(login, login.loginId);
    }
    // Do not clear completion notifications here: a successor may have
    // buffered its own completion while this cancel RPC was pending.
    if (!this.ownsLoginState(owner) || !owner.auth) {
      return { ...this.account };
    }
    await this.refreshAccount(true);
    this.emit();
    return { ...this.account };
  }

  /** True only while this attempt still owns the shared login state. */
  private canCommitLogin(attempt: ChatGptLoginAttempt): boolean {
    return (
      !this.disposed &&
      !attempt.invalidated &&
      this.login === attempt &&
      attempt.auth === this.auth &&
      attempt.authGeneration === this.authGeneration
    );
  }

  /** Locally invalidate an attempt; no remote call and no publication. */
  private retireLogin(attempt: ChatGptLoginAttempt): void {
    attempt.invalidated = true;
    if (this.login === attempt) this.login = undefined;
    this.loginEpoch += 1;
  }

  private captureLoginOwnership(): LoginOwnership {
    return {
      auth: this.auth,
      authGeneration: this.authGeneration,
      loginEpoch: this.loginEpoch,
    };
  }

  private ownsLoginState(owner: LoginOwnership): boolean {
    return (
      !this.disposed &&
      this.auth === owner.auth &&
      this.authGeneration === owner.authGeneration &&
      this.loginEpoch === owner.loginEpoch &&
      this.login === undefined
    );
  }

  /**
   * Cancel the remote authorization of one attempt at most once. The intent is
   * registered before the RPC so overlapping user cancel, failure cleanup and
   * late replies can never send a second cancel.
   */
  private async cancelAttempt(
    attempt: ChatGptLoginAttempt,
    loginId: string,
  ): Promise<void> {
    attempt.loginId ??= loginId;
    this.earlyLoginCompletions.delete(loginId);
    if (attempt.cancelSent) return;
    attempt.cancelSent = true;
    this.rememberCancelledLogin(loginId);
    await this.cancelLoginOn(attempt.auth, loginId);
  }

  /**
   * An abandoned attempt may consume its own reply and clean up its own remote
   * loginId on its own auth. It must not refresh the account, publish state or
   * touch a successor.
   */
  private async settleAbandonedAttempt(
    attempt: ChatGptLoginAttempt,
    loginId: string | undefined,
  ): Promise<void> {
    attempt.invalidated = true;
    const remoteLoginId = loginId ?? attempt.loginId;
    if (remoteLoginId) await this.cancelAttempt(attempt, remoteLoginId);
  }

  private async cancelLoginOn(
    auth: CodexAppServerProcess,
    loginId: string,
  ): Promise<void> {
    try {
      await auth.cancelChatGptLogin(loginId);
    } catch (error) {
      this.logger.warn('chatgpt-cancel-failed', {
        message: sanitizeMessage(
          error instanceof Error ? error.message : error,
        ),
      });
    }
  }

  private clearLoginState(): void {
    if (this.login) this.retireLogin(this.login);
    // A lifecycle boundary also invalidates outstanding ownership snapshots
    // and notification records that can no longer be attributed.
    this.loginEpoch += 1;
    this.earlyLoginCompletions.clear();
    this.cancelledLoginIds.clear();
    this.handledLoginIds.clear();
  }

  private rememberCancelledLogin(loginId: string): void {
    this.cancelledLoginIds.add(loginId);
    if (this.cancelledLoginIds.size > 20) {
      const first = this.cancelledLoginIds.values().next().value;
      if (typeof first === 'string') this.cancelledLoginIds.delete(first);
    }
  }

  private rememberHandledLogin(loginId: string): void {
    this.handledLoginIds.add(loginId);
    if (this.handledLoginIds.size > 20) {
      const first = this.handledLoginIds.values().next().value;
      if (typeof first === 'string') this.handledLoginIds.delete(first);
    }
  }

  private rememberEarlyCompletion(
    loginId: string,
    completion: LoginCompletion,
  ): void {
    // The first completion for an id is the only one that can be attributed;
    // a later duplicate must not replace it.
    if (this.earlyLoginCompletions.has(loginId)) return;
    this.earlyLoginCompletions.set(loginId, completion);
    if (this.earlyLoginCompletions.size > 8) {
      const first = this.earlyLoginCompletions.keys().next().value;
      if (typeof first === 'string') this.earlyLoginCompletions.delete(first);
    }
  }

  private async finishPendingLogin(
    attempt: ChatGptLoginAttempt,
    completion: LoginCompletion,
  ): Promise<void> {
    if (!this.canCommitLogin(attempt)) return;
    this.retireLogin(attempt);
    if (attempt.loginId) {
      this.rememberHandledLogin(attempt.loginId);
      this.earlyLoginCompletions.delete(attempt.loginId);
    }
    if (completion.success !== true) {
      this.account = {
        status: 'logged-out',
        message:
          sanitizeMessage(completion.error) || 'ChatGPT 授权失败。',
      };
      this.emit();
      return;
    }
    // A success notification is not a login result. Confirm the actual
    // account before presenting logged-in.
    await this.refreshAccount();
    this.emit();
  }

  async logoutChatGpt(): Promise<SettingsChatGptAccount> {
    const auth = this.requireAuth();
    this.clearLoginState();
    const owner = this.captureLoginOwnership();
    try {
      await auth.logoutChatGpt();
    } catch (error) {
      throw new SettingsRuntimeError(
        'chatgpt-logout-failed',
        `退出 ChatGPT 失败：${sanitizeMessage(
          error instanceof Error ? error.message : error,
        )}`,
        { cause: error },
      );
    }
    if (!this.ownsLoginState(owner)) return { ...this.account };
    await this.refreshAccount(true);
    this.emit();
    return { ...this.account };
  }

  setToolboxRuntime(
    toolboxId: string,
    runtime: SettingsToolboxRuntime | null,
  ): void {
    if (runtime) {
      this.toolboxEnvironments = {
        ...this.toolboxEnvironments,
        [toolboxId]: runtime,
      };
    } else {
      const next = { ...this.toolboxEnvironments };
      delete next[toolboxId];
      this.toolboxEnvironments = next;
    }
    this.emit();
  }

  applyToolboxRuntimeMap(
    environments: Record<string, SettingsToolboxRuntime>,
  ): void {
    this.toolboxEnvironments = { ...environments };
    this.emit();
  }

  pruneToolboxRuntimes(
    validToolboxIds: readonly string[],
    validPaths?: Readonly<Record<string, string>>,
  ): void {
    const valid = new Set(validToolboxIds);
    const next = Object.fromEntries(
      Object.entries(this.toolboxEnvironments).filter(([id, runtime]) => {
        if (!valid.has(id)) return false;
        if (!validPaths) return true;
        const expected = validPaths[id];
        return (
          typeof runtime.path === 'string' &&
          typeof expected === 'string' &&
          runtime.path.toLowerCase() === expected.toLowerCase()
        );
      }),
    );
    if (
      Object.keys(next).length !== Object.keys(this.toolboxEnvironments).length
    ) {
      this.toolboxEnvironments = next;
      this.emit();
    }
  }

  get authProcess(): CodexAppServerProcess | undefined {
    return this.auth;
  }

  get currentInvocation(): CodexInvocation | undefined {
    return this.authInvocation;
  }

  /** Actual Windows sandbox readiness of the connected CLI. */
  get sandboxStatus(): { state: 'ready' | 'unavailable' | 'unknown'; message: string } {
    return { ...this.sandbox };
  }

  get currentVersion(): string {
    return this.authVersion;
  }

  get currentConfig(): StoredSettings | undefined {
    return this.config;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.authGeneration += 1;
    this.clearLoginState();
    this.candidate?.dispose();
    this.candidate = undefined;
    this.stopAuth();
    this.stopModel();
    this.listeners.clear();
  }

  private async startAuth(
    invocation: CodexInvocation,
    home: string,
    asCandidate = false,
  ): Promise<CodexAppServerProcess> {
    const auth = new CodexAppServerProcess({
      invocation,
      codexHome: home,
      logger: this.logger,
      onNotification: (notification) =>
        this.onAuthNotification(auth, notification),
      onExit: (message) => this.onAuthExit(auth, message),
    });
    if (asCandidate) this.candidate = auth;
    try {
      await auth.start();
      return auth;
    } catch (error) {
      auth.dispose();
      if (this.candidate === auth) this.candidate = undefined;
      throw error;
    }
  }

  private stopAuth(): void {
    this.auth?.dispose();
    this.auth = undefined;
    this.authInvocation = undefined;
    this.clearLoginState();
  }

  private stopModel(): void {
    this.modelPreparation?.abort();
    this.modelPreparation = undefined;
    this.model?.dispose();
    this.model = undefined;
  }

  private async prepareModel(
    config: StoredSettings,
    generation: number,
  ): Promise<void> {
    this.stopModel();
    const preparation = new AbortController();
    this.modelPreparation = preparation;
    if (config.models.mode !== 'api' || !config.models.activeServiceId) {
      this.modelStatus = { state: 'inactive' };
      this.emit();
      return;
    }
    const service = config.models.services.find(
      (item) => item.id === config.models.activeServiceId,
    );
    if (!service) {
      this.modelStatus = {
        state: 'error',
        message: '当前模型服务不存在。',
      };
      this.emit();
      return;
    }
    this.modelStatus = {
      state: 'preparing',
      serviceId: service.id,
    };
    this.emit();
    let key: string;
    try {
      key = this.store.decryptKey(service.id, this.cipher);
    } catch (error) {
      this.modelStatus = {
        state: 'error',
        serviceId: service.id,
        message: sanitizeMessage(
          error instanceof Error ? error.message : error,
        ),
      };
      this.emit();
      return;
    }
    try {
      const discovery: DeepSeekDiscovery = await this.deepSeek.discover({
        baseUrl: service.baseUrl,
        key,
      }, preparation.signal);
      if (generation !== this.authGeneration || this.disposed) return;
      if (!this.authInvocation) {
        throw new SettingsRuntimeError(
          'model-cli-unavailable',
          'Codex CLI 未连接，无法准备模型运行层。',
        );
      }
      this.resetModelHome();
      const catalogPath = path.join(this.modelHome, 'models.json');
      writeFileSync(
        catalogPath,
        JSON.stringify(discovery.catalog),
        'utf8',
      );
      writeFileSync(
        path.join(this.modelHome, 'config.toml'),
        buildDeepSeekConfig({
          selectedModel: discovery.selected,
          catalogPath,
        }),
        'utf8',
      );
      const model = new CodexAppServerProcess({
        invocation: this.authInvocation,
        codexHome: this.modelHome,
        logger: this.logger,
        cwd: this.modelHome,
        apiKeyEnv: {
          name: 'CHATFGM_DEEPSEEK_API_KEY',
          value: key,
        },
        onExit: (message) => {
          if (this.model !== model || this.disposed) return;
          this.modelStatus = {
            state: 'error',
            serviceId: service.id,
            modelId: discovery.selected.id,
            message: sanitizeMessage(message),
          };
          this.emit();
        },
      });
      this.model = model;
      await model.start();
      if (generation !== this.authGeneration || this.disposed) {
        model.dispose();
        return;
      }
      const models = await model.listModels();
      if (!models.some((entry) => entry.id === discovery.selected.id)) {
        throw new SettingsRuntimeError(
          'model-catalog-missing',
          'Codex 未识别到 DeepSeek 模型目录。',
        );
      }
      this.modelStatus = {
        state: 'ready',
        serviceId: service.id,
        modelId: discovery.selected.id,
        message: `模型：${discovery.selected.name}`,
      };
      this.emit();
    } catch (error) {
      if (generation !== this.authGeneration || this.disposed) return;
      this.stopModel();
      this.modelStatus = {
        state: 'error',
        serviceId: service.id,
        message: sanitizeMessage(
          error instanceof Error ? error.message : error,
        ),
      };
      this.emit();
    }
  }

  private resetModelHome(): void {
    try {
      rmSync(this.modelHome, { recursive: true, force: true });
    } catch {
      // The directory is app-owned; a retry can still proceed.
    }
    mkdirSync(this.modelHome, { recursive: true });
  }

  private requireAuth(): CodexAppServerProcess {
    if (!this.auth) {
      throw new SettingsRuntimeError(
        'cli-unavailable',
        'Codex CLI 未连接，无法完成账号操作。',
      );
    }
    return this.auth;
  }

  private async refreshAccount(forceMessage = false): Promise<void> {
    const auth = this.auth;
    if (!auth) return;
    const owner = this.captureLoginOwnership();
    try {
      const account = await auth.readAccount();
      if (!this.ownsLoginState(owner)) return;
      this.account = accountFromUnknown(account);
    } catch (error) {
      if (!this.ownsLoginState(owner)) return;
      this.account = {
        status: 'logged-out',
        message: forceMessage
          ? sanitizeMessage(
              error instanceof Error ? error.message : error,
            )
          : '无法查询 ChatGPT 账号状态。',
      };
    }
  }

  private onAuthNotification(
    source: CodexAppServerProcess,
    notification: CodexNotification,
  ): void {
    if (source !== this.auth || this.disposed) return;
    if (notification.method === 'account/login/completed') {
      const params =
        notification.params && typeof notification.params === 'object'
          ? (notification.params as Record<string, unknown>)
          : {};
      const completedLoginId =
        typeof params.loginId === 'string' ? params.loginId : null;
      const completion: LoginCompletion = {
        success: params.success === true,
        error: params.error,
      };
      if (
        completedLoginId !== null &&
        (this.cancelledLoginIds.has(completedLoginId) ||
          this.handledLoginIds.has(completedLoginId))
      ) {
        // This authorization already ended. Its notification is consumed
        // without regaining any right to write current state.
        return;
      }
      const current = this.login;
      if (!current) return;
      if (completedLoginId === null) {
        // Without an id there is no reliable attribution; it must not end the
        // current authorization.
        return;
      }
      if (current.loginId !== undefined) {
        if (current.loginId !== completedLoginId) return;
        void this.finishPendingLogin(current, completion);
        return;
      }
      // The start reply has not supplied the current id yet. Keep a bounded
      // record; it is attributed only when the reply id is known.
      this.rememberEarlyCompletion(completedLoginId, completion);
      return;
    }
    if (notification.method === 'account/updated') {
      void this.refreshAccount().then(() => this.emit());
    }
  }

  private onAuthExit(
    source: CodexAppServerProcess,
    message: string,
  ): void {
    if (source !== this.auth || this.disposed) return;
    this.auth = undefined;
    this.authInvocation = undefined;
    this.authGeneration += 1;
    this.clearLoginState();
    this.cliState = {
      state: 'error',
      ...(this.authPath ? { path: this.authPath } : {}),
      ...(this.authVersion ? { version: this.authVersion } : {}),
      message: sanitizeMessage(message),
    };
    this.account = {
      status: 'logged-out',
      message: 'Codex CLI 已退出，账号状态需要重新确认。',
    };
    if (this.model) {
      this.stopModel();
      this.modelStatus = {
        state: 'error',
        message: 'Codex CLI 已退出，模型运行上下文不可用。',
      };
    }
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    this.runtimeRevision += 1;
    const runtime = this.runtime;
    for (const listener of this.listeners) {
      try {
        listener(runtime);
      } catch (error) {
        this.logger.warn('settings-runtime-listener-failed', {
          message: sanitizeMessage(
            error instanceof Error ? error.message : error,
          ),
        });
      }
    }
  }
}
