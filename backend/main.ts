import {
  app,
  dialog,
  session,
  shell,
  type BrowserWindow,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DesktopStartupInfo } from './ipc/contracts';
import { registerDesktopIpc } from './ipc/register';
import { FileLogger, type Logger } from './platform/log';
import {
  RuntimeConfigError,
  applyElectronPaths,
  ensureRuntimeDirectories,
  parseRuntimeMode,
  resolveDevelopmentServerUrl,
  resolveRuntimePaths,
  type RuntimeMode,
  type RuntimePaths,
} from './platform/paths';
import { ApplicationDatabase } from './storage/database';import { StorageError } from './storage/errors';
import { WindowStateStore } from './storage/window-state';
import { ProjectService } from './projects/service';
import { ProjectResourceService } from './projects/resources';
import { H5Service } from './h5/service';
import {
  installPreviewScheme,
  registerPreviewProtocol,
} from './preview/protocol';
import {
  registerAttachmentPreviewProtocol,
} from './chat/attachment-preview';
import { ChatService } from './chat/service';
import { WorkspaceService } from './workspace/service';
import { ProjectFileSyncService } from './workspace/file-sync';
import { SettingsService } from './settings/service';
import { DESKTOP_IPC_CHANNELS } from './ipc/contracts';
import {
  createMainWindow,
  createNavigationPolicy,
  loadMainWindow,
  type MainWindowHandle,
} from './window';

installPreviewScheme();

const APP_DISPLAY_NAME = 'ChatFGM';
const startedAt = Date.now();

let mode: RuntimeMode = 'production';
let paths: RuntimePaths | undefined;
let logger: Logger | undefined;
let database: ApplicationDatabase | undefined;
let mainWindow: BrowserWindow | undefined;
let mainWindowHandle: MainWindowHandle | undefined;
let disposeIpc: (() => void) | undefined;
let h5Service: H5Service | undefined;
let workspaceService: WorkspaceService | undefined;
let settingsService: SettingsService | undefined;
let chatService: ChatService | undefined;
let fileSyncService: ProjectFileSyncService | undefined;
let quitAuthorized = false;
let quitRequestPending = false;
let quitRendererReady = false;
let fatalHandled = false;

function isTestDialogSuppressed(): boolean {
  return (
    mode === 'test' &&
    process.env.CHATFGM_TEST_SKIP_ERROR_DIALOGS === '1'
  );
}

function errorCodeOf(error: unknown): string {
  if (error instanceof RuntimeConfigError || error instanceof StorageError) {
    return error.code;
  }
  return 'startup-failed';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showFatalError(error: unknown): void {
  if (fatalHandled) return;
  fatalHandled = true;
  const message = errorMessageOf(error);
  logger?.error('startup-failed', {
    code: errorCodeOf(error),
    message,
  });
  try {
    mainWindowHandle?.dispose();
    disposeIpc?.();
    disposeIpc = undefined;
    chatService?.dispose();
    chatService = undefined;
    fileSyncService?.dispose();
    fileSyncService = undefined;
    settingsService?.dispose();
    settingsService = undefined;
    h5Service?.dispose();
    h5Service = undefined;
    database?.close();
    database = undefined;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  } catch (cleanupError) {
    logger?.error('startup-cleanup-failed', {
      message: errorMessageOf(cleanupError),
    });
  }
  console.error(`[chatfgm] startup failed: ${message}`);
  if (!isTestDialogSuppressed()) {
    dialog.showErrorBox(
      `${APP_DISPLAY_NAME} 启动失败`,
      `${message}\n\n应用未进入可用状态，请检查应用数据目录权限或数据库文件。`,
    );
  }
  app.exit(1);
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function requestQuitApproval(): void {
  if (quitAuthorized || quitRequestPending) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    quitAuthorized = true;
    return;
  }
  // A startup error page or a renderer that has not installed its quit
  // listener yet has no project state to persist. Authorize that close
  // instead of waiting forever for a response that cannot arrive.
  if (!quitRendererReady) {
    quitAuthorized = true;
    mainWindow.close();
    return;
  }
  quitRequestPending = true;
  mainWindow.webContents.send(DESKTOP_IPC_CHANNELS.quitRequested);
}

function respondToQuit(allow: boolean): void {
  quitRequestPending = false;
  if (!allow) return;
  quitAuthorized = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
}

function installSessionHardening(): void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.setDevicePermissionHandler(() => false);
}

