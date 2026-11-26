import { app } from 'electron';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Runtime modes are explicit launch configurations. They are never inferred
 * from `app.isPackaged`: the current step has no installer, so the built app
 * must be able to run from the repository.
 */
export type RuntimeMode = 'development' | 'production' | 'test';

export interface RuntimePathInput {
  mode: RuntimeMode;
  /** Electron's `appData` path, normally %APPDATA% on Windows. */
  appDataPath: string;
  /** %LOCALAPPDATA% on Windows. */
  localAppDataPath: string;
  /** Repository root while the app runs from source. */
  appPath: string;
  /** Required in test mode; must point below <appPath>/test/results. */
  testRoot?: string;
}

export interface RuntimePaths {
  mode: RuntimeMode;
  appName: string;
  userDataPath: string;
  databasePath: string;
  cachePath: string;
  logsPath: string;
  logFilePath: string;
  sessionDataPath: string;
  crashDumpsPath: string;
  /** Only set in test mode; production/dev keep the system temp directory. */
  tempPath?: string;
  testRootPath?: string;
}

export type RuntimeConfigErrorCode =
  | 'invalid-mode'
  | 'invalid-test-root'
  | 'invalid-dev-server'
  | 'invalid-local-app-data'
  | 'data-directory-unavailable';

export class RuntimeConfigError extends Error {
  readonly code: RuntimeConfigErrorCode;

  constructor(
    code: RuntimeConfigErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeConfigError';
    this.code = code;
  }
}

export function parseRuntimeMode(value: string | undefined): RuntimeMode {
  if (value === undefined || value.trim() === '') return 'production';
  if (
    value === 'development' ||
    value === 'production' ||
    value === 'test'
  ) {
    return value;
  }
  throw new RuntimeConfigError(
    'invalid-mode',
    `不支持的运行模式：${value}`,
  );
}

export function appNameForMode(mode: RuntimeMode): string {
  if (mode === 'development') return 'ChatFGM-dev';
  if (mode === 'test') return 'ChatFGM-test';
  return 'ChatFGM';
}

function assertAbsoluteDirectory(value: string, label: string): string {
  if (!value || !path.isAbsolute(value)) {
    throw new RuntimeConfigError(
      'invalid-local-app-data',
      `${label}不是有效的绝对路径。`,
    );
  }
  return path.resolve(value);
}

function canonicalizeExistingPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function resolveTestRoot(appPath: string, testRoot: string | undefined): string {
  if (!testRoot || !path.isAbsolute(testRoot)) {
    throw new RuntimeConfigError(
      'invalid-test-root',
      '测试模式必须通过受控启动配置提供 test/results 下的绝对测试目录。',
    );
  }

  const resultsRoot = canonicalizeExistingPath(
    path.resolve(appPath, 'test', 'results'),
  );
  const resolved = canonicalizeExistingPath(path.resolve(testRoot));
  const relative = path.relative(resultsRoot, resolved);
  const escapesResultsRoot =
    relative === '..' || relative.startsWith(`..${path.sep}`);
  if (!relative || escapesResultsRoot || path.isAbsolute(relative)) {
    throw new RuntimeConfigError(
      'invalid-test-root',
      `测试目录必须位于 ${resultsRoot} 的独立子目录中。`,
    );
  }
  return resolved;
}

/**
 * Pure path calculation. Keeping it free of Electron side effects makes the
 * development/production/test separation testable in the real Electron
 * runtime without touching the user's application data.
 */
