import type {
  SaveSettingsInput,
  SettingsModelMode,
  SettingsSavedConfig,
} from '../ipc/capabilities';
import type { ApplicationDatabase } from '../storage/database';
import {
  isValidToolboxFolderName,
  MAX_TOOLBOX_NAME,
  toolboxNameError,
} from '../toolboxes/name';

export interface SettingsStoreErrorOptions extends ErrorOptions {
  code: string;
}

export class SettingsStoreError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SettingsStoreError';
    this.code = code;
  }
}

export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface StoredSettings {
  cli: { path: string };
  models: {
    mode: SettingsModelMode;
    activeServiceId: string | null;
    services: Array<{ id: string; name: string; baseUrl: string }>;
  };
  toolboxes: {
    environments: Array<{ toolboxId: string; environmentPath: string }>;
  };
}

export interface LoadedSettings {
  revision: number;
  config: StoredSettings;
  serviceIdsWithKeys: ReadonlySet<string>;
}

export interface SavedSettings {
  revision: number;
  config: StoredSettings;
}

interface ConfigRow {
  revision: number;
  payload: string;
}

interface SecretRow {
  service_id: string;
}

const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_SERVICES = 16;
const MAX_TOOLBOXES = 64;
const MAX_PATH = 4096;
const MAX_NAME = 120;
const MAX_KEY = 4096;
const OFFICIAL_DEEPSEEK_URL = 'https://api.deepseek.com/';

function fail(code: string, message: string): never {
  throw new SettingsStoreError(code, message);
}

function text(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') fail('invalid-settings', `${label}必须是字符串。`);
  if (!allowEmpty && value.length === 0) {
    fail('invalid-settings', `${label}不能为空。`);
  }
  if (value.length > max) {
    fail('invalid-settings', `${label}超过长度限制。`);
  }
  if (
    value.includes('\u0000') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    fail('invalid-settings', `${label}包含不允许的控制字符。`);
  }
  return value;
}

function pathText(value: unknown, label: string): string {
  const pathValue = text(value, label, MAX_PATH, true).trim();
  if (
    pathValue.includes('\u0000') ||
    pathValue.includes('\r') ||
    pathValue.includes('\n')
  ) {
    fail('invalid-settings', `${label}包含不允许的控制字符。`);
  }
  return pathValue;
}

export function normalizeDeepSeekBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    fail('invalid-service-url', 'DeepSeek API 地址不是有效 URL。');
  }
  if (url.protocol !== 'https:') {
    fail('invalid-service-url', 'DeepSeek API 地址必须使用 HTTPS。');
  }
  if (url.username || url.password || url.port) {
    fail('invalid-service-url', 'DeepSeek API 地址不能包含账号、密码或自定义端口。');
  }
  if (url.hostname.toLowerCase() !== 'api.deepseek.com') {
    fail(
      'unsupported-service',
      '当前仅支持 DeepSeek 官方 API：https://api.deepseek.com。',
    );
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== '' && pathname !== '/v1') {
    fail(
      'invalid-service-url',
      'DeepSeek API 地址只接受根地址或 /v1，不能包含其他路径。',
    );
  }
  if (url.search || url.hash) {
    fail('invalid-service-url', 'DeepSeek API 地址不能包含查询参数或片段。');
  }
  return OFFICIAL_DEEPSEEK_URL;
}

function defaultStoredSettings(): StoredSettings {
  return {
    version: 1,
    cli: { path: '' },
    models: {
      mode: 'chatgpt',
      activeServiceId: null,
      services: [],
    },
    toolboxes: { environments: [] },
  } as StoredSettings;
}

function parseStored(payload: string): StoredSettings {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    throw new SettingsStoreError(
      'settings-corrupt',
      '依赖设置不是有效 JSON，原记录已保留。',
      { cause: error },
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('settings-corrupt', '依赖设置结构无效，原记录已保留。');
  }
  const record = value as Record<string, unknown>;
  const cli = record.cli as Record<string, unknown> | undefined;
  const models = record.models as Record<string, unknown> | undefined;
  const toolboxes = record.toolboxes as Record<string, unknown> | undefined;
  if (!cli || !models || !toolboxes) {
    fail('settings-corrupt', '依赖设置缺少必要分组，原记录已保留。');
  }
  if (!Array.isArray(models.services) || !Array.isArray(toolboxes.environments)) {
    fail('settings-corrupt', '依赖设置列表格式无效，原记录已保留。');
  }
  return {
    version: 1,
    cli: { path: pathText(cli.path, 'CLI 路径') },
    models: {
      mode: models.mode === 'api' ? 'api' : 'chatgpt',
      activeServiceId:
        typeof models.activeServiceId === 'string'
          ? models.activeServiceId
          : null,
      services: models.services.map((entry, index) => {
        const service = entry as Record<string, unknown>;
        const id = text(service.id, `服务 ${index + 1} id`, 128);
        if (!SERVICE_ID.test(id)) {
          fail('settings-corrupt', '已保存的服务 ID 无效。');
        }
        return {
          id,
          name: text(service.name, `服务 ${index + 1} 名称`, MAX_NAME),
          baseUrl: normalizeDeepSeekBaseUrl(
            text(service.baseUrl, `服务 ${index + 1} 地址`, MAX_PATH),
          ),
        };
      }),
    },
    toolboxes: {
      environments: toolboxes.environments.map((entry, index) => {
        const env = entry as Record<string, unknown>;
        const toolboxId = text(
          env.toolboxId,
          `工具箱 ${index + 1} 名称`,
          MAX_TOOLBOX_NAME,
        );
        if (!isValidToolboxFolderName(toolboxId)) {
          fail('settings-corrupt', toolboxNameError(`已保存的工具箱 ${index + 1} 名称`));
        }
        return {
          toolboxId,
          environmentPath: pathText(
            env.environmentPath,
            `工具箱 ${toolboxId} 环境路径`,
          ),
        };
      }),
    },
  } as StoredSettings;
}

