import { randomBytes } from 'node:crypto';
import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  screen,
  type Display,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron';
import type { Logger } from '../platform/log';

const INIT_CHANNEL = 'chatfgm:screenshot:init';
const SUBMIT_CHANNEL = 'chatfgm:screenshot:submit';
const CANCEL_CHANNEL = 'chatfgm:screenshot:cancel';

interface ScreenshotCapture {
  token: string;
  generation: number;
  display: Display;
  image: NativeImage;
  overlay: BrowserWindow;
  resolve: (
    value: { png: Uint8Array; width: number; height: number } | null,
  ) => void;
  settled: boolean;
}

function tokenArgument(token: string): string {
  return `--chatfgm-screenshot-token=${token}`;
}

function generationArgument(generation: number): string {
  return `--chatfgm-screenshot-generation=${generation}`;
}

/**
 * Captures one display through desktopCapturer and shows a dedicated,
 * short-lived selection window. The window never receives the main desktop
 * preload; its only capabilities are one-time init/submit/cancel calls bound to
 * a token and generation owned by this service.
 */
interface PendingCapture {
  token: string;
  generation: number;
  cancelled: boolean;
  settled: boolean;
  record?: ScreenshotCapture;
  resolve: (
    value: { png: Uint8Array; width: number; height: number } | null,
  ) => void;
  reject: (error: unknown) => void;
}

export class ScreenshotService {
  private readonly logger: Logger;
  private readonly overlayHtmlPath: string;
  private readonly preloadPath: string;
  private readonly getMainWindow: () => BrowserWindow | undefined;
  private active: ScreenshotCapture | null = null;
  private pending: PendingCapture | null = null;
  private generation = 0;
  private disposed = false;

  constructor(options: {
    logger: Logger;
    overlayHtmlPath: string;
    preloadPath: string;
    getMainWindow: () => BrowserWindow | undefined;
  }) {
    this.logger = options.logger;
    this.overlayHtmlPath = options.overlayHtmlPath;
    this.preloadPath = options.preloadPath;
    this.getMainWindow = options.getMainWindow;
    this.registerIpc();
  }

  async capture(): Promise<{
    png: Uint8Array;
    width: number;
    height: number;
  } | null> {
    if (this.disposed) throw new Error('截图能力已关闭。');
    if (this.pending) {
      throw new Error('已有一次截图正在取图或等待框选。');
    }
    const token = randomBytes(24).toString('hex');
    this.generation += 1;
    const generation = this.generation;
    const promise = new Promise<{
      png: Uint8Array;
      width: number;
      height: number;
    } | null>((resolve, reject) => {
      const pending: PendingCapture = {
        token,
        generation,
        cancelled: false,
        settled: false,
        resolve,
        reject,
      };
      this.pending = pending;
      void this.runCapture(pending).catch((error) => {
        this.failPending(pending, error);
      });
    });
    return promise;
  }

