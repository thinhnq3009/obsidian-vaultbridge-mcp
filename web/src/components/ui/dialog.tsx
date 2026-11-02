import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "./button.js";

export function Dialog({ trigger, title, description, children }: {
  trigger: ReactNode; title: string; description: string; children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="vb-dialog-overlay" />
        <DialogPrimitive.Content className="vb-dialog">
          <DialogPrimitive.Title className="text-xl font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="vb-muted mt-3 text-sm">{description}</DialogPrimitive.Description>
          <div className="mt-6">{children}</div>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" className="vb-dialog-close" aria-label="Close dialog"><X size={18} aria-hidden="true" /></Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
