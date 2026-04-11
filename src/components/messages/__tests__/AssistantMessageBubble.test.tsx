/**
 * @file AssistantMessageBubble.test.tsx
 * @description Tests for the assistant message bubble's mode switching.
 *
 * Product rules tested:
 *   - STREAMING status → renders StreamingAssistantContent (NOT MarkdownRenderer)
 *   - COMPLETED status → renders MarkdownRenderer (NOT StreamingAssistantContent)
 *   - FAILED status → renders MarkdownRenderer + error banner + retry guidance
 *   - ABORTED status → renders MarkdownRenderer + "stopped" label
 *   - Streaming and Markdown NEVER coexist
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MessageNode } from "../../../types/conversation";
import type { StreamingMessageState } from "../../../hooks/useStreamingMessage";

// ============================================================================
// Mocks
// ============================================================================

// Use vi.fn() for the hook — configure return value per test
vi.mock("../../../hooks/useStreamingMessage", () => ({
  useStreamingMessage: vi.fn(),
}));

vi.mock("../StreamingAssistantContent", () => ({
  StreamingAssistantContent: ({ requestId }: { requestId: string }) => (
    <div data-testid="streaming-content" data-request-id={requestId} />
  ),
}));

vi.mock("../MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

// Import after mocks are set up
import { useStreamingMessage } from "../../../hooks/useStreamingMessage";
import { AssistantMessageBubble } from "../AssistantMessageBubble";

// ============================================================================
// Helpers
// ============================================================================

function createAssistantMessage(
  overrides: Partial<MessageNode> = {}
): MessageNode {
  return {
    id: "msg_1",
    conversationId: "conv_1",
    role: "ASSISTANT",
    status: "COMPLETED",
    parentId: null,
    childIds: [],
    depth: 0,
    content: { text: "Hello world!", format: "MARKDOWN" },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

const defaultStreamingReturn: StreamingMessageState = {
  isStreaming: false,
  requestId: null,
  rendererMode: "DOM_TEXT",
  streamStatus: null,
  visibleCharCount: 0,
};

// ============================================================================
// Tests
// ============================================================================

describe("AssistantMessageBubble", () => {
  beforeEach(() => {
    vi.mocked(useStreamingMessage).mockReturnValue(defaultStreamingReturn);
  });

  it("renders MarkdownRenderer for COMPLETED messages", () => {
    const message = createAssistantMessage({ status: "COMPLETED" });
    render(<AssistantMessageBubble message={message} />);

    expect(screen.getByTestId("markdown-renderer")).toBeInTheDocument();
    expect(screen.getByTestId("markdown-renderer")).toHaveTextContent("Hello world!");
    expect(screen.queryByTestId("streaming-content")).not.toBeInTheDocument();
  });

  it("renders StreamingAssistantContent for STREAMING messages", () => {
    vi.mocked(useStreamingMessage).mockReturnValue({
      isStreaming: true,
      requestId: "req_123",
      rendererMode: "DOM_TEXT",
      streamStatus: "STREAMING",
      visibleCharCount: 50,
    });

    const message = createAssistantMessage({
      status: "STREAMING",
      generation: {
        providerId: "prov_1",
        modelId: "model_1",
        requestId: "req_123",
      },
    });

    render(<AssistantMessageBubble message={message} />);

    expect(screen.getByTestId("streaming-content")).toBeInTheDocument();
    expect(screen.getByTestId("streaming-content")).toHaveAttribute(
      "data-request-id",
      "req_123"
    );
    // MarkdownRenderer must NOT be rendered simultaneously
    expect(screen.queryByTestId("markdown-renderer")).not.toBeInTheDocument();
  });

  it("renders retry guidance for FAILED messages with retriable error", () => {
    const message = createAssistantMessage({
      status: "FAILED",
      content: { text: "Partial response", format: "MARKDOWN" },
      error: {
        code: "TIMEOUT",
        message: "Request timed out",
        retriable: true,
      },
    });

    render(<AssistantMessageBubble message={message} />);

    expect(screen.getByTestId("markdown-renderer")).toBeInTheDocument();
    expect(screen.getByText(/message\.generationFailed/)).toBeInTheDocument();
    expect(screen.getByText("message.generationRetryHint")).toBeInTheDocument();
  });

  it("does not show retry guidance for non-retriable errors", () => {
    const message = createAssistantMessage({
      status: "FAILED",
      content: { text: "", format: "MARKDOWN" },
      error: {
        code: "AUTH",
        message: "Invalid API key",
        retriable: false,
      },
    });

    render(<AssistantMessageBubble message={message} />);

    expect(screen.getByText(/message\.generationFailed/)).toBeInTheDocument();
    expect(screen.queryByText("message.generationRetryHint")).not.toBeInTheDocument();
  });

  it("renders 'stopped' label for ABORTED messages", () => {
    const message = createAssistantMessage({
      status: "ABORTED",
      content: { text: "Some partial text", format: "MARKDOWN" },
    });

    render(<AssistantMessageBubble message={message} />);

    expect(screen.getByTestId("markdown-renderer")).toBeInTheDocument();
    expect(screen.getByText("message.generationStopped")).toBeInTheDocument();
  });

  it("streaming and markdown NEVER coexist (design constraint)", () => {
    // STREAMING case: only streaming, no markdown
    vi.mocked(useStreamingMessage).mockReturnValue({
      isStreaming: true,
      requestId: "req_1",
      rendererMode: "DOM_TEXT",
      streamStatus: "STREAMING",
      visibleCharCount: 0,
    });

    const streamingMsg = createAssistantMessage({
      status: "STREAMING",
      generation: { providerId: "p", modelId: "m", requestId: "req_1" },
    });

    const { unmount } = render(<AssistantMessageBubble message={streamingMsg} />);
    expect(screen.getByTestId("streaming-content")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-renderer")).not.toBeInTheDocument();
    unmount();

    // COMPLETED case: only markdown, no streaming
    vi.mocked(useStreamingMessage).mockReturnValue(defaultStreamingReturn);

    const completedMsg = createAssistantMessage({ status: "COMPLETED" });
    render(<AssistantMessageBubble message={completedMsg} />);
    expect(screen.getByTestId("markdown-renderer")).toBeInTheDocument();
    expect(screen.queryByTestId("streaming-content")).not.toBeInTheDocument();
  });
});
