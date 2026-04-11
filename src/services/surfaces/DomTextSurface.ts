/**
 * @file DomTextSurface.ts
 * @description Native DOM TextNode-based imperative text surface.
 *
 * This is the reliable fallback implementation of ImperativeTextSurface.
 * It directly manipulates a DOM TextNode to append streaming text,
 * completely bypassing React's reconciliation loop.
 *
 * Why this avoids token-level React re-renders:
 * - React does not track imperative DOM mutations
 * - TextNode.data is modified directly, no setState involved
 * - The containing component only re-renders when the stream session
 *   status changes (COMPLETED/FAILED), not on every chunk
 *
 * Performance characteristics:
 * - append(): O(1) — just concatenates to TextNode.data
 * - replaceAll(): O(n) — replaces entire text content
 * - No layout reflow triggered by text changes (only paint)
 * - Long text (>50k chars) may benefit from chunked rendering
 */

import type { ImperativeTextSurface } from "../../types/stream";

export class DomTextSurface implements ImperativeTextSurface {
  private container: HTMLElement | null = null;
  private textNode: Text | null = null;

  /**
   * Mount the surface into a container DOM element.
   * Clears any existing content in the container.
   */
  mount(container: HTMLElement): void {
    this.destroy();

    this.container = container;
    container.innerHTML = "";

    this.textNode = document.createTextNode("");
    container.appendChild(this.textNode);
  }

  /**
   * Append a chunk of streaming text.
   * Directly modifies TextNode.data — no React state update.
   */
  append(chunk: string): void {
    if (!this.textNode) return;
    this.textNode.data += chunk;
  }

  /**
   * Replace all displayed text with the given content.
   * Used during flush operations to ensure consistency
   * between chunk buffer and displayed text.
   */
  replaceAll(text: string): void {
    if (!this.textNode) return;
    this.textNode.data = text;
  }

  /**
   * Get the current displayed text length.
   * Useful for diagnostics and scroll decisions.
   */
  getLength(): number {
    return this.textNode?.data.length ?? 0;
  }

  /**
   * Clean up: remove the TextNode from the container
   * and release all references.
   */
  destroy(): void {
    if (this.container) {
      this.container.innerHTML = "";
    }
    this.container = null;
    this.textNode = null;
  }
}