  private async runCapture(pending: PendingCapture): Promise<void> {
    const mainWindow = this.getMainWindow();
    const display = this.pickDisplay(mainWindow);
    const scaleFactor = display.scaleFactor || 1;
    let image: NativeImage;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.max(1, Math.round(display.size.width * scaleFactor)),
          height: Math.max(1, Math.round(display.size.height * scaleFactor)),
        },
        fetchWindowIcons: false,
      });
      if (!this.pendingIsActive(pending)) return;
      const source =
        sources.find(
          (candidate) =>
            candidate.display_id === String(display.id),
        ) ??
        sources.find((candidate) => {
          const size = candidate.thumbnail.getSize();
          return (
            size.width === Math.round(display.size.width * scaleFactor) &&
            size.height === Math.round(display.size.height * scaleFactor)
          );
        }) ??
        (sources.length === 1 ? sources[0] : undefined);
      if (!source) {
        throw new Error('没有找到可截取的显示器画面。');
      }
      image = source.thumbnail;
      if (image.isEmpty()) {
        throw new Error('屏幕截图内容为空。');
      }
    } catch (error) {
      if (!this.pendingIsActive(pending)) return;
      this.logger.warn('screenshot-capture-failed', {
        message:
          error instanceof Error ? error.message.slice(0, 240) : 'unknown',
      });
      this.failPending(
        pending,
        new Error(
          `屏幕截图失败：${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        ),
      );
      return;
    }
    if (!this.pendingIsActive(pending)) return;

    this.logger.info('screenshot-overlay-opening', {
      generation: pending.generation,
    });
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#111111',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: false,
        spellcheck: false,
        additionalArguments: [
          tokenArgument(pending.token),
          generationArgument(pending.generation),
        ],
      },
    });
    overlay.setMenu(null);
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    overlay.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'Escape') {
        event.preventDefault();
        this.cancelActive('escape');
      }
    });

    const record: ScreenshotCapture = {
      token: pending.token,
      generation: pending.generation,
      display,
      image,
      overlay,
      resolve: () => undefined,
      settled: false,
    };
    const settle = (
      value: { png: Uint8Array; width: number; height: number } | null,
    ) => {
      if (record.settled) return;
      record.settled = true;
      if (this.pending === pending) this.pending = null;
      if (this.active === record) this.active = null;
      this.closeOverlay(record);
      if (!this.disposed) this.restoreMainWindow();
      pending.settled = true;
      pending.resolve(value);
    };
    record.resolve = settle;
    pending.record = record;
    this.active = record;
    if (this.disposed || pending.cancelled) {
      settle(null);
      return;
    }

    overlay.once('ready-to-show', () => {
      if (this.disposed || pending.cancelled || pending.settled) return;
      this.logger.info('screenshot-overlay-ready', {
        generation: pending.generation,
      });
      overlay.show();
      overlay.focus();
    });
    overlay.on('closed', () => {
      this.logger.info('screenshot-overlay-closed', {
        generation: pending.generation,
        settled: record.settled,
      });
      settle(null);
    });
    overlay.loadFile(this.overlayHtmlPath).catch((error) => {
      if (this.disposed || pending.cancelled || pending.settled) return;
      this.logger.warn('screenshot-overlay-load-failed', {
        message:
          error instanceof Error ? error.message.slice(0, 240) : 'unknown',
      });
      settle(null);
    });
  }

  private pendingIsActive(pending: PendingCapture): boolean {
    return (
      !this.disposed &&
      !pending.cancelled &&
      !pending.settled &&
      this.pending === pending
    );
  }

  private failPending(pending: PendingCapture, error: unknown): void {
    if (!this.pendingIsActive(pending)) return;
    const record = pending.record;
    const wasActive = Boolean(record && !record.settled);
    if (record) {
      record.settled = true;
      this.closeOverlay(record);
    }
    pending.settled = true;
    if (this.pending === pending) this.pending = null;
    this.active = null;
    if (wasActive && !this.disposed) this.restoreMainWindow();
    pending.reject(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActive('dispose');
    ipcMain.removeHandler(INIT_CHANNEL);
    ipcMain.removeHandler(SUBMIT_CHANNEL);
    ipcMain.removeHandler(CANCEL_CHANNEL);
  }

  private pickDisplay(mainWindow: BrowserWindow | undefined): Display {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      return screen.getDisplayNearestPoint({
        x: bounds.x + Math.round(bounds.width / 2),
        y: bounds.y + Math.round(bounds.height / 2),
      });
    }
    return screen.getPrimaryDisplay();
  }

  private closeOverlay(record: ScreenshotCapture): void {
    if (!record.overlay.isDestroyed()) {
      record.overlay.close();
    }
  }

  private restoreMainWindow(): void {
    const window = this.getMainWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }

  private cancelActive(reason: string): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    this.logger.info('screenshot-cancelled', { reason });
    pending.cancelled = true;
    if (pending.record) {
      pending.record.resolve(null);
      return;
    }
    pending.settled = true;
    if (this.pending === pending) this.pending = null;
    this.active = null;
    pending.resolve(null);
  }

  private senderMatches(
    event: IpcMainInvokeEvent,
    record: ScreenshotCapture,
  ): boolean {
    if (record.overlay.isDestroyed()) return false;
    if (event.sender !== record.overlay.webContents) return false;
    const frame = event.senderFrame;
    return Boolean(frame && frame.parent === null);
  }

  private parseArguments(
    args: readonly unknown[],
  ): { token: string; generation: number; rest: unknown[] } | null {
    if (args.length < 2) return null;
    const [token, generation, ...rest] = args;
    if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) {
      return null;
    }
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation)
    ) {
      return null;
    }
    return { token, generation, rest };
  }

  private validateCall(
    event: IpcMainInvokeEvent,
    args: readonly unknown[],
  ): { record: ScreenshotCapture; rest: unknown[] } | null {
    const parsed = this.parseArguments(args);
    if (!parsed) return null;
    const record = this.active;
    const pending = this.pending;
    if (
      !record ||
      !pending ||
      pending.record !== record ||
      pending.settled ||
      pending.cancelled ||
      record.settled
    ) {
      return null;
    }
    if (
      record.token !== parsed.token ||
      record.generation !== parsed.generation
    ) {
      return null;
    }
    if (!this.senderMatches(event, record)) return null;
    return { record, rest: parsed.rest };
  }

  private registerIpc(): void {
    ipcMain.handle(INIT_CHANNEL, (event, ...args) => {
      const call = this.validateCall(event, args);
      if (!call) return null;
      const image = call.record.image;
      const size = image.getSize();
      return {
        imageUrl: image.toDataURL(),
        imageWidth: size.width,
        imageHeight: size.height,
        displayWidth: call.record.display.bounds.width,
        displayHeight: call.record.display.bounds.height,
        displayId: String(call.record.display.id),
        scaleFactor: call.record.display.scaleFactor || 1,
      };
    });

    ipcMain.handle(SUBMIT_CHANNEL, (event, ...args) => {
      const call = this.validateCall(event, args);
      if (!call) {
        return { ok: false, message: '截图操作已失效，请重新截图。' };
      }
      const rect = call.rest[0];
      if (!rect || typeof rect !== 'object') {
        return { ok: false, message: '选区无效。' };
      }
      const value = rect as Record<string, unknown>;
      const x = value.x;
      const y = value.y;
      const width = value.width;
      const height = value.height;
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof width !== 'number' ||
        typeof height !== 'number' ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height)
      ) {
        return { ok: false, message: '选区坐标无效。' };
      }
      const imageSize = call.record.image.getSize();
      const display = call.record.display;
      const scaleX = imageSize.width / display.bounds.width;
      const scaleY = imageSize.height / display.bounds.height;
      const left = Math.round(x * scaleX);
      const top = Math.round(y * scaleY);
      const right = Math.round((x + width) * scaleX);
      const bottom = Math.round((y + height) * scaleY);
      if (
        left < 0 ||
        top < 0 ||
        right > imageSize.width ||
        bottom > imageSize.height ||
        right - left < 1 ||
        bottom - top < 1 ||
        width < 2 ||
        height < 2
      ) {
        return { ok: false, message: '选区超出显示器画面或尺寸过小。' };
      }
      let cropped: NativeImage;
      try {
        cropped = call.record.image.crop({
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        });
        if (cropped.isEmpty()) {
          return { ok: false, message: '选区截图为空。' };
        }
      } catch (error) {
        this.logger.warn('screenshot-crop-failed', {
          message:
            error instanceof Error ? error.message.slice(0, 240) : 'unknown',
        });
        return { ok: false, message: '选区截图失败。' };
      }
      const png = cropped.toPNG();
      const size = cropped.getSize();
      if (png.byteLength === 0) {
        return { ok: false, message: '选区截图为空。' };
      }
      call.record.resolve({
        png,
        width: size.width,
        height: size.height,
      });
      return { ok: true };
    });

    ipcMain.handle(CANCEL_CHANNEL, (event, ...args) => {
      const call = this.validateCall(event, args);
      if (call) call.record.resolve(null);
      return { ok: true };
    });
  }
}
