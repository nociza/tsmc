import type { HTMLAttributes } from "react";

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]",
  {
    variants: {
      tone: {
        neutral: "border-zinc-200 bg-zinc-100 text-zinc-600",
        success: "border-emerald-200 bg-emerald-50 text-emerald-700",
        warning: "border-amber-200 bg-amber-50 text-amber-700",
        danger: "border-rose-200 bg-rose-50 text-rose-700",
        info: "border-cyan-200 bg-cyan-50 text-cyan-700"
      }
    },
    defaultVariants: {
      tone: "neutral"
    }
  }
);

type BadgeProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ tone }), className)} {...props} />;
}
