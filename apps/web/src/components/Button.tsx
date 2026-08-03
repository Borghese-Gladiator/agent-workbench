import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

/**
 * The one button primitive for apps/web. `variant` selects the visual treatment; every other
 * native button attribute (type, disabled, onClick, aria-*) passes straight through. Defaults to
 * type="button" so a button inside a form never submits by accident.
 */
export function Button({
  variant = 'secondary',
  type = 'button',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const classes = ['button', `button--${variant}`, className].filter(Boolean).join(' ');
  return <button type={type} className={classes} {...rest} />;
}
