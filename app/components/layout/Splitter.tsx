import { useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { PanelSide } from '../../state/layout';

const KEY_STEP = 16;

export interface SplitterProps {
  side: PanelSide;
  width: number;
  minWidth: number;
  maxWidth: number;
  active: boolean;
  onStart: () => void;
  onEnd: () => void;
  onWidthChange: (width: number) => void;
  onReset: () => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

export function Splitter({
  side,
  width,
  minWidth,
  maxWidth,
  active,
  onStart,
  onEnd,
  onWidthChange,
  onReset,
}: SplitterProps) {
  const dragRef = useRef<DragState | null>(null);
  const label = side === 'left' ? '调整项目区宽度' : '调整对话区宽度';
  const controlsId = side === 'left' ? 'projects-panel' : 'chat-panel';

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
    onStart();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const delta = event.clientX - drag.startX;
    const nextWidth =
      side === 'left' ? drag.startWidth + delta : drag.startWidth - delta;
    onWidthChange(nextWidth);
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onEnd();
  }

  function handleLostPointerCapture(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    onEnd();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    const step = (event.shiftKey ? 4 : 1) * KEY_STEP;
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    const nextWidth =
      side === 'left'
        ? width + direction * step
        : width - direction * step;

    onWidthChange(nextWidth);
  }

  return (
    <div
      className={`splitter${active ? ' is-active' : ''}`}
      data-splitter={side}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controlsId}
      aria-valuemin={minWidth}
      aria-valuemax={Math.max(minWidth, Math.round(maxWidth))}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={handleLostPointerCapture}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
    />
  );
}
