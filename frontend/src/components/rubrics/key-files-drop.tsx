"use client";

import { useState, type DragEvent } from "react";
import { Upload, X } from "lucide-react";
import { DocPreview } from "@/components/preview/doc-preview";
import { cn } from "@/lib/utils";
import { sourceLabel } from "./rubric-utils";
import { MAX_KEY_FILES, PAPER_ACCEPT, type KeySourceFiles } from "./use-rubric-source";

const removeBtn =
  "inline-flex h-8 w-full items-center justify-center gap-1 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-600 transition-colors duration-150 hover:bg-slate-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-50";

/** What a draft used a dropped file as: the answer key, or the paper the key was drafted from. */
export function sourceFileLabel(sources: KeySourceFiles, file: File): string {
  if (file === sources.key) return "Answer key";
  if (file === sources.paper) {
    return sources.role === "question_paper" || sources.role === "marked_copy" ? sourceLabel("paper", sources.role) : "Answer key";
  }
  // Its key was replaced with "Apply answer key from file" in the draft editor.
  return "Replaced";
}

/**
 * One drop zone for the answer key file, the question paper, or both (two at most): a styled
 * label around a hidden file picker that also takes dropped files (the page cancels drops
 * elsewhere so a stray file never navigates away). Each file shows as a small preview with a
 * remove button, labelled by `label` (what the draft used it as).
 */
export function KeyFilesDrop({
  id,
  files,
  note,
  disabled,
  hint,
  label,
  onAdd,
  onRemove,
}: {
  id: string;
  files: File[];
  note?: { kind: "error" | "info"; message: string } | null;
  disabled?: boolean;
  /** The line under the prompt while fewer than two files are in. */
  hint: string;
  label: (file: File) => string;
  onAdd: (files: File[]) => void;
  onRemove: (file: File) => void;
}) {
  const [over, setOver] = useState(false);

  function handleDrag(e: DragEvent<HTMLLabelElement>, active: boolean) {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    if (!active && e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setOver(active && !disabled);
  }

  function handleDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length && !disabled) onAdd(dropped);
  }

  return (
    <div className="space-y-2">
      <label
        onDragEnter={(e) => handleDrag(e, true)}
        onDragOver={(e) => handleDrag(e, true)}
        onDragLeave={(e) => handleDrag(e, false)}
        onDrop={handleDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-3 py-4 text-center transition-colors duration-150",
          "has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-brand-cyan has-[input:focus-visible]:ring-offset-2",
          over ? "border-brand-cyan bg-brand-cyan-50" : "border-slate-300 bg-slate-50 hover:border-brand-cyan",
          disabled && "pointer-events-none opacity-60",
        )}
      >
        <input
          id={id}
          type="file"
          multiple
          accept={PAPER_ACCEPT}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            // Allow picking the same file again after a remove.
            e.target.value = "";
            if (picked.length) onAdd(picked);
          }}
          className="sr-only"
        />
        <Upload className={cn("h-4 w-4", over ? "text-brand-cyan-600" : "text-slate-400")} aria-hidden />
        <span className="text-sm font-medium text-brand-navy">
          {over ? "Drop to add" : "Drop the answer key, the question paper, or both"}
        </span>
        <span className="text-xs text-slate-500">
          or <span className="font-medium text-brand-cyan-600 underline underline-offset-2">browse your files</span>
        </span>
        <span id={`${id}-hint`} className="text-xs text-slate-500">
          {files.length >= MAX_KEY_FILES ? "Two files at most - another one replaces the answer key file." : hint}
        </span>
      </label>
      {note ? (
        <p
          className={cn("text-xs", note.kind === "error" ? "text-rose-700" : "text-slate-600")}
          role={note.kind === "error" ? "alert" : "status"}
        >
          {note.message}
        </p>
      ) : null}
      {files.length ? (
        <ul aria-label="Answer key files" className="flex flex-wrap gap-2">
          {files.map((file) => (
            <li key={`${file.name}:${file.size}`} className="flex w-[138px] flex-col gap-1">
              <DocPreview label={label(file)} source={{ kind: "file", file }} size="sm" />
              <button
                type="button"
                onClick={() => onRemove(file)}
                disabled={disabled}
                className={removeBtn}
                aria-label={`Remove ${file.name}`}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
