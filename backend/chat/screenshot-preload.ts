import { contextBridge, ipcRenderer } from 'electron';

const INIT_CHANNEL = 'chatfgm:screenshot:init';
const SUBMIT_CHANNEL = 'chatfgm:screenshot:submit';
const CANCEL_CHANNEL = 'chatfgm:screenshot:cancel';

function argumentValue(prefix: string): string {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const token = argumentValue('--chatfgm-screenshot-token=');
const generation = Number(
  argumentValue('--chatfgm-screenshot-generation='),
);

interface ScreenshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function validRect(value: unknown): value is ScreenshotRect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Record<string, unknown>;
  return (
    ['x', 'y', 'width', 'height'].every(
      (key) =>
        typeof rect[key] === 'number' &&
        Number.isFinite(rect[key] as number),
    )
  );
}

const bridge = Object.freeze({
  ready(): Promise<unknown> {
    return ipcRenderer.invoke(INIT_CHANNEL, token, generation);
  },
  submit(rect: ScreenshotRect): Promise<unknown> {
    if (!validRect(rect)) {
      return Promise.resolve({
        ok: false,
        message: '选区坐标无效。',
      });
    }
    return ipcRenderer.invoke(
      SUBMIT_CHANNEL,
      token,
      generation,
      rect,
    );
  },
  cancel(): Promise<unknown> {
    return ipcRenderer.invoke(CANCEL_CHANNEL, token, generation);
  },
});

contextBridge.exposeInMainWorld('chatfgmScreenshot', bridge);