function asSaved(
  config: StoredSettings,
  serviceIdsWithKeys: ReadonlySet<string>,
): SettingsSavedConfig {
  return {
    cli: { ...config.cli },
    models: {
      mode: config.models.mode,
      activeServiceId: config.models.activeServiceId,
      services: config.models.services.map((service) => ({
        ...service,
        hasKey: serviceIdsWithKeys.has(service.id),
      })),
    },
    toolboxes: { environments: config.toolboxes.environments.map((env) => ({ ...env })) },
  };
}

function validateInput(input: SaveSettingsInput): StoredSettings {
  if (!input || typeof input !== 'object') {
    fail('invalid-settings', '设置保存请求无效。');
  }
  if (!input.models || typeof input.models !== 'object') {
    fail('invalid-settings', '模型设置无效。');
  }
  if (input.models.mode !== 'chatgpt' && input.models.mode !== 'api') {
    fail('invalid-settings', '模型接入模式无效。');
  }
  if (
    !Array.isArray(input.models.services) ||
    input.models.services.length > MAX_SERVICES
  ) {
    fail('invalid-settings', '服务数量超过限制。');
  }
  const ids = new Set<string>();
  const services = input.models.services.map((entry, index) => {
    const id = text(entry.id, `服务 ${index + 1} id`, 128);
    if (!SERVICE_ID.test(id)) {
      fail('invalid-settings', `服务 ${index + 1} ID 无效。`);
    }
    if (ids.has(id)) {
      fail('invalid-settings', '服务 ID 不能重复。');
    }
    ids.add(id);
    return {
      id,
      name: text(entry.name, `服务 ${index + 1} 名称`, MAX_NAME),
      baseUrl: normalizeDeepSeekBaseUrl(
        text(entry.baseUrl, `服务 ${index + 1} 地址`, MAX_PATH),
      ),
    };
  });
  const activeServiceId =
    input.models.activeServiceId === null
      ? null
      : text(input.models.activeServiceId, '当前服务', 128);
  if (input.models.mode === 'api') {
    if (services.length === 0) {
      fail('invalid-settings', '自定义 API 模式至少需要一个服务。');
    }
    if (!activeServiceId || !ids.has(activeServiceId)) {
      fail('invalid-settings', '自定义 API 模式必须选择有效的当前服务。');
    }
  } else if (activeServiceId && !ids.has(activeServiceId)) {
    fail('invalid-settings', '当前服务不在服务列表中。');
  }
  if (
    !input.toolboxes ||
    !Array.isArray(input.toolboxes.environments) ||
    input.toolboxes.environments.length > MAX_TOOLBOXES
  ) {
    fail('invalid-settings', '工具箱环境数量超过限制。');
  }
  const toolboxIds = new Set<string>();
  const environments = input.toolboxes.environments.map((entry, index) => {
    const toolboxId = text(
      entry.toolboxId,
      `工具箱 ${index + 1} 名称`,
      MAX_TOOLBOX_NAME,
    );
    if (!isValidToolboxFolderName(toolboxId)) {
      fail('invalid-settings', toolboxNameError(`工具箱 ${index + 1} 名称`));
    }
    if (toolboxIds.has(toolboxId.toLocaleLowerCase('en-US'))) {
      fail('invalid-settings', '工具箱环境配置不能重复。');
    }
    toolboxIds.add(toolboxId.toLocaleLowerCase('en-US'));
    return {
      toolboxId,
      environmentPath: pathText(
        entry.environmentPath,
        `工具箱 ${toolboxId} 环境路径`,
      ),
    };
  });
  return {
    version: 1,
    cli: { path: pathText(input.cli?.path, 'CLI 路径') },
    models: { mode: input.models.mode, activeServiceId, services },
    toolboxes: { environments },
  } as StoredSettings;
}

/**
 * Main-process-only settings store. Service secrets are encrypted before the
 * transaction starts; the transaction replaces the config and secret rows
 * together so a failure leaves the previous config and keys untouched.
 */
export class SettingsStore {
  constructor(private readonly database: ApplicationDatabase) {}

