import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './IconButton.css';

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  compact?: boolean;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      compact = false,
      className,
      type = 'button',
      title,
      children,
      ...rest
    },
    ref,
  ) {
    const classes = [
      'icon-button',
      compact ? 'icon-button--compact' : null,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        {...rest}
        ref={ref}
        type={type}
        className={classes}
        aria-label={label}
        title={title ?? label}
      >
        {children}
      </button>
    );
  },
);

IconButton.displayName = 'IconButton';
