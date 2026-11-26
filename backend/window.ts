import { app, BrowserWindow, Menu, screen } from 'electron';
import path from 'node:path';
import type { Logger } from './platform/log';
import type { RuntimeMode } from './platform/paths';
import {
  MIN_CONTENT_WIDTH,
  resolveWindowPlacement,
  type WindowStateRecord,
  type WindowStateStore,
} from './storage/window-state';

export interface MainWindowOptions {
  preloadPath: string;
  isAllowedMainFrameUrl: (url: string) => boolean;
  windowStateStore: WindowStateStore;
  logger: Logger;
}

export interface MainWindowHandle {
  window: BrowserWindow;
  flushWindowState(): void;
  dispose(): void;
}

export interface NavigationPolicy {
  isAllowedMainFrameUrl(url: string): boolean;
}

/**
 * The Windows shell icon (taskbar and Alt-Tab) comes from the window icon.
 * Reuse the exact RGBA asset rendered by the Workbench header so both stay on
 * the same logo, color, and transparency.
 */
function resolveWorkbenchIconPath(): string {
  return path.join(
    app.getAppPath(),
    'app',
    'assets',
    'chatfgm-logo-color.png',
  );
}

/**
 * Returns a normalized, fully-qualified URL with only the hash removed.
 * `URL` normalizes protocol/host/path/query serialization, while keeping a
 * `file://host/...` host distinct from the trusted local `file:///...` entry.
 */
