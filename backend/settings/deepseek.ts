import { detectionTiming } from './timing';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { Logger } from '../platform/log';
import {
  CodexAppServerProcess,
  CodexLaunchError,
  CodexProtocolError,
  type CodexInvocation,
  type CodexModel,
} from './codex';
import { SettingsStoreError, normalizeDeepSeekBaseUrl } from './store';
import {
  buildShellEnvironmentBase,
  buildToolShellEnvironmentPolicy,
} from './python';

const MAX_MODELS_BYTES = 2 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 120_000;
/** Bounded wait for transient Windows handles; read-only attributes are repaired instead. */
const PROBE_CLEANUP_DEADLINE_MS = 5_000;
const PROBE_CLEANUP_POLL_MS = 100;
const PROBE_ATTRIBUTE_SWEEP_MAX_DEPTH = 40;
const PROBE_ATTRIBUTE_SWEEP_MAX_ENTRIES = 20_000;
const DONE_MARKER = 'CHATFGM_TOOL_DONE';
const PROBE_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const BASE_INSTRUCTIONS =
  'You are Codex, a coding agent operating in a shared workspace. Follow system and developer instructions, and use tools when needed. ' +
  'On Windows, every exec_command must set "shell": "powershell" and use PowerShell syntax. ' +
  'Never set "shell" to "bash" and never wrap a PowerShell command in cmd.exe /c. ' +
  'If a task explicitly requires cmd.exe semantics, invoke cmd.exe /c as a program from PowerShell.';

export interface DeepSeekEffortMetadata {
  supportedLevels: string[];
  defaultLevel?: string;
}

export interface DeepSeekModelMetadata {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  inputModalities: string[];
  effort?: DeepSeekEffortMetadata;
}

export interface DeepSeekDiscovery {
  models: DeepSeekModelMetadata[];
  selected: DeepSeekModelMetadata;
  catalog: DeepSeekModelCatalog;
}

export interface DeepSeekModelCatalog {
  models: Array<Record<string, unknown>>;
}

export class DeepSeekError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions & { httpStatus?: number },
  ) {
    super(message, options);
    this.name = 'DeepSeekError';
    this.code = code;
    this.httpStatus = options?.httpStatus;
  }
}

