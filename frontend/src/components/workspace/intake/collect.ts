// Collect files from a folder picker, a multi-file picker or a drag-and-drop (including
// dropped folders, walked with the File and Directory Entries API).

export interface PickedFile {
  file: File;
  /** "Folder/Sub/file.pdf" for folder picks and drops; the bare file name otherwise. */
  path: string;
}

/** Hard cap on files read from one pick/drop (keeps the browser responsive). */
const MAX_COLLECTED = 1_000;

function readEntriesOnce(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

async function walk(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  if (out.length >= MAX_COLLECTED) return;
  if (isFileEntry(entry)) {
    try {
      const file = await entryFile(entry);
      out.push({ file, path: entry.fullPath.replace(/^\/+/, "") || file.name });
    } catch {
      // Unreadable entry (permissions, vanished file): skip it silently.
    }
    return;
  }
  if (isDirectoryEntry(entry)) {
    const reader = entry.createReader();
    // readEntries returns the directory in batches (about 100 at a time): loop until empty.
    for (;;) {
      let batch: FileSystemEntry[];
      try {
        batch = await readEntriesOnce(reader);
      } catch {
        return;
      }
      if (batch.length === 0) return;
      for (const child of batch) {
        await walk(child, out);
        if (out.length >= MAX_COLLECTED) return;
      }
    }
  }
}

/**
 * Files from a drop event. webkitGetAsEntry must be called synchronously inside the drop
 * handler (the DataTransfer is emptied afterwards), so call this before any `await`.
 * Returns a promise for the flattened file list and whether a folder was dropped.
 */
export function collectFromDrop(dataTransfer: DataTransfer): Promise<{ files: PickedFile[]; hadFolder: boolean }> {
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) looseFiles.push(file);
    }
  }
  if (entries.length === 0 && looseFiles.length === 0 && dataTransfer.files) {
    looseFiles.push(...Array.from(dataTransfer.files));
  }
  const hadFolder = entries.some((e) => e.isDirectory);

  return (async () => {
    const out: PickedFile[] = looseFiles.map((file) => ({ file, path: file.name }));
    for (const entry of entries) {
      await walk(entry, out);
      if (out.length >= MAX_COLLECTED) break;
    }
    return { files: out.slice(0, MAX_COLLECTED), hadFolder };
  })();
}

/** Files from an <input type="file" multiple> or a webkitdirectory folder picker. */
export function collectFromInput(list: FileList | null): PickedFile[] {
  if (!list) return [];
  return Array.from(list)
    .slice(0, MAX_COLLECTED)
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}