export function resolveRuntimePaths(input: RuntimePathInput): RuntimePaths {
  const appPath = assertAbsoluteDirectory(input.appPath, '应用目录');
  const appName = appNameForMode(input.mode);

  // Test mode always uses the isolated layout. A development-mode run may
  // opt into the same isolated layout only through the controlled launcher
  // environment, which lets automated development-start checks avoid touching
  // the real ChatFGM-dev directory. Production never honors this override.
  const isolatedTestRun =
    input.mode === 'test' ||
    (input.mode === 'development' && input.testRoot !== undefined);
  if (isolatedTestRun) {
    const testRootPath = resolveTestRoot(appPath, input.testRoot);
    const userDataPath = path.join(testRootPath, 'app-data');
    const logsPath = path.join(testRootPath, 'logs');
    return {
      mode: input.mode,
      appName,
      userDataPath,
      databasePath: path.join(userDataPath, 'state', 'chatfgm.sqlite'),
      cachePath: path.join(testRootPath, 'chromium', 'cache'),
      logsPath,
      logFilePath: path.join(logsPath, 'chatfgm.log'),
      sessionDataPath: path.join(testRootPath, 'chromium', 'session-data'),
      crashDumpsPath: path.join(testRootPath, 'chromium', 'crash-dumps'),
      tempPath: path.join(testRootPath, 'temp'),
      testRootPath,
    };
  }

  const appDataPath = assertAbsoluteDirectory(
    input.appDataPath,
    '应用数据目录',
  );
  const localAppDataPath = assertAbsoluteDirectory(
    input.localAppDataPath,
    '本地应用数据目录',
  );
  const userDataPath = path.join(appDataPath, appName);
  const localAppDir = path.join(localAppDataPath, appName);
  const logsPath = path.join(localAppDir, 'Logs');

  return {
    mode: input.mode,
    appName,
    userDataPath,
    databasePath: path.join(userDataPath, 'state', 'chatfgm.sqlite'),
    cachePath: path.join(localAppDir, 'Cache'),
    logsPath,
    logFilePath: path.join(logsPath, 'chatfgm.log'),
    sessionDataPath: path.join(localAppDir, 'Session Data'),
    crashDumpsPath: path.join(localAppDir, 'Crash Reports'),
  };
}

/**
 * Applies the calculated locations before Electron is ready. Only the main
 * process calls this; the renderer never receives a path-switching API.
 */
export function applyElectronPaths(paths: RuntimePaths): void {
  app.setName(paths.appName);
  app.setPath('userData', paths.userDataPath);
  app.setPath('cache', paths.cachePath);
  app.setPath('logs', paths.logsPath);
  app.setPath('sessionData', paths.sessionDataPath);
  app.setPath('crashDumps', paths.crashDumpsPath);
  if (paths.tempPath) app.setPath('temp', paths.tempPath);
}

export function ensureRuntimeDirectories(paths: RuntimePaths): void {
  const directories = [
    paths.userDataPath,
    path.dirname(paths.databasePath),
    paths.cachePath,
    paths.logsPath,
    paths.sessionDataPath,
    paths.crashDumpsPath,
    ...(paths.tempPath ? [paths.tempPath] : []),
  ];
  for (const directory of directories) {
    try {
      mkdirSync(directory, { recursive: true });
    } catch (error) {
      throw new RuntimeConfigError(
        'data-directory-unavailable',
        `无法创建应用数据目录：${directory}`,
        { cause: error },
      );
    }
  }
}

/**
 * Development mode loads the local Vite server. Only loopback HTTP URLs are
 * accepted so a launch configuration cannot turn the window into a remote
 * browser.
 */
export function resolveDevelopmentServerUrl(
  mode: RuntimeMode,
  value: string | undefined,
): string | undefined {
  if (mode !== 'development') return undefined;
  if (!value) {
    throw new RuntimeConfigError(
      'invalid-dev-server',
      '开发模式需要 CHATFGM_DEV_SERVER_URL 指向本地 Vite 服务。',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeConfigError(
      'invalid-dev-server',
      `开发服务器地址无效：${value}`,
    );
  }
  const isLoopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]';
  if (
    parsed.protocol !== 'http:' ||
    !isLoopback ||
    parsed.username ||
    parsed.password
  ) {
    throw new RuntimeConfigError(
      'invalid-dev-server',
      '开发服务器必须是本机 HTTP 地址。',
    );
  }
  return parsed.href;
}
