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
        "flex h-10 w-full items-center justify-between rounded-[8px] border border-zinc-200 bg-white px-3 text-sm text-zinc-900 shadow-sm outline-none transition focus:ring-2 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="h-4 w-4 text-zinc-400" />
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
          "z-50 max-h-80 min-w-[10rem] overflow-hidden rounded-[8px] border border-zinc-200 bg-white p-1 shadow-lg",
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
        "relative flex cursor-default select-none items-center rounded-md py-2 pl-8 pr-3 text-sm text-zinc-700 outline-none data-[highlighted]:bg-zinc-100 data-[highlighted]:text-zinc-950",
        className
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4 text-emerald-600" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
