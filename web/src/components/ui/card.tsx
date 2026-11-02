import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("vb-card", className)} {...props} />;
}
