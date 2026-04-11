/**
 * @file PretextSurfaceAdapter.ts
 * @description Adapter that integrates @chenglou/pretext for efficient
 * text measurement during streaming, while using DOM for actual text display.
 *
 * WHAT PRETEXT ACTUALLY IS:
 *   @chenglou/pretext is a text measurement and layout library.
 *   Core API:
 *     prepare(text, font) → PreparedText        (one-time measurement)
 *     layout(prepared, maxWidth, lineHeight) → { height, lineCount }
 *
 *   It does NOT provide a streaming text surface or DOM rendering.
 *   Its value is: measuring text height WITHOUT triggering DOM reflow.
 *
 * HOW THIS ADAPTER USES IT:
 *   - Text display: still uses DOM TextNode (same as DomTextSurface)
 *   - Text measurement: uses pretext.prepare() + layout() to compute
 *     accurate height without forcing browser layout
 *   - This enables: scroll position tracking, virtual scrolling hints,
 *     and height-based decisions without expensive getBoundingClientRect()
 *
 * WHY STREAMING PHASE SHOULD NOT DO MARKDOWN PARSE:
 *   1. Markdown structures are often incomplete mid-stream
 *      (unclosed code blocks, broken tables, split list items)
 *   2. Re-parsing on every chunk would cause visible flickering
 *   3. Syntax highlighting on incomplete code is visually jarring
 *   4. The correct approach: plain text during stream → MarkdownRenderer after completion
 *
 * INTEGRATION STATUS:
 *   - TODO: Install @chenglou/pretext as dependency
 *   - TODO: Configure font and lineHeight to match CSS
 *   - The measurement methods are optional enhancements, not required for v1
 */

import type { ImperativeTextSurface } from "../../types/stream";

export class PretextSurfaceAdapter implements ImperativeTextSurface {
  private container: HTMLElement | null = null;
  private textNode: Text | null = null;

  /**
   * Font string matching the CSS font declaration.
   * Must be kept in sync with the message bubble's CSS font.
   * Format: same as canvas context font, e.g., "16px Manrope"
   *
   * TODO: Read from CSS custom property or configuration.
   */
  private readonly font: string;

  /**
   * Line height in pixels, matching the CSS line-height.
   *
   * TODO: Read from CSS or configuration.
   */
  private readonly lineHeight: number;

  /** Max width for text layout measurement */
  private maxWidth: number;

  constructor(options?: { font?: string; lineHeight?: number; maxWidth?: number }) {
    this.font =
      options?.font ?? '16px "Manrope", "Noto Sans SC", "Segoe UI", sans-serif';
    this.lineHeight = options?.lineHeight ?? 24;
    this.maxWidth = options?.maxWidth ?? 720;
  }

  /**
   * Mount the surface into a container DOM element.
   * Clears any existing content and creates a TextNode for display.
   */
  mount(container: HTMLElement): void {
    this.destroy();

    this.container = container;
    container.innerHTML = "";

    this.textNode = document.createTextNode("");
    container.appendChild(this.textNode);

    // Read actual container width for measurement
    this.maxWidth = container.clientWidth || this.maxWidth;
  }

  /**
   * Append a chunk of streaming text.
   * Updates the DOM TextNode directly (bypasses React).
   */
  append(chunk: string): void {
    if (!this.textNode) return;
    this.textNode.data += chunk;
  }

  /**
   * Replace all displayed text with the given content.
   * Used during flush operations.
   */
  replaceAll(text: string): void {
    if (!this.textNode) return;
    this.textNode.data = text;
  }

  /**
   * Measure the current text height using pretext.
   *
   * This is the key advantage over DomTextSurface:
   * it computes height WITHOUT forcing a DOM layout reflow.
   *
   * TODO: Uncomment when @chenglou/pretext is installed.
   *
   * Usage:
   *   import { prepare, layout } from "@chenglou/pretext";
   *   const prepared = prepare(text, this.font);
   *   const { height } = layout(prepared, this.maxWidth, this.lineHeight);
   *   return height;
   */
  measureHeight(): number {
    if (!this.textNode) return 0;

    const text = this.textNode.data;
    if (text.length === 0) return 0;

    // TODO: Replace with actual pretext measurement:
    // import { prepare, layout } from "@chenglou/pretext";
    // const prepared = prepare(text, this.font);
    // const { height } = layout(prepared, this.maxWidth, this.lineHeight);
    // return height;

    // Fallback: rough estimate based on character count and max width
    const charsPerLine = Math.max(1, Math.floor(this.maxWidth / 8));
    const estimatedLines = Math.ceil(text.length / charsPerLine);
    return estimatedLines * this.lineHeight;
  }

  /**
   * Get the number of estimated lines for the current text.
   * Useful for scroll position calculations.
   */
  estimateLineCount(): number {
    if (!this.textNode) return 0;
    const height = this.measureHeight();
    return Math.ceil(height / this.lineHeight);
  }

  /**
   * Clean up: remove DOM nodes and release references.
   */
  destroy(): void {
    if (this.container) {
      this.container.innerHTML = "";
    }
    this.container = null;
    this.textNode = null;
  }
}