function buildStartupInfo(
  runtimePaths: RuntimePaths,
  schemaVersion: number,
): DesktopStartupInfo {
  return {
    appName: runtimePaths.appName,
    appVersion: app.getVersion(),
    mode,
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? '',
    schemaVersion,
    startedAt,
  };
}

function resolveRendererUrl(
  developmentServerUrl: string | undefined,
): string {
  if (mode === 'development') {
    if (!developmentServerUrl) {
      throw new RuntimeConfigError(
        'invalid-dev-server',
        '开发模式缺少本地 Vite 服务地址。',
      );
    }
    return developmentServerUrl;
  }
  const rendererPath = path.join(
    app.getAppPath(),
    'dist',
    'renderer',
    'index.html',
  );
  return pathToFileURL(rendererPath).href;
}

function resolvePreloadPath(): string {
  return path.join(app.getAppPath(), 'dist', 'preload', 'preload.cjs');
}

async function startApplication(runtimePaths: RuntimePaths): Promise<void> {
  const developmentServerUrl = resolveDevelopmentServerUrl(
    mode,
    process.env.CHATFGM_DEV_SERVER_URL,
  );
  const rendererUrl = resolveRendererUrl(developmentServerUrl);
  const navigation = createNavigationPolicy(
    mode,
    rendererUrl,
    developmentServerUrl,
  );

  installSessionHardening();

  const opened = ApplicationDatabase.open({
    databasePath: runtimePaths.databasePath,
  });
  database = opened.database;
  logger?.info('database-ready', {
    schemaVersion: opened.database.schemaVersion,
    appliedVersions: opened.migration.appliedVersions.join(','),
  });

  const windowStateStore = new WindowStateStore(database, logger!);
  const handle = createMainWindow({
    preloadPath: resolvePreloadPath(),
    isAllowedMainFrameUrl: navigation.isAllowedMainFrameUrl,
    windowStateStore,
    logger: logger!,
  });
  mainWindowHandle = handle;
  mainWindow = handle.window;

  const projectService = new ProjectService({
    database,
    attachmentRoot: path.join(runtimePaths.userDataPath, 'chat-attachments'),
    appPath: app.getAppPath(),
    logger: logger!,
    getMainWindow: () => mainWindow,
  });
  const resourceService = new ProjectResourceService(
    projectService,
    logger!,
  );
  h5Service = new H5Service({
    appPath: app.getAppPath(),
    logger: logger!,
    projectService,
  });
  fileSyncService = new ProjectFileSyncService(projectService, logger!);
  workspaceService = new WorkspaceService(database, logger!);
  settingsService = new SettingsService({
    database,
    logger: logger!,
    appPath: app.getAppPath(),
    codexRoot: path.join(runtimePaths.userDataPath, 'codex'),
    probeRoot: path.join(runtimePaths.userDataPath, 'settings-probes'),
    getMainWindow: () => mainWindow,
    openExternal: (url) => shell.openExternal(url),
  });
  chatService = new ChatService({
    database,
    logger: logger!,
    projectService,
    settingsService,
    fileSync: fileSyncService,
    userDataPath: runtimePaths.userDataPath,
    getMainWindow: () => mainWindow,
    screenshotOverlayPath: path.join(
      app.getAppPath(),
      'dist',
      'screenshot',
      'overlay.html',
    ),
    screenshotPreloadPath: path.join(
      app.getAppPath(),
      'dist',
      'preload',
      'screenshot-preload.cjs',
    ),
  });
  settingsService.setChatGuard(chatService);
  chatService.start();
  void settingsService.start().catch((error) => {
    logger!.error('settings-startup-failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  mainWindow.on('close', (event) => {
    if (quitAuthorized) return;
    event.preventDefault();
    requestQuitApproval();
  });
  registerPreviewProtocol(resourceService, logger!);
  registerAttachmentPreviewProtocol(
    chatService.getAttachmentPreviewRegistry(),
    logger!,
  );
  const startupInfo = buildStartupInfo(
    runtimePaths,
    opened.database.schemaVersion,
  );
  disposeIpc = registerDesktopIpc({
    mainWindow,
    startupInfo,
    projectService,
    resourceService,
    h5Service,
    workspaceService,
    settingsService,
    chatService,
    fileSyncService,
    onQuitReady: () => {
      quitRendererReady = true;
    },
    onQuitResponse: respondToQuit,
    isAllowedMainFrameUrl: navigation.isAllowedMainFrameUrl,
  });

  await loadMainWindow(
    handle,
    rendererUrl,
    navigation.isAllowedMainFrameUrl,
    logger!,
  );

  logger?.info('startup-complete', {
    mode,
    appVersion: app.getVersion(),
    schemaVersion: opened.database.schemaVersion,
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? '',
  });
}

function reportEarlyConfigurationError(error: unknown): void {
  console.error(`[chatfgm] ${errorMessageOf(error)}`);
  const suppressDialog =
    process.env.CHATFGM_MODE === 'test' &&
    process.env.CHATFGM_TEST_SKIP_ERROR_DIALOGS === '1';
  if (!suppressDialog) {
    dialog.showErrorBox(
      `${APP_DISPLAY_NAME} 启动失败`,
      `${errorMessageOf(error)}\n\n请使用项目提供的启动命令，不要直接修改运行模式。`,
    );
  }
  app.exit(1);
}

function bootstrap(): void {
  try {
    mode = parseRuntimeMode(process.env.CHATFGM_MODE);
    const appDataPath = app.getPath('appData');
    const localAppDataPath = process.env.LOCALAPPDATA ?? '';
    paths = resolveRuntimePaths({
      mode,
      appDataPath,
      localAppDataPath,
      appPath: app.getAppPath(),
      testRoot: process.env.CHATFGM_TEST_ROOT,
    });
    applyElectronPaths(paths);
    app.setAppUserModelId(
      mode === 'production' ? 'com.chatfgm.app' : `com.chatfgm.app.${mode}`,
    );
  } catch (error) {
    reportEarlyConfigurationError(error);
    return;
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  try {
    ensureRuntimeDirectories(paths);
    logger = new FileLogger(
      paths.logFilePath,
      mode !== 'production',
    );
  } catch (error) {
    reportEarlyConfigurationError(error);
    return;
  }

  logger.info('app-start', {
    mode,
    appName: paths.appName,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? '',
    sqliteVersion: process.versions.sqlite ?? '',
    isolatedTestData: paths.testRootPath !== undefined,
  });

  app.on('second-instance', () => {
    logger?.info('second-instance', { action: 'focus-existing-window' });
    focusMainWindow();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (!quitAuthorized) {
      event.preventDefault();
      requestQuitApproval();
      return;
    }
    mainWindowHandle?.flushWindowState();
  });

  app.on('will-quit', () => {
    try {
      mainWindowHandle?.flushWindowState();
      mainWindowHandle?.dispose();
      disposeIpc?.();
      disposeIpc = undefined;
      h5Service?.dispose();
      h5Service = undefined;
      chatService?.dispose();
      chatService = undefined;
      fileSyncService?.dispose();
      fileSyncService = undefined;
      settingsService?.dispose();
      settingsService = undefined;
      database?.close();
      database = undefined;
      logger?.info('app-quit');
    } catch (error) {
      logger?.error('quit-cleanup-failed', {
        message: errorMessageOf(error),
      });
    }
  });

  app.whenReady().then(async () => {
    try {
      await startApplication(paths!);
    } catch (error) {
      showFatalError(error);
    }
  });
}

bootstrap();
