import * as React from "react";

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(15,138,132,0.35)] focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 select-none",
  {
    variants: {
      variant: {
        primary:
          "rounded-[8px] bg-[var(--color-ink)] text-[var(--color-paper)] hover:bg-[#1a2c44] active:translate-y-[0.5px]",
        accent:
          "rounded-[8px] bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-strong)] active:translate-y-[0.5px]",
        secondary:
          "rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] text-[var(--color-ink)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper-sunken)]",
        subtle:
          "rounded-[8px] bg-[var(--color-paper-sunken)] text-[var(--color-ink)] hover:bg-[#e6dfcd]",
        ghost:
          "rounded-[8px] text-[var(--color-ink-soft)] hover:bg-[var(--color-paper-sunken)] hover:text-[var(--color-ink)]"
      },
      size: {
        default: "h-10 px-4 text-sm",
        sm: "h-9 px-3 text-[13px]",
        lg: "h-11 px-5 text-sm",
        icon: "h-10 w-10"
      }
    },
    defaultVariants: {
      variant: "secondary",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
