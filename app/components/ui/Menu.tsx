import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { forwardRef } from 'react';
import type {
  ComponentProps,
  ComponentPropsWithoutRef,
  ComponentRef,
} from 'react';
import './Menu.css';

export function Menu({
  modal = false,
  ...props
}: ComponentProps<typeof DropdownMenu.Root>) {
  return <DropdownMenu.Root {...props} modal={modal} />;
}

export const MenuTrigger = DropdownMenu.Trigger;

type MenuContentProps = ComponentPropsWithoutRef<typeof DropdownMenu.Content>;

export const MenuContent = forwardRef<
  ComponentRef<typeof DropdownMenu.Content>,
  MenuContentProps
>(function MenuContent(
  {
    className,
    align = 'start',
    side = 'bottom',
    sideOffset = 6,
    collisionPadding = 8,
    ...rest
  },
  ref,
) {
  const classes = ['ui-menu-content', className].filter(Boolean).join(' ');

  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        {...rest}
        ref={ref}
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={classes}
      />
    </DropdownMenu.Portal>
  );
});

MenuContent.displayName = 'MenuContent';

type MenuItemProps = ComponentPropsWithoutRef<typeof DropdownMenu.Item>;

export const MenuItem = forwardRef<
  ComponentRef<typeof DropdownMenu.Item>,
  MenuItemProps
>(function MenuItem({ className, disabled, ...rest }, ref) {
  const classes = ['ui-menu-item', className].filter(Boolean).join(' ');

  return (
    <DropdownMenu.Item
      {...rest}
      ref={ref}
      disabled={disabled}
      aria-disabled={disabled ? true : undefined}
      className={classes}
    />
  );
});

MenuItem.displayName = 'MenuItem';

export const MenuRadioGroup = DropdownMenu.RadioGroup;

type MenuRadioItemProps = ComponentPropsWithoutRef<
  typeof DropdownMenu.RadioItem
>;

export const MenuRadioItem = forwardRef<
  ComponentRef<typeof DropdownMenu.RadioItem>,
  MenuRadioItemProps
>(function MenuRadioItem({ className, ...rest }, ref) {
  const classes = ['ui-menu-item', className]
    .filter(Boolean)
    .join(' ');
  return (
    <DropdownMenu.RadioItem
      {...rest}
      ref={ref}
      className={classes}
    />
  );
});

MenuRadioItem.displayName = 'MenuRadioItem';

export function MenuSeparator() {
  return <DropdownMenu.Separator className="ui-menu-separator" />;
}
