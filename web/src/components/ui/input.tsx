import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn("vb-field", className)} {...props} />;
}