  load(): LoadedSettings {
    let row: ConfigRow | undefined;
    try {
      row = this.database
        .prepare(
          'SELECT revision, payload FROM settings_config WHERE id = 1',
        )
        .get() as ConfigRow | undefined;
    } catch (error) {
      throw new SettingsStoreError(
        'settings-storage-failed',
        `读取依赖设置失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const revision = row ? row.revision : 0;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      fail('settings-corrupt', '依赖设置 revision 无效。');
    }
    const config = row ? parseStored(row.payload) : defaultStoredSettings();
    const secrets = this.database
      .prepare('SELECT service_id FROM settings_service_secrets')
      .all() as unknown as SecretRow[];
    return {
      revision,
      config,
      serviceIdsWithKeys: new Set(secrets.map((row) => row.service_id)),
    };
  }

  toSaved(
    config: StoredSettings,
    serviceIdsWithKeys: ReadonlySet<string>,
  ): SettingsSavedConfig {
    return asSaved(config, serviceIdsWithKeys);
  }

  hasKey(serviceId: string): boolean {
    const row = this.database
      .prepare(
        'SELECT service_id FROM settings_service_secrets WHERE service_id = ?',
      )
      .get(serviceId) as SecretRow | undefined;
    return Boolean(row);
  }

  decryptKey(serviceId: string, cipher: SecretCipher): string {
    const row = this.database
      .prepare(
        'SELECT encrypted_key FROM settings_service_secrets WHERE service_id = ?',
      )
      .get(serviceId) as { encrypted_key: string } | undefined;
    if (!row) {
      fail('settings-key-missing', '该服务没有已保存的 API Key，请重新输入。');
    }
    try {
      return cipher.decrypt(row.encrypted_key);
    } catch (error) {
      throw new SettingsStoreError(
        'settings-key-unreadable',
        '已保存的 API Key 无法解密；请重新输入密钥，旧密钥未被覆盖。',
        { cause: error },
      );
    }
  }

  save(
    input: SaveSettingsInput,
    cipher: SecretCipher,
  ): { saved: SavedSettings; savedConfig: SettingsSavedConfig } {
    const next = validateInput(input);
    const previous = this.load();
    const existingIds = previous.serviceIdsWithKeys;
    const incomingIds = new Set(next.models.services.map((service) => service.id));
    const keysToWrite = new Map<string, string>();
    const keyInputs = new Map(
      (input.models.services ?? []).map((service) => [service.id, service.key]),
    );
    for (const service of next.models.services) {
      const key = keyInputs.get(service.id);
      if (key !== undefined && key !== null && String(key).length > 0) {
        const normalizedKey = String(key).trim();
        if (normalizedKey.length === 0) {
          fail('settings-key-missing', '新增服务必须提供 API Key。');
        }
        if (normalizedKey.length > MAX_KEY) {
          fail('invalid-settings', 'API Key 超过长度限制。');
        }
        if (!cipher.isAvailable()) {
          fail(
            'settings-encryption-unavailable',
            'Windows 系统加密不可用，无法保存 API Key；不会降级为明文保存。',
          );
        }
        try {
          keysToWrite.set(service.id, cipher.encrypt(normalizedKey));
        } catch (error) {
          throw new SettingsStoreError(
            'settings-encryption-failed',
            'API Key 加密失败，配置和旧密钥均未修改。',
            { cause: error },
          );
        }
      } else if (!existingIds.has(service.id)) {
        fail('settings-key-missing', '新增服务必须提供 API Key。');
      }
    }
    const removedIds = [...existingIds].filter((id) => !incomingIds.has(id));
    this.database.runInTransaction(() => {      const current = this.database
        .prepare('SELECT revision FROM settings_config WHERE id = 1')
        .get() as { revision: number } | undefined;
      if ((current?.revision ?? 0) !== previous.revision) {
        fail(
          'settings-revision-conflict',
          '依赖设置已被其他保存操作更新，本次保存已取消。',
        );
      }
      const revision = previous.revision + 1;
      this.database
        .prepare(
          `INSERT INTO settings_config (id, revision, payload, updated_at)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             revision = excluded.revision,
             payload = excluded.payload,
             updated_at = excluded.updated_at`,
        )
        .run(revision, JSON.stringify(next), new Date().toISOString());
      const writeKey = this.database.prepare(
        `INSERT INTO settings_service_secrets
           (service_id, encrypted_key, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(service_id) DO UPDATE SET
           encrypted_key = excluded.encrypted_key,
           updated_at = excluded.updated_at`,
      );
      for (const [serviceId, encrypted] of keysToWrite) {
        writeKey.run(serviceId, encrypted, new Date().toISOString());
      }
      const remove = this.database.prepare(
        'DELETE FROM settings_service_secrets WHERE service_id = ?',
      );
      for (const serviceId of removedIds) remove.run(serviceId);
    });
    return {
      saved: {
        revision: previous.revision + 1,
        config: next,
      },
      savedConfig: asSaved(next, incomingIds),
    };
  }
}
