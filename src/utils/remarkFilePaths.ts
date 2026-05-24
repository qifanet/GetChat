/**
 * @file remarkFilePaths.ts
 * @description Remark plugin that detects file path patterns in text nodes
 *              and converts them to clickable links for file preview.
 *
 * Detected patterns:
 *   - Relative paths: ./path, ../path, path/to/file.ext
 *   - Common source paths: src/..., lib/..., app/..., components/...
 *   - Absolute paths (Windows): C:\path, D:\path
 *   - Absolute paths (Unix): /home/..., /usr/..., /var/...
 *   - Paths with line references: path/to/file.ext:42 or file.ext:10-20
 *
 * The plugin wraps matched paths in link nodes with a "file://" scheme prefix.
 * The MarkdownRenderer components then intercept these links for in-app preview.
 */

import type { Plugin } from "unified";
import type { Root, Text, Link, Parent } from "mdast";

// Patterns that look like file paths (but aren't inside markdown links or code)
// We need to be careful not to match URLs, email addresses, or code content.

/**
 * File path pattern regex parts:
 * 1. Relative paths with dot prefix: ./ or ../
 * 2. Common source directories: src/, lib/, app/, components/, etc.
 * 3. Filename with extension: word chars + dot + 2-10 char extension
 * 4. Optional line reference: :number or :number-number
 */
const FILE_PATH_PATTERN = new RegExp(
  "(?:" +
    // Group 1: Relative paths
    "(?:\\.\\.?/)+" +
    "[\\w./-]+" +
    "|" +
    // Group 2: Common source directory prefixes
    "(?:" +
    [
      "src", "lib", "app", "pkg", "cmd", "internal", "components",
      "pages", "hooks", "utils", "services", "types", "styles",
      "public", "assets", "config", "scripts", "docs", "test", "tests",
      "spec", "specs", "mock", "mocks", "fixture", "fixtures",
    ].join("|") +
    ")/" +
    "[\\w./-]+" +
    "|" +
    // Group 3: Filenames with common extensions (at least one path segment)
    "[\\w.-]+/" +
    "[\\w./-]+" +
    "\\.[a-zA-Z]{1,10}" +
    "|" +
    // Group 4: Windows absolute paths
    "[A-Za-z]:\\\\[\\\\\\w./\\-]+" +
    "|" +
    // Group 5: Unix-style paths (must have at least 2 segments)
    "/(?:home|usr|var|etc|opt|tmp|Users)/[\\w./\\-]+" +
    ")" +
    // Optional line reference: :42 or :10-20
    "(?::\\d+(?:-\\d+)?)" +
    "?",
  "g"
);

/** Custom link protocol for file paths detected in markdown content. */
export const FILE_LINK_PROTOCOL = "file-preview:";

/**
 * Check if a text node is inside a code block or inline code.
 */
function isInsideCode(node: Text, ancestors: Parent[]): boolean {
  for (const ancestor of ancestors) {
    if (ancestor.type === "code" || ancestor.type === "inlineCode") {
      return true;
    }
    // Also skip links — don't re-wrap paths that are already links
    if (ancestor.type === "link") {
      return true;
    }
  }
  return false;
}

/**
 * Split a text node into segments, replacing file path matches with link nodes.
 */
function splitTextByFilePaths(text: string): Array<Text | Link> {
  const segments: Array<Text | Link> = [];

  // Reset lastIndex for global regex
  FILE_PATH_PATTERN.lastIndex = 0;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
    const matchedPath = match[0];
    const startIndex = match.index;

    // Leading text before the match
    if (startIndex > lastIndex) {
      segments.push({
        type: "text",
        value: text.slice(lastIndex, startIndex),
      });
    }

    // Create a link node for the file path
    segments.push({
      type: "link",
      url: FILE_LINK_PROTOCOL + matchedPath,
      title: null,
      children: [
        {
          type: "text",
          value: matchedPath,
        },
      ],
    });

    lastIndex = startIndex + matchedPath.length;
  }

  // Trailing text after last match
  if (lastIndex < text.length) {
    segments.push({
      type: "text",
      value: text.slice(lastIndex),
    });
  }

  return segments;
}

/**
 * Walk the mdast tree and replace text nodes containing file paths.
 */
function visitTextNodes(
  node: Root | Parent,
  ancestors: Parent[] = [],
): void {
  const children = node.children;
  if (!children) return;

  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];

    if (child.type === "text") {
      const textChild = child as Text;

      // Skip text inside code blocks, inline code, or existing links
      if (isInsideCode(textChild, ancestors)) {
        continue;
      }

      // Check if the text contains any file path patterns
      FILE_PATH_PATTERN.lastIndex = 0;
      if (!FILE_PATH_PATTERN.test(textChild.value)) {
        continue;
      }

      // Split the text node into segments with file links
      const segments = splitTextByFilePaths(textChild.value);
      if (segments.length > 1) {
        // Replace the single text node with the segments
        children.splice(i, 1, ...segments);
      }
    } else if ("children" in child && child.children) {
      // Recurse into child nodes
      visitTextNodes(child as Parent, [...ancestors, node as Parent]);
    }
  }
}

/**
 * Remark plugin that detects file path patterns in text and wraps them
 * in link nodes with a custom protocol for in-app file preview.
 */
export const remarkFilePaths: Plugin<[], Root> = function () {
  return (tree: Root) => {
    visitTextNodes(tree, []);
  };
};

/**
 * Extract the file path and optional line reference from a file-preview URL.
 *
 * @returns { path: string, line?: number, lineEnd?: number } or null if not a file link.
 */
export function parseFileLinkUrl(
  href: string,
): { path: string; line?: number; lineEnd?: number } | null {
  if (!href.startsWith(FILE_LINK_PROTOCOL)) return null;

  const raw = href.slice(FILE_LINK_PROTOCOL.length);

  // Check for line reference suffix: :42 or :10-20
  const lineMatch = raw.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (lineMatch) {
    return {
      path: lineMatch[1],
      line: parseInt(lineMatch[2], 10),
      lineEnd: lineMatch[3] ? parseInt(lineMatch[3], 10) : undefined,
    };
  }

  return { path: raw };
}
