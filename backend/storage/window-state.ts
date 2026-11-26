import type { Logger } from '../platform/log';
import type { ApplicationDatabase } from './database';

export interface WindowStateRecord {
  /** Outer window position. */
  x: number;
  y: number;
  /** Normal (non-maximized) content size. */
  contentWidth: number;
  contentHeight: number;
  maximized: boolean;
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_STATE: WindowStateRecord = {
  x: 0,
  y: 0,
  contentWidth: 1440,
  contentHeight: 900,
  maximized: false,
};

export const MIN_CONTENT_WIDTH = 800;
export const MIN_CONTENT_HEIGHT = 320;

/** Rough Windows frame allowance used only for restoring old bounds. */
const FRAME_ALLOWANCE_WIDTH = 16;
const FRAME_ALLOWANCE_HEIGHT = 40;
const MIN_VISIBLE_EDGE = 80;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function intersectionSize(
  left: WorkArea,
  right: WorkArea,
): { width: number; height: number; area: number } {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  return { width, height, area: width * height };
}

function fitContentToArea(
  width: number,
  height: number,
  area: WorkArea,
): { width: number; height: number } {
  const availableWidth = Math.max(
    MIN_CONTENT_WIDTH,
    area.width - FRAME_ALLOWANCE_WIDTH,
  );
  const availableHeight = Math.max(
    MIN_CONTENT_HEIGHT,
    area.height - FRAME_ALLOWANCE_HEIGHT,
  );
  return {
    width: clamp(Math.round(width), MIN_CONTENT_WIDTH, availableWidth),
    height: clamp(Math.round(height), MIN_CONTENT_HEIGHT, availableHeight),
  };
}

function centeredIn(area: WorkArea, width: number, height: number): WindowStateRecord {
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    contentWidth: width,
    contentHeight: height,
    maximized: false,
  };
}

/**
 * Places a saved or default window inside a display work area. Fully invisible
 * positions and stale monitor layouts fall back to the primary display; a
 * partially visible window is pulled back into the chosen work area.
 */
export function resolveWindowPlacement(
  saved: WindowStateRecord | null,
  workAreas: readonly WorkArea[],
  primaryWorkArea: WorkArea,
): WindowStateRecord {
  if (workAreas.length === 0) {
    return { ...DEFAULT_WINDOW_STATE };
  }

  if (!saved) {
    const fitted = fitContentToArea(
      DEFAULT_WINDOW_STATE.contentWidth,
      DEFAULT_WINDOW_STATE.contentHeight,
      primaryWorkArea,
    );
    return centeredIn(primaryWorkArea, fitted.width, fitted.height);
  }

  const candidate: WindowStateRecord = {
    ...saved,
    contentWidth: clamp(
      Math.round(saved.contentWidth),
      MIN_CONTENT_WIDTH,
      10_000,
    ),
    contentHeight: clamp(
      Math.round(saved.contentHeight),
      MIN_CONTENT_HEIGHT,
      10_000,
    ),
  };

  const proposed: WorkArea = {
    x: candidate.x,
    y: candidate.y,
    width: candidate.contentWidth + FRAME_ALLOWANCE_WIDTH,
    height: candidate.contentHeight + FRAME_ALLOWANCE_HEIGHT,
  };

  let chosen: WorkArea | null = null;
  let chosenArea = -1;
  for (const area of workAreas) {
    const overlap = intersectionSize(proposed, area);
    if (
      overlap.width >= MIN_VISIBLE_EDGE &&
      overlap.height >= MIN_VISIBLE_EDGE &&
      overlap.area > chosenArea
    ) {
      chosen = area;
      chosenArea = overlap.area;
    }
  }

  if (!chosen) {
    const fitted = fitContentToArea(
      candidate.contentWidth,
      candidate.contentHeight,
      primaryWorkArea,
    );
    return {
      ...centeredIn(primaryWorkArea, fitted.width, fitted.height),
      maximized: candidate.maximized,
    };
  }

  const fitted = fitContentToArea(
    candidate.contentWidth,
    candidate.contentHeight,
    chosen,
  );
  const maximumX = chosen.x + chosen.width - fitted.width - FRAME_ALLOWANCE_WIDTH;
  const maximumY =
    chosen.y + chosen.height - fitted.height - FRAME_ALLOWANCE_HEIGHT;
  return {
    x: clamp(candidate.x, chosen.x, Math.max(chosen.x, maximumX)),
    y: clamp(candidate.y, chosen.y, Math.max(chosen.y, maximumY)),
    contentWidth: fitted.width,
    contentHeight: fitted.height,
    maximized: candidate.maximized,
  };
}

export class WindowStateStore {
  private readonly database: ApplicationDatabase;
  private readonly logger: Logger;

  constructor(database: ApplicationDatabase, logger: Logger) {
    this.database = database;
    this.logger = logger;
  }

  load(): WindowStateRecord | null {
    return this.database.readWindowState();
  }

  save(state: WindowStateRecord): void {
    try {
      this.database.writeWindowState(state);
    } catch (error) {
      this.logger.error('window-state-save-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
