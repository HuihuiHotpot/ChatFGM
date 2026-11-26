import * as Dialog from '@radix-ui/react-dialog';
import { useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import './Modal.css';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusTarget?: HTMLElement | null;
  variant?: 'default' | 'compact';
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  className?: string;
  id?: string;
  children?: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  initialFocusRef,
  returnFocusTarget,
  variant = 'default',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  className,
  id,
  children,
  footer,
}: ModalProps) {
  const previouslyOpen = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  if (open && !previouslyOpen.current && typeof document !== 'undefined') {
    const activeElement = document.activeElement;
    const explicitTarget =
      returnFocusTarget?.isConnected ? returnFocusTarget : null;
    returnFocus.current =
      explicitTarget ??
      (activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement.isConnected
        ? activeElement
        : defaultReturnFocus());
  }
  previouslyOpen.current = open;

  function defaultReturnFocus(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.app-menu-button');
  }

  function nextReturnFocus(): HTMLElement | null {
    const target = returnFocus.current;
    if (target?.isConnected) return target;
    return defaultReturnFocus();
  }

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
  }

  function keepFocusInside() {
    window.setTimeout(() => {
      const content = contentRef.current;
      if (!content) return;

      const activeElement = document.activeElement;
      if (activeElement && content.contains(activeElement)) return;

      const target = initialFocusRef?.current ?? content;
      target.focus();
    }, 0);
  }

  const contentClassName = [
    'ui-dialog-content',
    variant === 'compact' ? 'ui-dialog-content--compact' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-dialog-overlay" />
        <Dialog.Content
          ref={contentRef}
          id={id}
          className={contentClassName}
          aria-modal="true"
          onPointerDownOutside={(event) => {
            if (!closeOnOverlayClick) {
              event.preventDefault();
              keepFocusInside();
            }
          }}
          onEscapeKeyDown={(event) => {
            if (!closeOnEscape) {
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => {
            if (initialFocusRef?.current) {
              event.preventDefault();
              initialFocusRef.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            const target = nextReturnFocus();
            if (target) {
              event.preventDefault();
              window.setTimeout(() => {
                if (target.isConnected) target.focus();
                if (returnFocus.current === target) {
                  returnFocus.current = null;
                }
              }, 0);
            }
          }}
        >
          <Dialog.Title className="ui-dialog-title">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="ui-dialog-description">
              {description}
            </Dialog.Description>
          ) : null}
          {children}
          {footer ? <div className="ui-dialog-footer">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
