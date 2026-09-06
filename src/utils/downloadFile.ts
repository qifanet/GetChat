/**
 * @file downloadFile.ts
 * @description Save text content to a user-chosen file. Uses the Tauri save
 * dialog + fs plugin on desktop; falls back to a browser anchor download when
 * running in the browser-debug runtime.
 */

import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

/** Trigger a file download with the given content; false when cancelled. */
export async function downloadTextFile(content: string, filename: string): Promise<boolean> {
  const ext = filename.endsWith(".json") ? "json" : filename.endsWith(".html") ? "html" : "md";
  try {
    const filePath = await save({
      defaultPath: filename,
      filters: [{ name: "Documents", extensions: [ext] }],
    });
    if (!filePath) return false;
    const encoder = new TextEncoder();
    await writeFile(filePath, encoder.encode(content));
    return true;
  } catch (err) {
    console.warn("[export] Tauri save failed, falling back to browser download", err);
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
  }
}
