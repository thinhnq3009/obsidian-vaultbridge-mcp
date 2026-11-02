import type { ComponentProps } from "react";
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Alert } from "./ui/alert.js";
import { cn } from "../lib/utils.js";

export { Dialog as VBDialog } from "./ui/dialog.js";
export { Label as VBLabel } from "./ui/label.js";

export function VBButton({ loading = false, disabled, children, ...props }:
  ComponentProps<typeof Button> & { loading?: boolean }) {
  return <Button disabled={disabled || loading} aria-busy={loading} {...props}>
    {loading && <LoaderCircle size={18} className="vb-spinner" aria-hidden="true" />}
    {children}
  </Button>;
}

export const VBInput = Input;

export function VBCard({ glass = false, className, ...props }: ComponentProps<typeof Card> & { glass?: boolean }) {
  return <Card className={cn(glass && "vb-auth-panel", className)} {...props} />;
}

export function VBStatus({ tone = "info", className, children, ...props }:
  ComponentProps<typeof Alert> & { tone?: "info" | "success" | "warning" | "danger" }) {
  const Icon = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert }[tone];
  return <Alert className={cn(`vb-status-${tone}`, className)} role={tone === "danger" ? "alert" : "status"} {...props}>
    <Icon size={16} className="shrink-0" aria-hidden="true" /><span>{children}</span>
  </Alert>;
}