function normalizedUrlWithoutHash(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function createNavigationPolicy(
  mode: RuntimeMode,
  rendererUrl: string,
  developmentServerUrl: string | undefined,
): NavigationPolicy {
  const trustedRendererUrl = normalizedUrlWithoutHash(rendererUrl);
  if (!trustedRendererUrl) {
    throw new Error('桌面界面入口 URL 无效。');
  }
  const trustedRenderer = new URL(trustedRendererUrl);
  if (
    mode !== 'development' &&
    (trustedRenderer.protocol !== 'file:' ||
      trustedRenderer.hostname !== '' ||
      trustedRenderer.port !== '' ||
      trustedRenderer.username !== '' ||
      trustedRenderer.password !== '')
  ) {
    throw new Error('production/test 只允许本地构建入口 file:///...。');
  }

  const developmentOrigin = developmentServerUrl
    ? new URL(developmentServerUrl).origin
    : undefined;

  return {
    isAllowedMainFrameUrl(url: string): boolean {
      const candidateUrl = normalizedUrlWithoutHash(url);
      if (!candidateUrl) return false;

      if (mode === 'development') {
        const parsed = new URL(candidateUrl);
        return (
          developmentOrigin !== undefined &&
          parsed.protocol === 'http:' &&
          parsed.origin === developmentOrigin
        );
      }

      const parsed = new URL(candidateUrl);
      // A remote/UNC file host such as file://untrusted-host/... must never
      // become trusted merely because the pathname matches. A file://localhost
      // URL is canonicalized by the URL parser to the same local entry and is
      // therefore not a remote host.
      if (
        parsed.protocol !== 'file:' ||
        parsed.hostname !== '' ||
        parsed.port !== '' ||
        parsed.username !== '' ||
        parsed.password !== ''
      ) {
        return false;
      }
      return candidateUrl === trustedRendererUrl;
    },
  };
}

/**
 * Creates the single main window with a Windows-native frame. The persisted
 * size is the web contents area; `useContentSize` keeps the default at
 * 1440x900 content pixels instead of an outer frame size.
 */
export function createMainWindow(options: MainWindowOptions): MainWindowHandle {
  const saved = options.windowStateStore.load();
  const workAreas = screen
    .getAllDisplays()
    .map((display) => display.workArea);
  const primary = screen.getPrimaryDisplay().workArea;
  const placement = resolveWindowPlacement(saved, workAreas, primary);

  const window = new BrowserWindow({
    x: placement.x,
    y: placement.y,
    width: placement.contentWidth,
    height: placement.contentHeight,
    useContentSize: true,
    minWidth: MIN_CONTENT_WIDTH,
    show: false,
    title: 'ChatFGM',
    icon: resolveWorkbenchIconPath(),
    backgroundColor: '#ffffff',
    frame: true,
    titleBarStyle: 'hidden',
    // The application header owns the title bar. The native Windows
    // minimize/maximize/close controls are drawn in this 52px overlay.
    titleBarOverlay: {
      // Transparent so the header's own background and bottom hairline remain
      // visible underneath the native caption buttons.
      color: '#ffffff00',
      symbolColor: '#302c27',
      height: 52,
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: true,
    },
  });
  Menu.setApplicationMenu(null);
  // Windows rounds the initial content size under high DPI. Setting it once
  // after construction keeps the default at the requested 1440x900 content
  // area while the native frame remains outside that size.
  window.setContentSize(placement.contentWidth, placement.contentHeight);

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!options.isAllowedMainFrameUrl(url)) {
      options.logger.warn('navigation-blocked', { url: url.slice(0, 200) });
      event.preventDefault();
    }
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    options.logger.error('preload-failed', {
      path: preloadPath,
      message: error.message,
    });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    options.logger.error('renderer-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  window.on('unresponsive', () => {
    options.logger.warn('window-unresponsive');
  });

  let lastNormal: WindowStateRecord = {
    x: window.getBounds().x,
    y: window.getBounds().y,
    contentWidth: window.getContentBounds().width,
    contentHeight: window.getContentBounds().height,
    maximized: false,
  };
  // Tracks the last effective maximize state. Minimizing a maximized window
  // makes isMaximized() return false, so isMaximized() alone must not be used
  // while the window is minimized.
  let lastMaximized = placement.maximized;
  let saveTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  const applyMinimumContentWidth = () => {
    if (window.isDestroyed()) return;
    window.setMinimumSize(MIN_CONTENT_WIDTH, 0);
    if (
      window.isMaximized() ||
      window.isMinimized() ||
      window.isFullScreen()
    ) {
      return;
    }
    const [width, height] = window.getContentSize();
    if (width < MIN_CONTENT_WIDTH) {
      window.setContentSize(MIN_CONTENT_WIDTH, height);
    }
  };
  applyMinimumContentWidth();
  window.on('resize', applyMinimumContentWidth);

  const readNormalBounds = (): WindowStateRecord => {
    const bounds = window.getBounds();
    const content = window.getContentBounds();
    return {
      x: bounds.x,
      y: bounds.y,
      contentWidth: Math.max(MIN_CONTENT_WIDTH, content.width),
      contentHeight: Math.max(1, content.height),
      maximized: false,
    };
  };

  const stateForPersistence = (): WindowStateRecord => {
    if (!window.isDestroyed()) {
      if (window.isMaximized()) {
        lastMaximized = true;
      } else if (!window.isMinimized()) {
        lastMaximized = false;
      }
    }
    return { ...lastNormal, maximized: lastMaximized };
  };

  const persistNow = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (disposed) return;
    if (
      !window.isDestroyed() &&
      !window.isMinimized() &&
      !window.isMaximized() &&
      !window.isFullScreen()
    ) {
      // Include a move/resize that is still inside the debounce window.
      lastNormal = readNormalBounds();
    }
    const state = stateForPersistence();
    lastMaximized = state.maximized;
    options.windowStateStore.save(state);
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 400);
  };

  const captureNormalState = () => {
    if (window.isDestroyed()) return;
    if (
      window.isMaximized() ||
      window.isMinimized() ||
      window.isFullScreen()
    ) {
      return;
    }
    lastNormal = readNormalBounds();
    scheduleSave();
  };

  window.on('move', captureNormalState);
  window.on('resize', captureNormalState);
  window.on('minimize', () => {
    // Do not change lastMaximized: minimizing is not an explicit unmaximize.
    scheduleSave();
  });
  window.on('restore', () => {
    // After a minimize, use the real restored maximize state.
    lastMaximized = window.isMaximized();
    scheduleSave();
  });
  window.on('maximize', () => {
    lastMaximized = true;
    scheduleSave();
  });
  window.on('unmaximize', () => {
    // A minimize-induced unmaximize is not a user restore-down action.
    if (window.isMinimized()) return;
    lastMaximized = false;
    setTimeout(captureNormalState, 0);
  });
  window.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!window.isDestroyed()) {
      if (
        !window.isMinimized() &&
        !window.isMaximized() &&
        !window.isFullScreen()
      ) {
        // Capture the latest normal bounds even if the 400ms debounce has not
        // fired yet.
        lastNormal = readNormalBounds();
      }
      const state = stateForPersistence();
      lastMaximized = state.maximized;
      options.windowStateStore.save(state);
    }
  });
  window.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    disposed = true;
  });
  window.once('show', () => {
    if (!window.isMaximized() && !window.isMinimized()) {
      captureNormalState();
    }
  });

  if (placement.maximized) {
    window.maximize();
  }

  return {
    window,
    flushWindowState: persistNow,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
    },
  };
}

export async function loadMainWindow(
  handle: MainWindowHandle,
  rendererUrl: string,
  isAllowedMainFrameUrl: (url: string) => boolean,
  logger: Logger,
): Promise<void> {
  const { window } = handle;
  try {
    await window.loadURL(rendererUrl);
  } catch (error) {
    throw new Error(
      `无法加载桌面界面：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const currentUrl = window.webContents.getURL();
  if (!isAllowedMainFrameUrl(currentUrl)) {
    throw new Error(`桌面界面加载到了未授权地址：${currentUrl}`);
  }

  const hasBridge = await window.webContents.executeJavaScript(
    'Boolean(window.chatfgmDesktop && typeof window.chatfgmDesktop.getStartupInfo === "function")',
    true,
  );
  if (!hasBridge) {
    throw new Error('桌面桥接未加载，应用启动校验未通过。');
  }

  if (!window.isVisible()) window.show();
  window.focus();
  logger.info('main-window-ready', {
    url: currentUrl.startsWith('file:') ? 'file' : 'development-server',
    contentWidth: window.getContentSize()[0],
    contentHeight: window.getContentSize()[1],
  });
}
