/**
 * @file ContentBlockRenderer.tsx
 * @description Renders an ordered sequence of ContentBlocks for inline tool display.
 *
 * Each block is rendered in order:
 *   - text blocks → MarkdownRenderer
 *   - tool_call blocks → compact tool card (pending/running)
 *   - tool_result blocks → result summary under the corresponding tool_call
 *
 * This replaces the old pattern of rendering all tool calls at the bottom.
 */

import { memo, Fragment } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ToolCallInlineCard } from "./ToolCallInlineCard";
import type { ContentBlock } from "../../types/stream";

interface ContentBlockRendererProps {
  blocks: ContentBlock[];
}

export const ContentBlockRenderer = memo(function ContentBlockRenderer({
  blocks,
}: ContentBlockRendererProps) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "text") {
          if (!block.content) return null;
          return (
            <MarkdownRenderer
              key={`text-${index}`}
              content={block.content}
            />
          );
        }

        if (block.type === "tool_call") {
          // Find the matching tool_result block that follows
          let resultBlock: Extract<ContentBlock, { type: "tool_result" }> | undefined;
          for (let j = index + 1; j < blocks.length; j++) {
            const next = blocks[j];
            if (next.type === "tool_result" && next.callId === block.callId) {
              resultBlock = next;
              break;
            }
            if (next.type === "tool_call") break;
          }

          const status = resultBlock
            ? resultBlock.success ? "COMPLETED" : "FAILED"
            : "PENDING";

          return (
            <ToolCallInlineCard
              key={`tc-${block.callId}`}
              callId={block.callId}
              functionName={block.functionName}
              argumentsJson={block.args}
              resultJson={resultBlock?.result ?? ""}
              status={status}
            />
          );
        }

        // tool_result blocks are rendered alongside their tool_call above
        // so we skip standalone tool_result blocks
        if (block.type === "tool_result") {
          // Check if this result was already rendered by a preceding tool_call
          const hasMatchingCall = blocks.some(
            (b, i) => i < index && b.type === "tool_call" && b.callId === block.callId
          );
          if (hasMatchingCall) return null;

          // Orphaned result without a preceding tool_call — render as standalone
          return (
            <ToolCallInlineCard
              key={`tr-${block.callId}`}
              callId={block.callId}
              functionName="unknown"
              argumentsJson=""
              resultJson={block.result}
              status={block.success ? "COMPLETED" : "FAILED"}
            />
          );
        }

        // Dual-Queue injection — user message injected at a tool boundary
        if (block.type === "user_injected") {
          return (
            <div
              key={`inject-${index}`}
              className="my-2 px-3 py-2 rounded-md border border-blue-500/30 bg-blue-500/10 text-sm text-blue-300 dark:text-blue-300"
            >
              <span className="font-medium text-blue-400 mr-1.5">▸ Injected:</span>
              {block.content}
            </div>
          );
        }

        return null;
      })}
    </>
  );
});
