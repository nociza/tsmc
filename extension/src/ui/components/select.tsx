import * as React from "react";

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "../lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex h-10 w-full items-center justify-between rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 text-sm text-[var(--color-ink)] outline-none transition hover:border-[var(--color-line-strong)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[rgba(15,138,132,0.15)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="h-4 w-4 text-[var(--color-ink-subtle)]" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          "z-50 max-h-80 min-w-[10rem] overflow-hidden rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-1 shadow-[0_14px_40px_-20px_rgba(15,27,44,0.2)]",
          className
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center rounded-md py-2 pl-8 pr-3 text-sm text-[var(--color-ink-soft)] outline-none data-[highlighted]:bg-[var(--color-paper-sunken)] data-[highlighted]:text-[var(--color-ink)]",
        className
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4 text-[var(--color-accent)]" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
