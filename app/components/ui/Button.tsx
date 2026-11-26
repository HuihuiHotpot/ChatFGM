import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import './Button.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = 'secondary', className, type = 'button', ...rest },
    ref,
  ) {
    const classes = ['ui-button', `ui-button--${variant}`, className]
      .filter(Boolean)
      .join(' ');

    return <button {...rest} ref={ref} type={type} className={classes} />;
  },
);

Button.displayName = 'Button';
