import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

export function Alert({ className, role = "status", ...props }: ComponentProps<"div">) {
  return <div role={role} className={cn("vb-status flex items-start gap-2 text-xs", className)} {...props} />;
}
