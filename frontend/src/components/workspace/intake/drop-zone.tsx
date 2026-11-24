"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCEPT_ATTR } from "../format";
import { collectFromDrop, collectFromInput, type PickedFile } from "./collect";

interface DropZoneProps {
  mode: "single" | "batch";
  disabled?: boolean;
  /** Single mode: a file is already attached (changes the prompt). */
  hasFile?: boolean;
  error?: boolean;
  maxMb: number;
  /** Health.max_pdf_pages (a full printed paper fits). */
  maxPages?: number;
  /** Health.voice_enabled: list the audio types as accepted (voice answers). */
  voiceEnabled?: boolean;
  hintId?: string;
  onFiles: (files: PickedFile[], meta: { hadFolder: boolean; fromDrop: boolean }) => void;
}

/**
 * Drag-and-drop zone + file pickers. Single mode: one file. Batch mode: several files, a
 * "Choose folder" picker (webkitdirectory) and dropped folders (walked recursively).
 */
export function DropZone({
  mode,
  disabled,
  hasFile,
  error,
  maxMb,
  maxPages,
  voiceEnabled = true,
  hintId,
  onFiles,
}: DropZoneProps) {
  const [dragActive, setDragActive] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const batch = mode === "batch";

  // webkitdirectory is not in React's input typings: set it as a plain attribute.
  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, [batch]);

  function handleDrag(e: DragEvent<HTMLLabelElement>, active: boolean) {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    if (!active && e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(active);
  }

  function handleDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (disabled) return;
    // Entries must be read synchronously, inside the drop event.
    const pending = collectFromDrop(e.dataTransfer);
    setReading(true);
    void pending
      .then(({ files, hadFolder }) => {
        if (files.length) onFiles(files, { hadFolder, fromDrop: true });
      })
      .finally(() => setReading(false));
  }

  const prompt = dragActive
    ? batch
      ? "Drop to stage the files / folder"
      : "Drop to attach the answer sheet"
    : batch
      ? "Drag & drop answer sheets or a whole folder"
      : hasFile
        ? "Drop or click to replace the file"
        : "Drag & drop the answer sheet here";

  return (
    <div className="space-y-2">
      <label
        onDragEnter={(e) => handleDrag(e, true)}
        onDragOver={(e) => handleDrag(e, true)}
        onDragLeave={(e) => handleDrag(e, false)}
        onDrop={handleDrop}
        className={cn(
          "group relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-6 text-center transition-colors duration-150",
          batch ? "min-h-40" : "min-h-44",
          "has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-brand-cyan has-[input:focus-visible]:ring-offset-2",
          dragActive
            ? "border-brand-cyan bg-brand-cyan-50"
            : error
              ? "border-rose-400 bg-white hover:border-rose-500"
              : "border-slate-300 bg-slate-50 hover:border-brand-cyan",
          (disabled || reading) && "pointer-events-none opacity-60",
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple={batch}
          className="sr-only"
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(e) => {
            const files = collectFromInput(e.target.files);
            // Allow re-selecting the same file after a remove or a rejected pick.
            e.target.value = "";
            if (files.length) onFiles(files, { hadFolder: false, fromDrop: false });
          }}
        />
        <Upload className={cn("h-5 w-5", dragActive ? "text-brand-cyan-600" : "text-slate-400")} aria-hidden />
        <span className="space-y-1">
          <span className="block text-[15px] font-medium text-brand-navy">{reading ? "Reading the folder…" : prompt}</span>
          <span className="block text-sm text-slate-500">
            or{" "}
            <span className="font-medium text-brand-cyan-600 underline underline-offset-2">
              {batch ? "choose files" : "browse your files"}
            </span>{" "}
            · PDF, image or Word{voiceEnabled ? " - or a voice answer" : ""}
          </span>
        </span>
        <span
          id={hintId}
          className="text-xs text-slate-500"
          title={voiceEnabled ? "Voice answers: transcribed by OpenAI (not residency-approved, PoC only)" : undefined}
        >
          PDF{maxPages ? ` (up to ${maxPages} pages)` : ""}, JPG, PNG, WEBP, DOCX{voiceEnabled ? ", MP3, WAV, M4A, OGG" : ""}{" "}
          · up to {maxMb} MB each
        </span>
      </label>

      {batch ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            disabled={disabled}
            onChange={(e) => {
              const files = collectFromInput(e.target.files);
              e.target.value = "";
              if (files.length) onFiles(files, { hadFolder: true, fromDrop: false });
            }}
          />
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            disabled={disabled || reading}
            className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-brand-navy transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan focus-visible:ring-offset-1 disabled:opacity-60"
          >
            Choose folder
          </button>
          <span className="text-xs text-slate-500">
            Sub-folders are read too; a file one level down takes its folder&apos;s name as the student name.
          </span>
        </div>
      ) : null}
    </div>
  );
}
