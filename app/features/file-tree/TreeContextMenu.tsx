import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import './TreeContextMenu.css';

export interface TreeMenuEntry {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: false;
}

export interface TreeMenuSeparator {
  separator: true;
}

export type TreeMenuNode = TreeMenuEntry | TreeMenuSeparator;

export interface TreeContextMenuProps {
  x: number;
  y: number;
  items: readonly TreeMenuNode[];
  onClose: (restoreFocus: boolean) => void;
}

export function TreeContextMenu({
  x,
  y,
  items,
  onClose,
}: TreeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [positioned, setPositioned] = useState(false);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(x, window.innerWidth - rect.width - 8),
    );
    const top = Math.max(
      8,
      Math.min(y, window.innerHeight - rect.height - 8),
    );
    setPosition({ left, top });
    setPositioned(true);
    const focusTimer = window.setTimeout(() => {
      menu
        .querySelector<HTMLButtonElement>(
          '.tree-menu-item:not(:disabled)',
        )
        ?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [x, y]);

  useEffect(() => {
    const openedAt = Date.now();

    function handlePointerDown(event: PointerEvent) {
      const menu = menuRef.current;
      if (menu?.contains(event.target as Node)) return;
      onClose(false);
    }

    function handleScroll(event: Event) {
      if (Date.now() - openedAt < 240) return;
      const menu = menuRef.current;
      if (menu?.contains(event.target as Node)) return;
      onClose(false);
    }

    function handleResize() {
      onClose(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [onClose]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '.tree-menu-item:not(:disabled)',
      ) ?? [],
    );
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === 'Tab') {
      onClose(false);
      return;
    }
    if (event.key !== 'ArrowDown'
      && event.key !== 'ArrowUp'
      && event.key !== 'Home'
      && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    if (buttons.length === 0) return;
    const currentIndex = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let nextIndex = 0;
    if (event.key === 'ArrowDown') {
      nextIndex =
        currentIndex === -1 ? 0 : (currentIndex + 1) % buttons.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex =
        currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1;
    } else if (event.key === 'End') {
      nextIndex = buttons.length - 1;
    }
    buttons[nextIndex]?.focus();
  }

  return createPortal(
    <div
      ref={menuRef}
      className="tree-menu"
      role="menu"
      aria-label="文件操作"
      style={{
        left: position.left,
        top: position.top,
        visibility: positioned ? 'visible' : 'hidden',
      }}
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) =>
        'separator' in item ? (
          <div
            className="tree-menu-sep"
            role="separator"
            key={`separator-${index}`}
          />
        ) : (
          <button
            type="button"
            className={`tree-menu-item${
              item.danger ? ' tree-menu-item--danger' : ''
            }`}
            role="menuitem"
            disabled={item.disabled}
            key={`${item.label}-${index}`}
            onClick={() => {
              onClose(true);
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
