import type { WorkspaceLayoutSnapshot } from '../services/workspace';

export type PanelSide = 'left' | 'right';

export const PANEL_MIN_WIDTH: Record<PanelSide, number> = {
  left: 180,
  right: 280,
};

export interface LayoutState {
  leftVisible: boolean;
  rightVisible: boolean;
  leftWidth: number;
  rightWidth: number;
  viewportWidth: number;
  customized: boolean;
  resizingSide: PanelSide | null;
}

export type LayoutAction =
  | { type: 'toggle-panel'; side: PanelSide }
  | { type: 'set-width'; side: PanelSide; width: number }
  | { type: 'reset-width'; side: PanelSide }
  | { type: 'start-resize'; side: PanelSide }
  | { type: 'end-resize' }
  | { type: 'viewport-resize'; viewportWidth: number }
  | { type: 'restore-layout'; snapshot: WorkspaceLayoutSnapshot };

const SPLITTER_WIDTH = 1;
const NARROW_BREAKPOINT = 880;
const WIDE_DEFAULT_LEFT = 240;
const WIDE_DEFAULT_RIGHT = 360;
const NARROW_DEFAULT_LEFT = 180;
const NARROW_DEFAULT_RIGHT = 280;
const NARROW_WORKSPACE = 260;
const REGULAR_WORKSPACE = 480;

function defaultWidths(viewportWidth: number): { left: number; right: number } {
  if (viewportWidth <= 880) {
    return { left: NARROW_DEFAULT_LEFT, right: NARROW_DEFAULT_RIGHT };
  }
  if (viewportWidth <= 1024) {
    return { left: 200, right: 320 };
  }
  return { left: WIDE_DEFAULT_LEFT, right: WIDE_DEFAULT_RIGHT };
}

function minWorkspaceWidth(viewportWidth: number): number {
  return viewportWidth <= NARROW_BREAKPOINT ? NARROW_WORKSPACE : REGULAR_WORKSPACE;
}

function isVisible(state: LayoutState, side: PanelSide): boolean {
  return side === 'left' ? state.leftVisible : state.rightVisible;
}

