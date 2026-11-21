"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { CloudUpload, FolderOpen, Mic } from "lucide-react";
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
  /** Health.voice_enabled: list the audio types as accepted (voice answers). */
  voiceEnabled?: boolean;
  hintId?: string;
  onFiles: (files: PickedFile[], meta: { hadFolder: boolean; fromDrop: boolean }) => void;
}

/**
 * Drag-and-drop zone + file pickers. Single mode: one file. Batch mode: several files, a
 * "Choose folder" picker (webkitdirectory) and dropped folders (walked recursively).
 */
export function DropZone({ mode, disabled, hasFile, error, maxMb, voiceEnabled = true, hintId, onFiles }: DropZoneProps) {
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
          "group relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-all",
          batch ? "min-h-48" : "min-h-56",
          "has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-brand-cyan has-[input:focus-visible]:ring-offset-2",
          dragActive
            ? "scale-[1.01] border-brand-cyan bg-brand-cyan-50"
            : error
              ? "border-rose-300 bg-rose-50/40 hover:border-rose-400"
              : "border-slate-300 bg-slate-50/60 hover:border-brand-cyan hover:bg-brand-cyan-50/50",
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
        <span
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-2xl shadow-sm ring-1 transition-colors",
            dragActive
              ? "bg-brand-cyan text-white ring-brand-cyan"
              : "bg-white text-brand-cyan ring-slate-200 group-hover:ring-brand-cyan/40",
          )}
        >
          <CloudUpload className="h-7 w-7" aria-hidden />
        </span>
        <span className="space-y-1">
          <span className="block text-base font-semibold text-brand-navy">{reading ? "Reading the folder…" : prompt}</span>
          <span className="block text-sm text-slate-500">
            or{" "}
            <span className="font-medium text-brand-cyan underline-offset-2 group-hover:underline">
              {batch ? "choose files" : "browse your files"}
            </span>{" "}
            · PDF, image or Word{voiceEnabled ? " - or a voice answer" : ""}
          </span>
        </span>
        <span id={hintId} className="flex flex-wrap justify-center gap-1.5">
          {["PDF", "JPG", "PNG", "WEBP", "DOCX"].map((t) => (
            <span
              key={t}
              className="rounded-md bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-inset ring-slate-200"
            >
              {t}
            </span>
          ))}
          {voiceEnabled ? (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800 ring-1 ring-inset ring-violet-200"
              title="Voice answers: transcribed by OpenAI (not residency-approved, PoC only)"
            >
              <Mic className="h-3 w-3" aria-hidden />
              MP3 · WAV · M4A · OGG
            </span>
          ) : null}
          <span className="rounded-md bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-inset ring-slate-200">
            ≤ {maxMb} MB each
          </span>
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
            className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-sm font-medium text-brand-navy ring-1 ring-inset ring-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cyan disabled:opacity-60"
          >
            <FolderOpen className="h-4 w-4 text-brand-cyan" aria-hidden />
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