function sanitize(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(sk|pk|ak)-[A-Za-z0-9._-]{6,}\b/g, '[redacted]')
    .replace(/([?&](?:key|token|code|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .slice(0, 700);
}

function classifyStatus(status: number): { code: string; message: string } {
  if (status === 401 || status === 403) {
    return {
      code: 'deepseek-auth-failed',
      message: 'DeepSeek 鉴权失败，请检查 API Key。',
    };
  }
  if (status === 402) {
    return {
      code: 'deepseek-balance',
      message: 'DeepSeek 账户余额不足或计费受限。',
    };
  }
  if (status === 429) {
    return {
      code: 'deepseek-rate-limit',
      message: 'DeepSeek 请求受限或触发限流，请稍后重试。',
    };
  }
  if (status === 404) {
    return {
      code: 'deepseek-endpoint',
      message: 'DeepSeek API 地址或接口不存在。',
    };
  }
  if (status >= 500) {
    return {
      code: 'deepseek-service',
      message: `DeepSeek 服务暂不可用（HTTP ${status}）。`,
    };
  }
  return {
    code: 'deepseek-http-error',
    message: `DeepSeek 请求失败（HTTP ${status}）。`,
  };
}

function parseModel(value: unknown, index: number): DeepSeekModelMetadata {
  if (!value || typeof value !== 'object') {
    throw new DeepSeekError(
      'deepseek-model-metadata',
      `DeepSeek 模型 ${index + 1} 的元数据格式无效。`,
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) {
    throw new DeepSeekError(
      'deepseek-model-metadata',
      `DeepSeek 模型 ${index + 1} 缺少 id。`,
    );
  }
  const contextWindow =
    typeof record.context_window === 'number' &&
    Number.isSafeInteger(record.context_window) &&
    record.context_window > 0
      ? record.context_window
      : null;
  if (!contextWindow) {
    throw new DeepSeekError(
      'deepseek-model-metadata',
      `DeepSeek 模型 ${record.id} 未提供可用的上下文窗口元数据。`,
    );
  }
  const rawEffort =
    record.effort && typeof record.effort === 'object'
      ? (record.effort as Record<string, unknown>)
      : null;
  const rawLevels = rawEffort?.supported_levels;
  const supportedLevels = Array.isArray(rawLevels)
    ? rawLevels.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
    : [];
  const effort = supportedLevels.length > 0
    ? {
        supportedLevels,
        defaultLevel:
          typeof rawEffort?.default_level === 'string' &&
          supportedLevels.includes(rawEffort.default_level)
            ? rawEffort.default_level
            : supportedLevels[0],
      }
    : undefined;
  const inputModalities = Array.isArray(record.input_modalities)
    ? record.input_modalities.filter(
        (item): item is string => item === 'text' || item === 'image',
      )
    : ['text'];
  return {
    id: record.id.trim(),
    name:
      typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : record.id.trim(),
    contextWindow,
    maxOutputTokens:
      typeof record.max_output_tokens === 'number' &&
      Number.isSafeInteger(record.max_output_tokens) &&
      record.max_output_tokens > 0
        ? record.max_output_tokens
        : undefined,
    inputModalities:
      inputModalities.length > 0 ? inputModalities : ['text'],
    effort,
  };
}

function buildModelEntry(
  model: DeepSeekModelMetadata,
  priority: number,
): Record<string, unknown> {
  const levels = model.effort?.supportedLevels ?? ['none'];
  const defaultLevel = model.effort?.defaultLevel ?? levels[0]!;
  return {
    slug: model.id,
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    input_modalities: model.inputModalities,
    supports_image_detail_original: model.inputModalities.includes('image'),
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: false,
    tool_mode: null,
    multi_agent_version: 'v2',
    use_responses_lite: false,
    include_skills_usage_instructions: false,
    auto_review_model_override: null,
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    effective_context_window_percent: 95,
    auto_compact_token_limit: null,
    comp_hash: '3000',
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    display_name: model.name,
    description: `DeepSeek model ${model.name}`,
    default_reasoning_level: defaultLevel,
    supported_reasoning_levels: levels.map((effort) => ({
      effort,
      description: effort === 'none' ? 'Thinking disabled' : `${effort} reasoning`,
    })),
    shell_type: 'shell_command',
    visibility: 'list',
    minimal_client_version: '0.144.0',
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority,
    experimental_supported_tools: [],
    supports_search_tool: false,
    default_service_tier: null,
    supports_reasoning_summaries: true,
    base_instructions: BASE_INSTRUCTIONS,
  };
}

export class DeepSeekClient {
  constructor(
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly discoveryTimeoutMs = DISCOVERY_TIMEOUT_MS,
  ) {}

  async discover(
    service: { baseUrl: string; key: string },
    signal?: AbortSignal,
  ): Promise<DeepSeekDiscovery> {
    const baseUrl = normalizeDeepSeekBaseUrl(service.baseUrl);
    if (!service.key || service.key.trim().length === 0) {
      throw new DeepSeekError(
        'deepseek-key-missing',
        '测试 DeepSeek 连接需要 API Key。',
      );
    }
    if (signal?.aborted) {
      throw new DeepSeekError(
        'deepseek-cancelled',
        'DeepSeek 连接测试已取消。',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.discoveryTimeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const abortError = (cause?: unknown): DeepSeekError =>
      new DeepSeekError(
        signal?.aborted ? 'deepseek-cancelled' : 'deepseek-timeout',
        signal?.aborted
          ? 'DeepSeek 连接测试已取消。'
          : 'DeepSeek 模型发现超时。',
        cause === undefined ? undefined : { cause },
      );
    try {
      let response: Response;
      let abortReject: ((error: DeepSeekError) => void) | undefined;
      const fetchAbort = new Promise<never>((_, reject) => {
        abortReject = reject;
      });
      void fetchAbort.catch(() => undefined);
      const onFetchAbort = () => abortReject?.(abortError());
      controller.signal.addEventListener('abort', onFetchAbort, {
        once: true,
      });
      if (controller.signal.aborted) onFetchAbort();
      try {
        response = await Promise.race([
          this.fetchImpl(`${baseUrl}models`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${service.key}`,
              Accept: 'application/json',
            },
            signal: controller.signal,
          }),
          fetchAbort,
        ]);
      } catch (error) {
        if (controller.signal.aborted) throw abortError(error);
        throw new DeepSeekError(
          'deepseek-network',
          '无法连接 DeepSeek API，请检查网络和地址。',
          { cause: error },
        );
      } finally {
        controller.signal.removeEventListener('abort', onFetchAbort);
      }
      let text: string;
      try {
        text = await this.readBody(response, controller.signal, () =>
          abortError(),
        );
      } catch (error) {
        if (error instanceof DeepSeekError) throw error;
        if (controller.signal.aborted) throw abortError(error);
        throw new DeepSeekError(
          'deepseek-response',
          '无法读取 DeepSeek 模型列表响应。',
          { cause: error },
        );
      }
      if (controller.signal.aborted) throw abortError();
      if (!response.ok) {
        const detail = sanitize(text);
        const classified = classifyStatus(response.status);
        this.logger.warn('deepseek-discovery-http-error', {
          httpStatus: response.status,
          code: classified.code,
        });
        throw new DeepSeekError(
          classified.code,
          detail
            ? `${classified.message} ${detail}`
            : classified.message,
          { httpStatus: response.status },
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new DeepSeekError(
          'deepseek-protocol',
          'DeepSeek 模型列表不是有效 JSON。',
          { cause: error },
        );
      }
      const data =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>).data
          : undefined;
      if (!Array.isArray(data) || data.length === 0) {
        throw new DeepSeekError(
          'deepseek-model-metadata',
          'DeepSeek 没有返回可用的模型元数据。',
        );
      }
      const models = data.map(parseModel);
      const selected = models[0]!;
      return {
        models,
        selected,
        catalog: buildDeepSeekCatalogForModels(models),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  /**
   * Reads a response body with a hard byte limit while the request-level
   * abort signal remains live. This intentionally does not trust
   * Content-Length and never calls response.text() before enforcing the cap.
   */
  private async readBody(
    response: Response,
    signal: AbortSignal,
    abortError: () => DeepSeekError,
  ): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    let abortReject: ((error: DeepSeekError) => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    void abortPromise.catch(() => undefined);
    const onAbort = () => {
      abortReject?.(abortError());
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      for (;;) {
        const result = await Promise.race([reader.read(), abortPromise]);
        if (result.done) break;
        total += result.value.byteLength;
        if (total > MAX_MODELS_BYTES) {
          throw new DeepSeekError(
            'deepseek-response-too-large',
            'DeepSeek 模型列表响应超过大小限制。',
          );
        }
        text += decoder.decode(result.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // The stream may already be closed or aborted.
      }
      // Prevent a late abort from rejecting an unobserved promise.
      abortReject = undefined;
    }
  }
}

export interface DeepSeekProbeOptions {
  invocation: CodexInvocation;
  probeRoot: string;
  service: { id: string; name: string; baseUrl: string; key: string };
  discovery: DeepSeekDiscovery;
  logger: Logger;
  signal?: AbortSignal;
}

export interface DeepSeekProbeResult {
  message: string;
  modelId: string;
  version?: string;
  toolRoundTrip: true;
  streaming: true;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildDeepSeekConfig(input: {
  selectedModel: DeepSeekModelMetadata;
  catalogPath: string;
}): string {
  const effort = input.selectedModel.effort?.defaultLevel;
  return [
    `model = ${tomlString(input.selectedModel.id)}`,
    'model_provider = "deepseek"',
    `model_catalog_json = ${tomlString(input.catalogPath)}`,
    ...(effort ? [`model_reasoning_effort = ${tomlString(effort)}`] : []),
    '',
    '[model_providers.deepseek]',
    'name = "DeepSeek"',
    `base_url = ${tomlString('https://api.deepseek.com/')}`,
    'wire_api = "responses"',
    'env_key = "CHATFGM_DEEPSEEK_API_KEY"',
    'requires_openai_auth = false',
    '',
  ].join('\n');
}

function turnItems(turn: unknown): Array<Record<string, unknown>> {
  if (!turn || typeof turn !== 'object') return [];
  const items = (turn as Record<string, unknown>).items;
  return Array.isArray(items)
    ? items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object'),
      )
    : [];
}

interface DeepSeekProbeWorkspace {
  probeDir: string;
  home: string;
  work: string;
  catalogPath: string;
}

/**
 * Creates the app-owned probe root and one probe workspace. A fresh profile
 * may not have settings-probes/deepseek yet, so the parent must be created
 * explicitly before mkdtemp. Any partial workspace is removed here; the
 * caller only owns the returned directory.
 */
function createDeepSeekProbeWorkspace(
  options: DeepSeekProbeOptions,
): DeepSeekProbeWorkspace {
  let probeDir: string | undefined;
  try {
    mkdirSync(options.probeRoot, { recursive: true });
    const rootInfo = lstatSync(options.probeRoot);
    if (!rootInfo.isDirectory()) {
      throw new Error('probe root is not a directory');
    }
    probeDir = mkdtempSync(path.join(options.probeRoot, 'deepseek-'));
    const home = path.join(probeDir, 'home');
    const work = path.join(probeDir, 'work');
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    const catalogPath = path.join(home, 'models.json');
    writeFileSync(
      catalogPath,
      JSON.stringify(options.discovery.catalog),
      'utf8',
    );
    writeFileSync(
      path.join(home, 'config.toml'),
      buildDeepSeekConfig({
        selectedModel: options.discovery.selected,
        catalogPath,
      }),
      'utf8',
    );
    return { probeDir, home, work, catalogPath };
  } catch (error) {
    if (probeDir) {
      clearReadOnlyAttributesUnder(probeDir);
      try {
        deleteOwnedProbeTree(probeDir);
      } catch {
        // The original init error remains the actionable failure.
      }
    }
    if (error instanceof DeepSeekError) throw error;
    throw new DeepSeekError(
      'deepseek-probe-root',
      '无法创建 DeepSeek 连接测试的临时目录；请检查应用数据目录是否可写。',
      { cause: error },
    );
  }
}

/**
 * Windows read-only attributes are not cleared by Electron's embedded Node
 * `fs.rmSync` (24.22.1) when it meets a read-only file deeper in the tree: the
 * recursive delete fails with EPERM and nothing is removed. Clearing the
 * attribute on files this probe owns is therefore required before deletion.
 * Symlinks/reparse points are never followed or modified, and read-only files
 * with outside hard links are left alone because the attribute is shared.
 */
function clearReadOnlyAttributesUnder(directory: string): {
  cleared: number;
  hardLinkedReadOnlyFiles: number;
} {
  let cleared = 0;
  let hardLinkedReadOnlyFiles = 0;
  let visited = 0;
  const walk = (current: string, depth: number): void => {
    if (
      depth > PROBE_ATTRIBUTE_SWEEP_MAX_DEPTH ||
      visited >= PROBE_ATTRIBUTE_SWEEP_MAX_ENTRIES
    ) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= PROBE_ATTRIBUTE_SWEEP_MAX_ENTRIES) return;
      visited += 1;
      const full = path.join(current, entry.name);
      let info;
      try {
        info = lstatSync(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      const readOnly = (info.mode & 0o222) === 0;
      if (info.isDirectory()) {
        if (readOnly) {
          try {
            chmodSync(full, info.mode | 0o200);
            cleared += 1;
          } catch {
            // The bounded retry reports the failure if it persists.
          }
        }
        walk(full, depth + 1);
        continue;
      }
      if (!readOnly) continue;
      if (info.isFile() && info.nlink > 1) {
        hardLinkedReadOnlyFiles += 1;
        continue;
      }
      try {
        chmodSync(full, info.mode | 0o200);
        cleared += 1;
      } catch {
        // The bounded retry reports the failure if it persists.
      }
    }
  };
  walk(directory, 0);
  return { cleared, hardLinkedReadOnlyFiles };
}

interface ProbeDirectoryOwnership {
  ok: boolean;
  relativePath: string;
  missing?: boolean;
  reason?: string;
}

/**
 * Confirms that `directory` is one direct `deepseek-*` child of the probe root
 * and a real directory (not a link). No other path may be deleted or have its
 * attributes adjusted.
 */
function resolveProbeDirectoryOwnership(
  probeRoot: string,
  directory: string,
): ProbeDirectoryOwnership {
  const root = path.resolve(probeRoot);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep) ||
    relative.includes('/') ||
    !/^deepseek-/i.test(path.basename(target))
  ) {
    return { ok: false, relativePath: '', reason: 'not-owned' };
  }
  let rootReal: string;
  let targetReal: string;
  let info;
  try {
    rootReal = realpathSync.native(root);
    targetReal = realpathSync.native(target);
    info = lstatSync(target);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      !existsSync(target)
    ) {
      return { ok: true, relativePath: relative, missing: true };
    }
    return { ok: false, relativePath: relative, reason: 'unreadable' };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { ok: false, relativePath: relative, reason: 'not-owned' };
  }
  if (path.dirname(targetReal).toLowerCase() !== rootReal.toLowerCase()) {
    return { ok: false, relativePath: relative, reason: 'outside-root' };
  }
  return { ok: true, relativePath: relative };
}

function relativeProbeFailurePath(
  probeRoot: string,
  error: unknown,
): string | undefined {
  const raw = (error as NodeJS.ErrnoException).path;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const normalized = raw.startsWith('\\\\?\\') ? raw.slice(4) : raw;
  const root = path.resolve(probeRoot);
  const target = path.resolve(normalized);
  if (target.toLowerCase() === root.toLowerCase()) {
    return path.basename(target);
  }
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.basename(target);
  }
  return relative;
}

function retryableProbeCleanupCode(code: string): boolean {
  return (
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EBUSY' ||
    code === 'ENOTEMPTY' ||
    code === 'EEXIST'
  );
}

/**
 * Deletes one owned tree without ever following a symlink or junction. Node's
 * native recursive removal on Windows can traverse a junction inside the tree,
 * so this walker unlinks links themselves and recurses only into real
 * directories. Read-only attributes were already cleared by the caller.
 */
function deleteOwnedProbeTree(directory: string): void {
  let visited = 0;
  const limitError = (code: string, message: string): never => {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    throw error;
  };
  const remove = (current: string, depth: number): void => {
    if (depth > PROBE_ATTRIBUTE_SWEEP_MAX_DEPTH) {
      limitError('EPROBE-DEPTH', 'probe tree depth limit exceeded');
    }
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > PROBE_ATTRIBUTE_SWEEP_MAX_ENTRIES) {
        limitError('EPROBE-ENTRIES', 'probe tree entry limit exceeded');
      }
      const full = path.join(current, entry.name);
      let info;
      try {
        info = lstatSync(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (info.isSymbolicLink()) {
        // Remove only the link object; never touch its target.
        try {
          unlinkSync(full);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EPERM' || code === 'EACCES' || code === 'EISDIR') {
            rmdirSync(full);
          } else {
            throw error;
          }
        }
        continue;
      }
      if (info.isDirectory()) {
        remove(full, depth + 1);
        rmdirSync(full);
        continue;
      }
      unlinkSync(full);
    }
  };
  remove(directory, 0);
  rmdirSync(directory);
}

export interface DeepSeekProbeCleanupResult {
  removed: boolean;
  attempts: number;
  elapsedMs: number;
  stage: 'validate' | 'remove';
  code?: string;
  relativePath?: string;
  readOnlyAttributesCleared: number;
  hardLinkedReadOnlyFiles: number;
}

/**
 * Removes only the owned probe workspace. Read-only attributes this probe
 * created are cleared first; transient Windows locks are retried within a
 * fixed deadline. A permanent rejection is reported, never silently claimed.
 * @internal exported for backend cleanup tests (not an IPC/product surface).
 */
export async function removeDeepSeekProbeDirectory(
  probeRoot: string,
  directory: string,
): Promise<DeepSeekProbeCleanupResult> {
  const started = Date.now();
  const ownership = resolveProbeDirectoryOwnership(probeRoot, directory);
  if (!ownership.ok) {
    return {
      removed: false,
      attempts: 0,
      elapsedMs: 0,
      stage: 'validate',
      code: ownership.reason ?? 'not-owned',
      relativePath: ownership.relativePath,
      readOnlyAttributesCleared: 0,
      hardLinkedReadOnlyFiles: 0,
    };
  }
  if (ownership.missing) {
    return {
      removed: true,
      attempts: 0,
      elapsedMs: 0,
      stage: 'remove',
      relativePath: ownership.relativePath,
      readOnlyAttributesCleared: 0,
      hardLinkedReadOnlyFiles: 0,
    };
  }
  let attempts = 0;
  let lastCode: string;
  let relativePath = ownership.relativePath;
  let readOnlyAttributesCleared = 0;
  let hardLinkedReadOnlyFiles: number;
  for (;;) {
    attempts += 1;
    const sweep = clearReadOnlyAttributesUnder(directory);
    readOnlyAttributesCleared += sweep.cleared;
    hardLinkedReadOnlyFiles = sweep.hardLinkedReadOnlyFiles;
    try {
      deleteOwnedProbeTree(directory);
      if (!existsSync(directory)) {
        return {
          removed: true,
          attempts,
          elapsedMs: Date.now() - started,
          stage: 'remove',
          relativePath,
          readOnlyAttributesCleared,
          hardLinkedReadOnlyFiles,
        };
      }
      lastCode = 'EEXIST';
    } catch (error) {
      lastCode =
        ((error as NodeJS.ErrnoException).code as string | undefined) ??
        'EPERM';
      const failed = relativeProbeFailurePath(probeRoot, error);
      if (failed) relativePath = failed;
      if (
        lastCode === 'ENOENT' &&
        !existsSync(directory)
      ) {
        return {
          removed: true,
          attempts,
          elapsedMs: Date.now() - started,
          stage: 'remove',
          relativePath,
          readOnlyAttributesCleared,
          hardLinkedReadOnlyFiles,
        };
      }
      if (!retryableProbeCleanupCode(lastCode)) break;
    }
    const remaining = PROBE_CLEANUP_DEADLINE_MS - (Date.now() - started);
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(PROBE_CLEANUP_POLL_MS, remaining)),
    );
  }
  return {
    removed: false,
    attempts,
    elapsedMs: Date.now() - started,
    stage: 'remove',
    code: lastCode,
    relativePath,
    readOnlyAttributesCleared,
    hardLinkedReadOnlyFiles,
  };
}

/**
 * End-to-end compatibility probe. It uses an isolated CODEX_HOME, a saved-key
 * environment variable, a real Responses stream through app-server, and one
 * no-side-effect shell command. Credentials are never written to config or
 * command-line arguments.
 */
export async function probeDeepSeekCompatibility(
  options: DeepSeekProbeOptions,
): Promise<DeepSeekProbeResult> {
  const timing = detectionTiming(options.logger, 'api-probe');
  const workspace = createDeepSeekProbeWorkspace(options);
  timing('workspace');
  const { probeDir, home, work } = workspace;
  let client: CodexAppServerProcess | undefined;
  const abort = () => client?.dispose();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    client = new CodexAppServerProcess({
      invocation: options.invocation,
      codexHome: home,
      cwd: work,
      logger: options.logger,
      apiKeyEnv: {
        name: 'CHATFGM_DEEPSEEK_API_KEY',
        value: options.service.key,
      },
    });
    await client.start();
    timing('handshake');
    const exposedModels = await client.listModels();
    timing('catalog');
    if (
      !exposedModels.some(
        (model) => model.id === options.discovery.selected.id,
      )
    ) {
      throw new DeepSeekError(
        'deepseek-model-catalog',
        'Codex 未识别到 DeepSeek 模型目录。',
      );
    }
    const thread = await client.startThread({
      model: options.discovery.selected.id,
      modelProvider: 'deepseek',
      cwd: work,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      baseInstructions: BASE_INSTRUCTIONS,
      // This process holds the service key; its tool shells must not inherit
      // the process environment.
      config: {
        shell_environment_policy: buildToolShellEnvironmentPolicy(
          buildShellEnvironmentBase(),
        ),
      },
    });
    timing('thread');
    const threadValue = thread.thread;
    const threadId =
      threadValue && typeof threadValue === 'object'
        ? (threadValue as Record<string, unknown>).id
        : undefined;
    if (typeof threadId !== 'string') {
      throw new DeepSeekError(
        'deepseek-thread',
        'Codex 未返回用于连接测试的线程。',
      );
    }
    const imagePath = path.join(work, 'chatfgm-probe.png');
    writeFileSync(imagePath, PROBE_IMAGE);
    const imageNotification = client.waitForNotification(
      (notification) => {
        if (notification.method !== 'item/completed') return false;
        const params =
          notification.params && typeof notification.params === 'object'
            ? (notification.params as Record<string, unknown>)
            : {};
        const item =
          params.item && typeof params.item === 'object'
            ? (params.item as Record<string, unknown>)
            : null;
        return (
          item?.type === 'imageView' &&
          typeof item.path === 'string'
        );
      },
      PROBE_TIMEOUT_MS,
    );
    await client.startTurn({
      threadId,
      input: [
        {
          type: 'text',
          text: `Call the view_image tool exactly once with path ${JSON.stringify(imagePath)} and detail "high". After the tool returns, reply exactly "${DONE_MARKER}". Do not read, write or modify any other files.`,
        },
      ],
    });
    const imageView = await imageNotification;
    timing('image-tool');
    const imageParams = imageView.params as Record<string, unknown>;
    const imageItem = imageParams.item as Record<string, unknown>;
    let viewedPath = String(imageItem.path);
    try {
      viewedPath = path.resolve(viewedPath);
    } catch {
      // Keep the reported path for the error.
    }
    if (
      viewedPath.toLowerCase() !== path.resolve(imagePath).toLowerCase()
    ) {
      throw new DeepSeekError(
        'deepseek-tool-roundtrip',
        'DeepSeek 工具调用返回了错误的图片路径。',
      );
    }
    const completed = await client.waitForNotification(
      (notification) => {
        if (notification.method !== 'turn/completed') return false;
        const params = notification.params;
        return (
          Boolean(params && typeof params === 'object') &&
          (params as Record<string, unknown>).threadId === threadId
        );
      },
      PROBE_TIMEOUT_MS,
    );
    timing('turn-completed');
    const params = completed.params as Record<string, unknown>;
    const turn = params.turn;
    const turnRecord =
      turn && typeof turn === 'object'
        ? (turn as Record<string, unknown>)
        : {};
    if (turnRecord.status !== 'completed') {
      const error = turnRecord.error;
      const message =
        error && typeof error === 'object'
          ? sanitize(String((error as Record<string, unknown>).message ?? ''))
          : '';
      throw new DeepSeekError(
        'deepseek-turn-failed',
        message
          ? `DeepSeek 测试轮次失败：${message}`
          : 'DeepSeek 测试轮次未完成。',
      );
    }
    const items = turnItems(turn);
    const finalText = items
      .filter((item) => item.type === 'agentMessage')
      .map((item) => (typeof item.text === 'string' ? item.text : ''))
      .join('\n');
    if (!finalText.includes(DONE_MARKER)) {
      throw new DeepSeekError(
        'deepseek-tool-roundtrip',
        'DeepSeek 工具调用后没有返回预期的测试完成标记。',
      );
    }
    return {
      message: `模型：${options.discovery.selected.name}`,
      modelId: options.discovery.selected.id,
      toolRoundTrip: true,
      streaming: true,
    };
  } catch (error) {
    if (error instanceof DeepSeekError) throw error;
    if (error instanceof CodexProtocolError) {
      if (options.signal?.aborted) {
        throw new DeepSeekError(
          'deepseek-cancelled',
          'DeepSeek 连接测试已取消。',
        );
      }
      throw new DeepSeekError(
        error.code === 'codex-timeout'
          ? 'deepseek-timeout'
          : 'deepseek-protocol',
        `DeepSeek 的 Codex 运行层验证失败：${sanitize(error.message)}`,
        { cause: error },
      );
    }
    if (error instanceof CodexLaunchError) {
      throw new DeepSeekError(
        'deepseek-cli',
        `无法启动 Codex CLI 进行 DeepSeek 验证：${sanitize(error.message)}`,
        { cause: error },
      );
    }
    throw new DeepSeekError(
      'deepseek-probe-failed',
      'DeepSeek 连接测试失败。',
      { cause: error },
    );
  } finally {
    options.signal?.removeEventListener('abort', abort);
    client?.dispose();
    timing('process-disposal');
    const cleanup = await removeDeepSeekProbeDirectory(
      options.probeRoot,
      probeDir,
    );
    timing('cleanup');
    if (cleanup.removed) {
      options.logger.info('deepseek-probe-cleanup-succeeded', {
        attempts: cleanup.attempts,
        elapsedMs: cleanup.elapsedMs,
        readOnlyAttributesCleared: cleanup.readOnlyAttributesCleared,
      });
    } else {
      options.logger.warn('deepseek-probe-cleanup-failed', {
        message: 'DeepSeek 临时探测目录未能删除。',
        stage: cleanup.stage,
        code: cleanup.code ?? 'unknown',
        relativePath: cleanup.relativePath ?? '',
        attempts: cleanup.attempts,
        elapsedMs: cleanup.elapsedMs,
        readOnlyAttributesCleared: cleanup.readOnlyAttributesCleared,
        hardLinkedReadOnlyFiles: cleanup.hardLinkedReadOnlyFiles,
      });
    }
  }
}

/**
 * Build the CLI catalog from discovered model metadata. Shared by discovery and protocol fixtures.
 */
export function buildDeepSeekCatalogForModels(
  models: readonly DeepSeekModelMetadata[],
): DeepSeekModelCatalog {
  return {
    models: models.map((model, index) => buildModelEntry(model, index + 1)),
  };
}

export type { CodexModel };
export { SettingsStoreError };
