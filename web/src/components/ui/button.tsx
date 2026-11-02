import type { ComponentProps } from "react";
import { Slot } from "radix-ui";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva("vb-button inline-flex items-center justify-center gap-2 text-sm font-semibold", {
  variants: {
    variant: {
      primary: "vb-button-primary",
      secondary: "vb-button-secondary",
      destructive: "vb-button-destructive",
      ghost: "vb-button-ghost",
    },
  },
  defaultVariants: { variant: "primary" },
});

export function Button({ className, variant, asChild = false, type = "button", ...props }:
  ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot.Root : "button";
  return <Component type={type} className={cn(buttonVariants({ variant, className }))} {...props} />;
}
