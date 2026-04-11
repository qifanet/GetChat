/**
 * @file surfaceFactory.ts
 * @description Factory for creating the appropriate ImperativeTextSurface
 * based on the configured renderer mode.
 *
 * Usage:
 *   const surface = createTextSurface("DOM_TEXT");
 *   surface.mount(containerElement);
 *   // chunks are appended via surface.append(chunk)
 */

import type { StreamRendererMode } from "../../types/base";
import type { ImperativeTextSurface } from "../../types/stream";
import { DomTextSurface } from "./DomTextSurface";
import { PretextSurfaceAdapter } from "./PretextSurfaceAdapter";

/**
 * Create an imperative text surface based on the renderer mode.
 *
 * - PRETEXT: Uses PretextSurfaceAdapter (pretext for measurement + DOM for display)
 * - DOM_TEXT: Uses plain DomTextSurface (reliable fallback)
 *
 * Both implementations bypass React's reconciliation loop.
 * The difference is that PRETEXT mode can measure text height
 * without triggering DOM layout reflow (better for scroll tracking).
 */
export function createTextSurface(mode: StreamRendererMode): ImperativeTextSurface {
  if (mode === "PRETEXT") {
    return new PretextSurfaceAdapter();
  }
  return new DomTextSurface();
}

/**
 * Attach a surface to an existing runtime session.
 * If the session already has a surface, destroy it first.
 * If chunks were accumulated before mounting, immediately flush them.
 *
 * This is the safe way to connect a surface to a running stream.
 */
export function attachSurfaceToSession(
  requestId: string,
  container: HTMLElement,
  mode: StreamRendererMode,
  chunks: string[]
): ImperativeTextSurface {
  const surface = createTextSurface(mode);
  surface.mount(container);

  // If chunks were accumulated before the surface was mounted,
  // immediately display all accumulated text.
  if (chunks.length > 0) {
    surface.replaceAll(chunks.join(""));
  }

  return surface;
}
