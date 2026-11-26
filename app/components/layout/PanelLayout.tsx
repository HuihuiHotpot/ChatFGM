import { useEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode } from 'react';
import {
  PANEL_MIN_WIDTH,
  maxPanelWidth,
} from '../../state/layout';
import type {
  LayoutAction,
  LayoutState,
  PanelSide,
} from '../../state/layout';
import { Splitter } from './Splitter';
import './PanelLayout.css';

export interface PanelLayoutProps {
  layout: LayoutState;
  dispatch: Dispatch<LayoutAction>;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}

/**
 * Drag width lives in PanelLayout, not App. The four content panels are passed
 * in as stable React elements, so a drag frame re-renders only this layout
 * component instead of the whole workspace tree. The committed width is sent
 * back to App on pointer up/cancel (and immediately for keyboard steps).
 */
export function PanelLayout({
  layout,
  dispatch,
  left,
  center,
  right,
}: PanelLayoutProps) {
  const { leftVisible, rightVisible } = layout;
  const [dragWidth, setDragWidth] = useState<{
    side: PanelSide;
    width: number;
  } | null>(null);
  const dragRef = useRef<{ side: PanelSide; width: number } | null>(null);
  const pendingRef = useRef<{ side: PanelSide; width: number } | null>(null);
  const frameRef = useRef(0);
  const mountedRef = useRef(true);
  /** Last local width per side, kept if the panel is hidden mid-drag. */
  const lastDragWidthRef = useRef<{
    left: number | null;
    right: number | null;
  }>({ left: null, right: null });
  const previousVisibleRef = useRef({
    left: leftVisible,
    right: rightVisible,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      pendingRef.current = null;
      dragRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Closing a panel mid-drag clears the transient drag state; keep its last
    // width so re-showing the panel restores what the user saw.
    const previous = previousVisibleRef.current;
    for (const side of ['left', 'right'] as const) {
      const visible = side === 'left' ? leftVisible : rightVisible;
      if (!previous[side] && visible) {
        const width = lastDragWidthRef.current[side];
        if (width !== null) {
          dispatch({ type: 'set-width', side, width });
          lastDragWidthRef.current[side] = null;
        }
      }
    }
    previousVisibleRef.current = {
      left: leftVisible,
      right: rightVisible,
    };
  }, [leftVisible, rightVisible, dispatch]);

  useEffect(() => {
    // A viewport/reset/restore outside this drag invalidates the local width.
    if (layout.resizingSide !== null) return;
    dragRef.current = null;
    pendingRef.current = null;
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    setDragWidth((current) => (current === null ? current : null));
  }, [layout.resizingSide]);

  useEffect(() => {
    document.body.classList.toggle(
      'is-resizing',
      layout.resizingSide !== null,
    );
    return () => {
      document.body.classList.remove('is-resizing');
    };
  }, [layout.resizingSide]);

  function committedWidth(side: PanelSide): number {
    return side === 'left' ? layout.leftWidth : layout.rightWidth;
  }

  function displayWidth(side: PanelSide): number {
    const local = dragWidth;
    return local?.side === side ? local.width : committedWidth(side);
  }

  function clampWidth(side: PanelSide, width: number): number {
    return Math.round(
      Math.min(
        Math.max(width, PANEL_MIN_WIDTH[side]),
        Math.max(PANEL_MIN_WIDTH[side], maxPanelWidth(layout, side)),
      ),
    );
  }

  function queueLocalWidth(side: PanelSide, width: number): void {
    pendingRef.current = { side, width };
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (!pending || !mountedRef.current) return;
      setDragWidth(pending);
    });
  }

  function handleStart(side: PanelSide): void {
    const width = clampWidth(side, committedWidth(side));
    dragRef.current = { side, width };
    lastDragWidthRef.current[side] = width;
    pendingRef.current = null;
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    setDragWidth({ side, width });
    dispatch({ type: 'start-resize', side });
  }

  function handleWidthChange(side: PanelSide, width: number): void {
    const next = clampWidth(side, width);
    if (dragRef.current?.side === side) {
      dragRef.current.width = next;
      lastDragWidthRef.current[side] = next;
      queueLocalWidth(side, next);
      return;
    }
    // Keyboard adjustment has no drag lifecycle: commit it immediately.
    lastDragWidthRef.current[side] = null;
    dispatch({ type: 'set-width', side, width: next });
  }

  function handleEnd(side: PanelSide): void {
    const pending = pendingRef.current;
    const active = dragRef.current;
    dragRef.current = null;
    pendingRef.current = null;
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    const finalWidth =
      pending?.side === side
        ? pending.width
        : active?.side === side
          ? active.width
          : lastDragWidthRef.current[side] ??
            committedWidth(side);
    setDragWidth((current) =>
      current?.side === side ? null : current,
    );
    dispatch({
      type: 'set-width',
      side,
      width: clampWidth(side, finalWidth),
    });
    dispatch({ type: 'end-resize' });
    lastDragWidthRef.current[side] = null;
  }

  const columns = [
    leftVisible ? `${displayWidth('left')}px` : null,
    leftVisible ? '1px' : null,
    'minmax(0, 1fr)',
    rightVisible ? '1px' : null,
    rightVisible ? `${displayWidth('right')}px` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="app-body" style={{ gridTemplateColumns: columns }}>
      {leftVisible ? left : null}
      {leftVisible ? (
        <Splitter
          side="left"
          width={displayWidth('left')}
          minWidth={PANEL_MIN_WIDTH.left}
          maxWidth={maxPanelWidth(layout, 'left')}
          active={layout.resizingSide === 'left'}
          onStart={() => handleStart('left')}
          onEnd={() => handleEnd('left')}
          onWidthChange={(width) => handleWidthChange('left', width)}
          onReset={() => {
            setDragWidth(null);
            lastDragWidthRef.current.left = null;
            dispatch({ type: 'reset-width', side: 'left' });
          }}
        />
      ) : null}
      {center}
      {rightVisible ? (
        <Splitter
          side="right"
          width={displayWidth('right')}
          minWidth={PANEL_MIN_WIDTH.right}
          maxWidth={maxPanelWidth(layout, 'right')}
          active={layout.resizingSide === 'right'}
          onStart={() => handleStart('right')}
          onEnd={() => handleEnd('right')}
          onWidthChange={(width) => handleWidthChange('right', width)}
          onReset={() => {
            setDragWidth(null);
            lastDragWidthRef.current.right = null;
            dispatch({ type: 'reset-width', side: 'right' });
          }}
        />
      ) : null}
      {rightVisible ? right : null}
    </div>
  );
}
