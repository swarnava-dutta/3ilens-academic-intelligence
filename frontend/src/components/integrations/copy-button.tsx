"use client";

import { useState } from "react";
import { btnQuiet } from "@/components/owner/states";
import { cn } from "@/lib/utils";

/** Copies `text` to the clipboard; the button says "Copied" for 2 s. Never logs the text. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <button type="button" onClick={() => void copy()} className={cn(btnQuiet, "h-10 shrink-0 px-2 text-xs sm:h-7", className)}>
      <span aria-live="polite">{copied ? "Copied" : failed ? "Copy failed - select and copy" : label}</span>
    </button>
  );
}