function widthFor(state: LayoutState, side: PanelSide): number {
  return side === 'left' ? state.leftWidth : state.rightWidth;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Maximum width for a side if that side becomes visible. The calculation
 * always includes the side's splitter and the currently visible counterpart.
 */
export function maxPanelWidth(state: LayoutState, side: PanelSide): number {
  const bothVisible =
    side === 'left' ? state.rightVisible : state.leftVisible;
  const splitterCount = bothVisible ? 2 : 1;
  const otherWidth =
    side === 'left'
      ? state.rightVisible
        ? state.rightWidth
        : 0
      : state.leftVisible
        ? state.leftWidth
        : 0;

  return (
    state.viewportWidth -
    splitterCount * SPLITTER_WIDTH -
    otherWidth -
    minWorkspaceWidth(state.viewportWidth)
  );
}

function clampPanelWidth(
  state: LayoutState,
  side: PanelSide,
  width: number,
): number {
  return Math.round(
    clamp(
      width,
      PANEL_MIN_WIDTH[side],
      maxPanelWidth(state, side),
    ),
  );
}

export function createInitialLayoutState(viewportWidth: number): LayoutState {
  const widths = defaultWidths(viewportWidth);
  return {
    leftVisible: true,
    rightVisible: true,
    leftWidth: widths.left,
    rightWidth: widths.right,
    viewportWidth,
    customized: false,
    resizingSide: null,
  };
}

export function layoutReducer(
  state: LayoutState,
  action: LayoutAction,
): LayoutState {
  switch (action.type) {
    case 'toggle-panel': {
      const visible = isVisible(state, action.side);
      if (visible) {
        return {
          ...state,
          [action.side === 'left' ? 'leftVisible' : 'rightVisible']: false,
          resizingSide:
            state.resizingSide === action.side ? null : state.resizingSide,
          customized: true,
        };
      }

      const otherSide: PanelSide = action.side === 'left' ? 'right' : 'left';
      const otherVisible = isVisible(state, otherSide);
      const splitterCount = otherVisible ? 2 : 1;
      const panelSpace =
        state.viewportWidth -
        splitterCount * SPLITTER_WIDTH -
        minWorkspaceWidth(state.viewportWidth);

      let nextWidth = clampPanelWidth(
        state,
        action.side,
        widthFor(state, action.side),
      );
      let otherWidth = otherVisible ? widthFor(state, otherSide) : 0;

      if (otherVisible && nextWidth + otherWidth > panelSpace) {
        nextWidth = Math.round(
          Math.min(
            nextWidth,
            panelSpace - PANEL_MIN_WIDTH[otherSide],
          ),
        );
        otherWidth = Math.round(
          Math.max(
            PANEL_MIN_WIDTH[otherSide],
            panelSpace - nextWidth,
          ),
        );

        if (nextWidth + otherWidth > panelSpace) {
          otherWidth -= nextWidth + otherWidth - panelSpace;
        }
      }

      return {
        ...state,
        [action.side === 'left' ? 'leftVisible' : 'rightVisible']: true,
        [action.side === 'left' ? 'leftWidth' : 'rightWidth']: nextWidth,
        ...(otherVisible
          ? {
              [otherSide === 'left' ? 'leftWidth' : 'rightWidth']:
                otherWidth,
            }
          : {}),
        customized: true,
      };
    }

    case 'set-width': {
      if (!isVisible(state, action.side)) return state;
      const width = clampPanelWidth(state, action.side, action.width);
      if (width === widthFor(state, action.side)) return state;
      return {
        ...state,
        [action.side === 'left' ? 'leftWidth' : 'rightWidth']: width,
        customized: true,
      };
    }

    case 'reset-width': {
      if (!isVisible(state, action.side)) return state;
      const widths =
        state.viewportWidth <= NARROW_BREAKPOINT
          ? { left: NARROW_DEFAULT_LEFT, right: NARROW_DEFAULT_RIGHT }
          : { left: WIDE_DEFAULT_LEFT, right: WIDE_DEFAULT_RIGHT };
      return {
        ...state,
        [action.side === 'left' ? 'leftWidth' : 'rightWidth']: clampPanelWidth(
          state,
          action.side,
          widths[action.side],
        ),
        customized: true,
      };
    }

    case 'start-resize':
      if (!isVisible(state, action.side)) return state;
      if (state.resizingSide === action.side) return state;
      return { ...state, resizingSide: action.side };

    case 'end-resize':
      if (state.resizingSide === null) return state;
      return { ...state, resizingSide: null };

    case 'viewport-resize': {
      if (action.viewportWidth === state.viewportWidth) return state;

      if (!state.customized) {
        const widths = defaultWidths(action.viewportWidth);
        return {
          ...state,
          viewportWidth: action.viewportWidth,
          leftWidth: widths.left,
          rightWidth: widths.right,
        };
      }

      let leftWidth = state.leftWidth;
      let rightWidth = state.rightWidth;
      const splitterCount =
        (state.leftVisible ? 1 : 0) + (state.rightVisible ? 1 : 0);

      if (state.leftVisible) {
        leftWidth = clamp(
          leftWidth,
          PANEL_MIN_WIDTH.left,
          action.viewportWidth -
            splitterCount * SPLITTER_WIDTH -
            (state.rightVisible ? rightWidth : 0) -
            minWorkspaceWidth(action.viewportWidth),
        );
      }

      if (state.rightVisible) {
        rightWidth = clamp(
          rightWidth,
          PANEL_MIN_WIDTH.right,
          action.viewportWidth -
            splitterCount * SPLITTER_WIDTH -
            (state.leftVisible ? leftWidth : 0) -
            minWorkspaceWidth(action.viewportWidth),
        );
      }

      return {
        ...state,
        viewportWidth: action.viewportWidth,
        leftWidth: Math.round(leftWidth),
        rightWidth: Math.round(rightWidth),
      };
    }

    case 'restore-layout': {
      const viewport = state.viewportWidth;
      const splitterCount =
        (action.snapshot.leftVisible ? 1 : 0) +
        (action.snapshot.rightVisible ? 1 : 0);
      const available =
        viewport -
        splitterCount * SPLITTER_WIDTH -
        minWorkspaceWidth(viewport);
      let leftWidth = Math.round(
        clamp(
          action.snapshot.leftWidth,
          PANEL_MIN_WIDTH.left,
          Math.max(PANEL_MIN_WIDTH.left, available),
        ),
      );
      let rightWidth = Math.round(
        clamp(
          action.snapshot.rightWidth,
          PANEL_MIN_WIDTH.right,
          Math.max(PANEL_MIN_WIDTH.right, available),
        ),
      );
      if (
        action.snapshot.leftVisible &&
        action.snapshot.rightVisible &&
        leftWidth + rightWidth > available
      ) {
        let excess = leftWidth + rightWidth - available;
        const leftReducible =
          leftWidth - PANEL_MIN_WIDTH.left;
        const rightReducible =
          rightWidth - PANEL_MIN_WIDTH.right;
        const totalReducible = leftReducible + rightReducible;
        if (totalReducible > 0) {
          const leftReduction = Math.min(
            leftReducible,
            Math.round((excess * leftReducible) / totalReducible),
          );
          leftWidth -= leftReduction;
          excess -= leftReduction;
          rightWidth = Math.max(
            PANEL_MIN_WIDTH.right,
            rightWidth - excess,
          );
        }
      }
      return {
        ...state,
        leftVisible: action.snapshot.leftVisible,
        rightVisible: action.snapshot.rightVisible,
        leftWidth,
        rightWidth,
        customized: action.snapshot.customized,
        resizingSide: null,
      };
    }

    default:
      return state;
  }
}
