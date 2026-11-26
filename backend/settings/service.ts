import { detectionTiming } from './timing';
import { dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import type {
  SaveSettingsInput,
  SettingsChatGptAccount,
  SettingsCliDetection,
  SettingsServiceConnectionTest,
  SettingsSnapshot,
  SettingsToolboxEnvironmentDetection,
  SettingsToolboxRuntime,
  TestSettingsServiceInput,
  ToolboxOption,
} from '../ipc/capabilities';
import type { ApplicationDatabase } from '../storage/database';
import type { Logger } from '../platform/log';
import { normalizePathKey } from '../filesystem/path-policy';
import { findToolbox, scanToolboxes, type ToolboxDefinition } from '../toolboxes/registry';import { SafeStorageCipher } from './cipher';
import {
  DeepSeekClient,
  DeepSeekError,
  probeDeepSeekCompatibility,
} from './deepseek';
import { resolveCodexInvocation } from './codex';
import { SettingsRuntime, SettingsRuntimeError } from './runtime';
import {
  normalizeDeepSeekBaseUrl,
  SettingsStore,
  SettingsStoreError,
  type SecretCipher,
  type StoredSettings,
} from './store';
import {
  PythonEnvironmentError,
  PythonEnvironmentService,
  resolvePythonEnvironment,
  type PythonEnvironmentResult,
  type ResolvedPythonEnvironment,
} from './python';

export class SettingsCancelledError extends Error {
  readonly code = 'settings-cancelled';

  constructor(message = '操作已取消。') {
    super(message);
    this.name = 'SettingsCancelledError';
  }
}

export interface SettingsServiceDependencies {
  database: ApplicationDatabase;
  logger: Logger;
  appPath: string;
  codexRoot: string;
  probeRoot: string;
  getMainWindow: () => BrowserWindow | undefined;
  openExternal: (url: string) => Promise<void>;
  cipher?: SecretCipher;
  deepSeek?: DeepSeekClient;
}

export interface ChatSettingsChange {
  previous: StoredSettings | undefined;
  next: StoredSettings;
  cliPathChanged: boolean;
  modeChanged: boolean;
  activeServiceChanged: boolean;
  changedServiceIds: readonly string[];
  removedServiceIds: readonly string[];
  /** Toolbox environments whose value changed, was added or was removed. */
  changedToolboxEnvironmentIds: readonly string[];
}

export interface ChatToolboxEnvironment {
  /** Empty when the toolbox has no dependent environment configured. */
  environmentPath: string;
  interpreterPath?: string;
  /** Last successful settings detection for this environment. */
  interpreterVersion?: string;
}

export interface ChatSettingsGuard {
  /**
   * Called before any configuration/key transaction. It must throw when a
   * related chat run or in-flight submission makes the change unsafe.
   */
  validateSettingsChange(change: ChatSettingsChange): void;
  validateCliReplacement(path: string, currentPath: string): void;
  /** Reserves the CLI mutation window against new chat sends. */
  beginCliDetection?(): () => void;
  validateLogout(): void;
  /**
   * Called after the saved configuration (and, when needed, the runtime) has
   * been applied. Chat discards stale service connections without touching
   * the stable service histories.
   */
  onSettingsApplied(
    change: ChatSettingsChange,
    applied: boolean,
  ): void;
  /** The actual CLI instance was replaced without a saved-path change. */
  onCliReplaced?(): void;
  /** ChatGPT login/logout/account changed outside a settings save. */
  onAuthChanged?(): void;
}

interface RunningProbe {
  controller: AbortController;
  promise: Promise<unknown>;
  toolboxId: string;
  kind: 'auto' | 'manual';
}

function filterToolboxOption(definition: ToolboxDefinition): ToolboxOption {
  return {
    id: definition.name,
    label: definition.name,
    ...(definition.error ? { error: definition.error } : {}),
  };
}

export class SettingsService {
  private readonly store: SettingsStore;
  private readonly runtime: SettingsRuntime;
  private readonly logger: Logger;
  private readonly probeRoot: string;
  private readonly getMainWindow: () => BrowserWindow | undefined;
  private readonly deepSeek: DeepSeekClient;
  private readonly python: PythonEnvironmentService;
  private readonly cipher: SecretCipher;
  private readonly appPathValue: string;
  private readonly probes = new Map<string, RunningProbe>();
  private config?: StoredSettings;
  private configGeneration = 0;
  private probeEpoch = 0;
  private probeSequence = 0;
  private startPromise?: Promise<void>;
  private saveQueue: Promise<SettingsSnapshot> | null = null;
  private disposed = false;
  private toolboxDefinitions: ToolboxDefinition[] = [];
  private readonly resolvedPythonEnvironments = new Map<
    string,
    ResolvedPythonEnvironment
  >();
  private readonly detectedPythonEnvironments = new Map<
    string,
    { environmentPath: string; interpreterPath: string; version: string }
  >();
  /** Toolboxes whose saved environment failed its latest detection. */
  private readonly failedPythonEnvironments = new Map<string, string>();
  private chatGuard?: ChatSettingsGuard;
  private authStateSubscription?: () => void;
  private lastChatGptStatus: string = 'logged-out';

  constructor(dependencies: SettingsServiceDependencies) {
    this.logger = dependencies.logger;
    this.probeRoot = dependencies.probeRoot;
    this.getMainWindow = dependencies.getMainWindow;
    this.appPathValue = dependencies.appPath;
    this.cipher = dependencies.cipher ?? new SafeStorageCipher();
    this.store = new SettingsStore(dependencies.database);
    this.deepSeek = dependencies.deepSeek ?? new DeepSeekClient(dependencies.logger);
    this.python = new PythonEnvironmentService(
      dependencies.logger,
      path.join(dependencies.probeRoot, 'python'),
    );
    this.runtime = new SettingsRuntime({
      store: this.store,
      cipher: this.cipher,
      logger: dependencies.logger,
      codexRoot: dependencies.codexRoot,
      openExternal: dependencies.openExternal,
      deepSeek: this.deepSeek,
    });
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const loaded = this.store.load();
      this.config = loaded.config;
      this.configGeneration += 1;
      this.lastChatGptStatus = this.runtime.runtime.chatgpt.status;
      this.authStateSubscription = this.runtime.subscribe((runtime) => {
        if (runtime.chatgpt.status === this.lastChatGptStatus) return;
        this.lastChatGptStatus = runtime.chatgpt.status;
        try {
          this.chatGuard?.onAuthChanged?.();
        } catch (error) {
          this.logger.warn('chat-auth-change-notify-failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      void this.runtime.initialize(loaded.config).catch((error) => {
        this.logger.error('settings-runtime-startup-failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      void this.detectSavedToolboxes();
    })();
    return this.startPromise;
  }

  async getSnapshot(): Promise<SettingsSnapshot> {
    await this.start();
    const loaded = this.store.load();
    this.config = loaded.config;
    return {
      revision: loaded.revision,
      saved: this.store.toSaved(
        loaded.config,
        loaded.serviceIdsWithKeys,
      ),
      runtime: this.runtime.runtime,
    };
  }

  async saveSettings(input: SaveSettingsInput): Promise<SettingsSnapshot> {
    await this.start();
    const previous = this.saveQueue ?? Promise.resolve(null as never);
    const run: Promise<SettingsSnapshot> = previous
      .catch(() => undefined)
      .then(() => this.performSave(input));
    this.saveQueue = run;
    void run.then(
      () => {
        if (this.saveQueue === run) this.saveQueue = null;
      },
      () => {
        if (this.saveQueue === run) this.saveQueue = null;
      },
    );
    return run;
  }

  private async performSave(
    input: SaveSettingsInput,
  ): Promise<SettingsSnapshot> {
    if (this.disposed) throw new SettingsCancelledError();
    if (input.toolboxes?.environments?.length) {
      const known = new Set(
        this.scanToolboxDefinitions().map((toolbox) => toolbox.name),
      );
      for (const environment of input.toolboxes.environments) {
        if (!known.has(environment.toolboxId)) {
          throw new SettingsStoreError(
            'invalid-settings',
            `未知工具箱：${environment.toolboxId}`,
          );
        }
      }
    }
    const previous = this.config;
    const next = this.normalizeConfigForGuard(input);
    const change = this.settingsChange(previous, next, input);
    // Guard before the store transaction encrypts a new key or replaces any
    // configuration. A rejected save leaves the saved config and actual
    // connections untouched.
    this.chatGuard?.validateSettingsChange(change);
    const result = this.store.save(input, this.cipher);
    this.config = result.saved.config;
    this.configGeneration += 1;
    // An explicit save must affect the next execution context: re-resolve
    // interpreter paths and discard detection facts for changed environments.
    this.resolvedPythonEnvironments.clear();
    for (const toolboxId of change.changedToolboxEnvironmentIds) {
      this.detectedPythonEnvironments.delete(toolboxId);
      this.failedPythonEnvironments.delete(toolboxId);
    }
    this.invalidateProbes();
    this.runtime.pruneToolboxRuntimes(
      result.saved.config.toolboxes.environments.map(
        (environment) => environment.toolboxId,
      ),
      Object.fromEntries(
        result.saved.config.toolboxes.environments.map((environment) => [
          environment.toolboxId,
          environment.environmentPath,
        ]),
      ),
    );
    const needsRuntimeApply =
      !previous ||
      change.cliPathChanged ||
      change.modeChanged ||
      change.activeServiceChanged ||
      this.activeServiceConfigChanged(previous, result.saved.config, input);
    let applied = needsRuntimeApply;
    if (needsRuntimeApply) {
      try {
        await this.runtime.applyConfig(result.saved.config);
      } catch (error) {
        applied = false;
        this.logger.warn('settings-runtime-apply-failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      this.runtime.setConfigOnly(result.saved.config);
    }
    try {
      this.chatGuard?.onSettingsApplied(change, applied);
    } catch (error) {
      this.logger.warn('chat-settings-apply-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    void this.validateSavedToolboxes();
    return {
      revision: result.saved.revision,
      saved: result.savedConfig,
      runtime: this.runtime.runtime,
    };
  }

  private normalizeConfigForGuard(input: SaveSettingsInput): StoredSettings {
    const services = (input.models.services ?? []).map((service) => ({
      id: service.id.trim(),
      name: service.name.trim(),
      baseUrl: normalizeDeepSeekBaseUrl(service.baseUrl),
    }));
    const unique = new Set(services.map((service) => service.id));
    if (unique.size !== services.length) {
      throw new SettingsStoreError(
        'invalid-settings',
        '模型服务标识不能重复。',
      );
    }
    return {
      cli: { path: (input.cli.path ?? '').trim() },
      models: {
        mode: input.models.mode,
        activeServiceId: input.models.activeServiceId,
        services,
      },
      toolboxes: {
        environments: (input.toolboxes.environments ?? []).map(
          (environment) => ({
            toolboxId: environment.toolboxId,
            environmentPath: environment.environmentPath.trim(),
          }),
        ),
      },
    };
  }

  private settingsChange(
    previous: StoredSettings | undefined,
    next: StoredSettings,
    input: SaveSettingsInput,
  ): ChatSettingsChange {
    const previousServices = new Map(
      (previous?.models.services ?? []).map((service) => [service.id, service]),
    );
    const nextById = new Map(
      next.models.services.map((service) => [service.id, service]),
    );
    const keyInputs = new Map(
      (input.models.services ?? []).map((service) => [
        service.id,
        typeof service.key === 'string' ? service.key.trim() : '',
      ]),
    );
    const changedServiceIds: string[] = [];
    for (const service of next.models.services) {
      const old = previousServices.get(service.id);
      const keyChanged = (keyInputs.get(service.id) ?? '').length > 0;
      if (!old || old.baseUrl !== service.baseUrl || keyChanged) {
        changedServiceIds.push(service.id);
      }
    }
    const removedServiceIds = [...previousServices.keys()].filter(
      (id) => !nextById.has(id),
    );
    const previousToolboxEnvironments = new Map(
      (previous?.toolboxes.environments ?? []).map((environment) => [
        environment.toolboxId,
        environment.environmentPath,
      ]),
    );
    const nextToolboxEnvironments = new Map(
      next.toolboxes.environments.map((environment) => [
        environment.toolboxId,
        environment.environmentPath,
      ]),
    );
    const changedToolboxEnvironmentIds = [
      ...new Set([
        ...previousToolboxEnvironments.keys(),
        ...nextToolboxEnvironments.keys(),
      ]),
    ].filter(
      (id) =>
        (previousToolboxEnvironments.get(id) ?? '') !==
        (nextToolboxEnvironments.get(id) ?? ''),
    );
    return {
      previous,
      next,
      cliPathChanged: (previous?.cli.path ?? '') !== next.cli.path,
      modeChanged: (previous?.models.mode ?? 'chatgpt') !== next.models.mode,
      activeServiceChanged:
        (previous?.models.activeServiceId ?? null) !==
        next.models.activeServiceId,
      changedServiceIds,
      removedServiceIds,
      changedToolboxEnvironmentIds,
    };
  }

  private activeServiceConfigChanged(
    previous: StoredSettings,
    next: StoredSettings,
    input: SaveSettingsInput,
  ): boolean {
    const activeId = next.models.activeServiceId;
    if (!activeId) return false;
    const old = previous.models.services.find(
      (service) => service.id === activeId,
    );
    const current = next.models.services.find(
      (service) => service.id === activeId,
    );
    if (!current) return false;
    if (!old || old.baseUrl !== current.baseUrl) return true;
    const keyInput = (input.models.services ?? []).find(
      (service) => service.id === activeId,
    )?.key;
    return typeof keyInput === 'string' && keyInput.trim().length > 0;
  }

  setChatGuard(guard: ChatSettingsGuard): void {
    this.chatGuard = guard;
  }

  getChatConfig(): StoredSettings | undefined {
    return this.config;
  }

  getChatCliRuntime(): SettingsSnapshot['runtime']['cli'] {
    return this.runtime.runtime.cli;
  }

  getChatRuntime(): SettingsSnapshot['runtime'] {
    return this.runtime.runtime;
  }

  getChatAuthProcess() {
    return this.runtime.authProcess;
  }

  getChatInvocation() {
    return this.runtime.currentInvocation;
  }

  getChatAccount() {
    return this.runtime.runtime.chatgpt;
  }

  getChatSandboxStatus(): {
    state: 'ready' | 'unavailable' | 'unknown';
    message: string;
  } {
    return this.runtime.sandboxStatus;
  }

  /**
   * Environment facts for a chat turn. The environment directory is resolved
   * once per configured path and reused; the Python version comes from the
   * last successful settings detection. Chat must never start Python just to
   * read a version. A saved environment whose latest detection failed is
   * reported as unavailable until a later detection succeeds, so a removed
   * interpreter is never reused from an earlier resolution.
   */
  getChatToolboxEnvironment(toolboxId: string): ChatToolboxEnvironment {
    const configured =
      this.config?.toolboxes.environments.find(
        (environment) => environment.toolboxId === toolboxId,
      )?.environmentPath ?? '';
    if (!configured) return { environmentPath: '' };
    const environmentPath = this.environmentInputPath(configured);
    if (!environmentPath) return { environmentPath: '' };
    const resolved = this.resolveChatPythonEnvironment(environmentPath);
    if (
      this.failedPythonEnvironments.get(toolboxId) ===
      this.pythonEnvironmentKey(environmentPath)
    ) {
      throw new PythonEnvironmentError(
        'python-environment-unavailable',
        '该工具箱的 Python 运行环境上次检测失败；请先在依赖设置中修复并重新检测。',
      );
    }
    const detected = this.detectedPythonEnvironments.get(toolboxId);
    const version =
      detected &&
      this.pythonEnvironmentKey(detected.environmentPath) ===
        this.pythonEnvironmentKey(resolved.environmentPath) &&
      this.pythonEnvironmentKey(detected.interpreterPath) ===
        this.pythonEnvironmentKey(resolved.interpreterPath)
        ? detected.version
        : '';
    return {
      environmentPath: resolved.environmentPath,
      interpreterPath: resolved.interpreterPath,
      ...(version ? { interpreterVersion: version } : {}),
    };
  }

  listToolboxIssues(): readonly { name: string; message: string }[] {
    try {
      return scanToolboxes(this.appPathValue).issues;
    } catch {
      return [];
    }
  }

  decryptChatServiceKey(serviceId: string): string {
    return this.store.decryptKey(serviceId, this.cipher);
  }

  async pickCliExecutable(): Promise<{ path: string } | null> {
    const window = this.getMainWindow();
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '选择 Codex CLI',
          properties: ['openFile'],
          filters: [
            {
              name: 'Codex CLI',
              extensions: ['exe', 'cmd', 'bat', 'ps1'],
            },
            { name: '所有文件', extensions: ['*'] },
          ],
        })
      : await dialog.showOpenDialog({
          title: '选择 Codex CLI',
          properties: ['openFile'],
          filters: [
            {
              name: 'Codex CLI',
              extensions: ['exe', 'cmd', 'bat', 'ps1'],
            },
            { name: '所有文件', extensions: ['*'] },
          ],
        });
    if (result.canceled || result.filePaths.length !== 1) return null;
    return { path: result.filePaths[0]! };
  }

  async pickToolboxEnvironment(
    toolboxId: string,
  ): Promise<{ path: string; name: string } | null> {
    if (!this.scanToolboxDefinitions().some((item) => item.name === toolboxId)) {
      throw new SettingsStoreError(
        'invalid-settings',
        `未知工具箱：${toolboxId}`,
      );
    }
    const window = this.getMainWindow();
    const options = {
      title: '选择工具箱运行环境',
      properties: ['openDirectory'] as Array<'openDirectory'>,
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length !== 1) return null;
    const selected = result.filePaths[0]!;
    return {
      path: selected,
      name: path.basename(selected),
    };
  }

  async detectCli(pathValue: string): Promise<SettingsCliDetection> {
    if (this.disposed) throw new SettingsCancelledError();
    const release = this.chatGuard?.beginCliDetection?.();
    if (!this.chatGuard?.beginCliDetection) {
      this.chatGuard?.validateCliReplacement(
        pathValue,
        this.config?.cli.path ?? '',
      );
    }
    try {
      const result = await this.runtime.detectCli(pathValue);
      try {
        this.chatGuard?.onCliReplaced?.();
      } catch (error) {
        this.logger.warn('chat-cli-replacement-notify-failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return result;
    } finally {
      release?.();
    }
  }

  async testServiceConnection(
    input: TestSettingsServiceInput,
  ): Promise<SettingsServiceConnectionTest> {
    await this.start();
    const service = input.service;
    const baseUrl = normalizeDeepSeekBaseUrl(service.baseUrl);
    let key: string;
    if (input.keepSavedKey) {
      key = this.store.decryptKey(service.id, this.cipher);
    } else {
      if (!service.key || !service.key.trim()) {
        throw new SettingsStoreError(
          'settings-key-missing',
          '测试连接需要 API Key。',
        );
      }
      key = service.key.trim();
    }
    const invocation =
      this.runtime.currentInvocation ??
      this.savedInvocation();
    if (!invocation) {
      throw new SettingsRuntimeError(
        'cli-unavailable',
        'Codex CLI 未连接，无法验证 DeepSeek 工具往返。',
      );
    }
    const controller = new AbortController();
    const keyName = `service-test:${service.id}`;
    this.cancelProbeKey(keyName);
    const timing = detectionTiming(this.logger, 'api');
    const promise = (async () => {
      const discovery = await this.deepSeek.discover({
        baseUrl,
        key,
      }, controller.signal);
      timing('discovery');
      return probeDeepSeekCompatibility({
        invocation,
        probeRoot: path.join(this.probeRoot, 'deepseek'),
        service: {
          id: service.id,
          name: service.name,
          baseUrl,
          key,
        },
        discovery,
        logger: this.logger,
        signal: controller.signal,
      });
    })();
    this.probes.set(keyName, {
      controller,
      promise,
      toolboxId: '',
      kind: 'manual',
    });
    try {
      const result = await promise;
      return { message: result.message };
    } catch (error) {
      if (controller.signal.aborted) throw new SettingsCancelledError();
      if (error instanceof DeepSeekError) {
        throw new SettingsRuntimeError(error.code, error.message, {
          cause: error,
        });
      }
      if (error instanceof SettingsRuntimeError) throw error;
      throw new SettingsRuntimeError(
        'deepseek-test-failed',
        error instanceof Error
          ? error.message
          : 'DeepSeek 连接测试失败。',
        { cause: error },
      );
    } finally {
      if (this.probes.get(keyName)?.promise === promise) {
        this.probes.delete(keyName);
      }
    }
  }

  async startChatGptLogin(): Promise<SettingsChatGptAccount> {
    await this.start();
    return this.runtime.startChatGptLogin();
  }

  async cancelChatGptLogin(): Promise<SettingsChatGptAccount> {
    return this.runtime.cancelChatGptLogin();
  }

  async logoutChatGpt(): Promise<SettingsChatGptAccount> {
    this.chatGuard?.validateLogout();
    return this.runtime.logoutChatGpt();
  }

  async scanToolboxes(): Promise<readonly ToolboxOption[]> {
    return this.scanToolboxDefinitions().map(filterToolboxOption);
  }

  async detectToolboxEnvironment(input: {
    toolboxId: string;
    path: string;
  }): Promise<SettingsToolboxEnvironmentDetection> {
    const definitions = this.scanToolboxDefinitions();
    const toolbox = findToolbox(definitions, input.toolboxId);
    if (!toolbox) {
      throw new SettingsStoreError(
        'invalid-settings',
        `未知工具箱：${input.toolboxId}`,
      );
    }
    const detectedPath = this.environmentInputPath(input.path);
    if (!detectedPath) {
      throw new SettingsStoreError(
        'invalid-settings',
        'Python 运行环境路径不能为空。',
      );
    }
    const key = `manual:${++this.probeSequence}:${input.toolboxId}`;
    this.cancelToolboxProbes(input.toolboxId);
    const controller = new AbortController();
    const generation = this.configGeneration;
    const epoch = this.probeEpoch;
    const promise = this.python.detect(detectedPath, controller.signal);
    this.probes.set(key, {
      controller,
      promise,
      toolboxId: toolbox.name,
      kind: 'manual',
    });
    try {
      const result = await promise;
      if (
        controller.signal.aborted ||
        !this.isProbeCurrent(key, promise, generation, epoch)
      ) {
        throw new SettingsCancelledError();
      }
      this.rememberDetectedPython(toolbox.name, result);
      if (this.savedEnvironmentMatches(toolbox.name, detectedPath)) {
        this.markPythonEnvironmentAvailable(
          toolbox.name,
          this.savedEnvironmentPath(toolbox.name) ?? detectedPath,
          result,
        );
      }
      const runtime: SettingsToolboxRuntime = {
        state: 'ok',
        path: result.environmentPath,
        message: toolbox.error
          ? `${result.message}（${toolbox.error}）`
          : result.message,
      };
      this.runtime.setToolboxRuntime(toolbox.name, runtime);
      return { message: runtime.message ?? result.message, runtime };
    } catch (error) {
      if (
        controller.signal.aborted ||
        this.disposed ||
        !this.isProbeCurrent(key, promise, generation, epoch)
      ) {
        throw new SettingsCancelledError();
      }
      const message =
        error instanceof PythonEnvironmentError
          ? error.message
          : error instanceof Error
            ? error.message
            : '运行环境检测失败。';
      if (this.savedEnvironmentMatches(toolbox.name, detectedPath)) {
        this.markPythonEnvironmentUnavailable(toolbox.name, detectedPath);
      }
      const runtime: SettingsToolboxRuntime = {
        state: 'error',
        path: detectedPath,
        message,
      };
      this.runtime.setToolboxRuntime(toolbox.name, runtime);
      if (error instanceof PythonEnvironmentError) {
        throw new SettingsRuntimeError(error.code, message, { cause: error });
      }
      throw new SettingsRuntimeError('python-detection-failed', message, {
        cause: error,
      });
    } finally {
      if (this.probes.get(key)?.promise === promise) {
        this.probes.delete(key);
      }
    }
  }

  async cancelPendingOperations(): Promise<null> {
    this.runtime.cancelDetection();
    this.invalidateProbes();
    return null;
  }

  subscribeUpdates(
    listener: (update: {
      revision: number;
      runtime: SettingsSnapshot['runtime'];
    }) => void,
  ): () => void {
    return this.runtime.subscribe((runtime) => {
      listener({ revision: runtime.revision, runtime });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const probe of this.probes.values()) probe.controller.abort();
    this.probes.clear();
    this.probeEpoch += 1;
    this.authStateSubscription?.();
    this.authStateSubscription = undefined;
    this.runtime.dispose();
  }

  private resolveChatPythonEnvironment(
    environmentPath: string,
  ): ResolvedPythonEnvironment {
    const key = this.pythonEnvironmentKey(environmentPath);
    const cached = this.resolvedPythonEnvironments.get(key);
    if (cached) return cached;
    const resolved = resolvePythonEnvironment(environmentPath);
    this.resolvedPythonEnvironments.set(key, resolved);
    return resolved;
  }

  /**
   * The one input rule for environment paths: surrounding whitespace is not
   * part of the path, and a pure-whitespace value is not the current working
   * directory. Returns '' so callers can reject it explicitly.
   */
  private environmentInputPath(environmentPath: string): string {
    const trimmed = environmentPath.trim();
    return trimmed ? path.resolve(trimmed) : '';
  }

  private pythonEnvironmentKey(environmentPath: string): string {
    const normalized = this.environmentInputPath(environmentPath);
    return normalized ? normalizePathKey(normalized) : '';
  }

  private rememberDetectedPython(
    toolboxId: string,
    result: PythonEnvironmentResult,
  ): void {
    this.detectedPythonEnvironments.set(toolboxId, {
      environmentPath: result.environmentPath,
      interpreterPath: result.interpreterPath,
      version: result.version,
    });
  }

  private forgetDetectedPython(toolboxId: string): void {
    const detected = this.detectedPythonEnvironments.get(toolboxId);
    this.detectedPythonEnvironments.delete(toolboxId);
    if (detected) {
      this.resolvedPythonEnvironments.delete(
        this.pythonEnvironmentKey(detected.environmentPath),
      );
    }
  }

  private markPythonEnvironmentAvailable(
    toolboxId: string,
    environmentPath: string,
    result: PythonEnvironmentResult,
  ): void {
    const resolved: ResolvedPythonEnvironment = {
      environmentPath: result.environmentPath,
      interpreterPath: result.interpreterPath,
    };
    this.resolvedPythonEnvironments.set(
      this.pythonEnvironmentKey(environmentPath),
      resolved,
    );
    this.resolvedPythonEnvironments.set(
      this.pythonEnvironmentKey(result.environmentPath),
      resolved,
    );
    this.failedPythonEnvironments.delete(toolboxId);
  }

  private markPythonEnvironmentUnavailable(
    toolboxId: string,
    environmentPath: string,
  ): void {
    this.forgetDetectedPython(toolboxId);
    this.resolvedPythonEnvironments.delete(
      this.pythonEnvironmentKey(environmentPath),
    );
    this.failedPythonEnvironments.set(
      toolboxId,
      this.pythonEnvironmentKey(environmentPath),
    );
  }

  private scanToolboxDefinitions(): ToolboxDefinition[] {
    this.toolboxDefinitions = [...scanToolboxes(this.appPathValue).toolboxes];
    return this.toolboxDefinitions;
  }

  private savedInvocation() {
    const pathValue = this.config?.cli.path;
    if (!pathValue) return undefined;
    try {
      return resolveCodexInvocation(pathValue);
    } catch {
      return undefined;
    }
  }

  private async detectSavedToolboxes(): Promise<void> {
    const generation = this.configGeneration;
    const epoch = this.probeEpoch;
    try {
      const definitions = this.scanToolboxDefinitions();
      const environments = this.config?.toolboxes.environments ?? [];
      this.runtime.pruneToolboxRuntimes(
        environments.map((environment) => environment.toolboxId),
        Object.fromEntries(
          environments.map((environment) => [
            environment.toolboxId,
            environment.environmentPath,
          ]),
        ),
      );
      await Promise.all(
        environments.map(async (environment) => {
          const toolbox = findToolbox(definitions, environment.toolboxId);
          const detectedPath = this.environmentInputPath(
            environment.environmentPath,
          );
          if (!toolbox || !detectedPath) return;
          const key = `auto:${++this.probeSequence}:${toolbox.name}`;
          this.cancelToolboxProbes(toolbox.name);
          const controller = new AbortController();
          const promise = this.python.detect(detectedPath, controller.signal);
          this.probes.set(key, {
            controller,
            promise,
            toolboxId: toolbox.name,
            kind: 'auto',
          });
          try {
            const result = await promise;
            if (
              controller.signal.aborted ||
              !this.isProbeCurrent(key, promise, generation, epoch) ||
              !this.savedEnvironmentMatches(toolbox.name, detectedPath)
            ) {
              return;
            }
            this.rememberDetectedPython(toolbox.name, result);
            this.markPythonEnvironmentAvailable(
              toolbox.name,
              detectedPath,
              result,
            );
            this.runtime.setToolboxRuntime(toolbox.name, {
              state: 'ok',
              path: result.environmentPath,
              message: result.message,
            });
          } catch (error) {
            if (
              controller.signal.aborted ||
              this.disposed ||
              !this.isProbeCurrent(key, promise, generation, epoch) ||
              !this.savedEnvironmentMatches(toolbox.name, detectedPath)
            ) {
              return;
            }
            this.markPythonEnvironmentUnavailable(toolbox.name, detectedPath);
            this.runtime.setToolboxRuntime(toolbox.name, {
              state: 'error',
              path: detectedPath,
              message:
                error instanceof Error
                  ? error.message
                  : '运行环境检测失败。',
            });
          } finally {
            if (this.probes.get(key)?.promise === promise) {
              this.probes.delete(key);
            }
          }
        }),
      );
    } catch {
      // Toolbox discovery failure must not fail settings or app startup.
    }
  }

  private async validateSavedToolboxes(): Promise<void> {
    await this.detectSavedToolboxes();
  }

  private savedEnvironmentPath(toolboxId: string): string | undefined {
    return this.config?.toolboxes.environments.find(
      (environment) => environment.toolboxId === toolboxId,
    )?.environmentPath;
  }

  private savedEnvironmentMatches(toolboxId: string, pathValue: string): boolean {
    const key = this.pythonEnvironmentKey(pathValue);
    if (!key) return false;
    return (
      this.config?.toolboxes.environments.some(
        (environment) =>
          environment.toolboxId === toolboxId &&
          this.pythonEnvironmentKey(environment.environmentPath) === key,
      ) ?? false
    );
  }

  private isProbeCurrent(
    key: string,
    promise: Promise<unknown>,
    generation: number,
    epoch: number,
  ): boolean {
    return (
      !this.disposed &&
      this.configGeneration === generation &&
      this.probeEpoch === epoch &&
      this.probes.get(key)?.promise === promise
    );
  }

  private cancelToolboxProbes(toolboxId: string): void {
    for (const [key, probe] of this.probes) {
      if (probe.toolboxId !== toolboxId) continue;
      probe.controller.abort();
      this.probes.delete(key);
    }
  }

  private cancelProbeKey(key: string): void {
    const existing = this.probes.get(key);
    if (!existing) return;
    existing.controller.abort();
    this.probes.delete(key);
  }

  private invalidateProbes(): void {
    this.probeEpoch += 1;
    for (const probe of this.probes.values()) probe.controller.abort();
    this.probes.clear();
  }
}

