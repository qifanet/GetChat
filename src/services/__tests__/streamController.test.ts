/**
 * @file streamController.test.ts
 * @description Tests for the streaming controller's critical flows.
 *
 * Product rules tested:
 *   - startAssistantStream creates placeholder message + stream session + runtime session
 *   - onStreamChunk accumulates chunks in runtime buffer, not in React state
 *   - completeStream joins chunks into final text and commits ONCE (not per token)
 *   - failStream preserves partial text with retriable=true
 *   - cancelStream marks message as ABORTED
 *   - Surface attachment flushes accumulated chunks immediately
 *
 * Mock boundaries:
 *   - useAppStore: mock getState to return stub actions
 *   - useStreamStore: mock getState to return stub actions
 *   - streamRuntimeRegistry: mock get/set/delete to use in-memory Map
 *   - surfaces/surfaceFactory: mock to return stub surface
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Mock Setup
// ============================================================================

// In-memory runtime sessions for testing
const runtimeMap = new Map();

vi.mock("../../services/streamRuntimeRegistry", () => ({
  getRuntimeSession: (id: string) => runtimeMap.get(id) ?? null,
  setRuntimeSession: (session: any) => runtimeMap.set(session.requestId, session),
  deleteRuntimeSession: (id: string) => {
    const session = runtimeMap.get(id);
    if (session?.flushTimer) clearTimeout(session.flushTimer);
    if (session?.surface) session.surface.destroy();
    runtimeMap.delete(id);
  },
  hasRuntimeSession: (id: string) => runtimeMap.has(id),
  getActiveStreamCount: () => runtimeMap.size,
}));

// Mock surface factory
const mockSurface = {
  mount: vi.fn(),
  append: vi.fn(),
  replaceAll: vi.fn(),
  destroy: vi.fn(),
};

vi.mock("../../services/surfaces/surfaceFactory", () => ({
  createTextSurface: () => mockSurface,
}));

const { mockTauriCommands } = vi.hoisted(() => ({
  mockTauriCommands: {
    createAssistantPlaceholderForBranch: vi.fn(async (input: any) => ({
      id: "msg_assistant",
      conversationId: input.conversationId,
      role: "ASSISTANT",
      status: "STREAMING",
      parentId: "msg_parent",
      childIds: [],
      depth: 1,
      content: { text: "", format: "MARKDOWN" },
      createdAt: 1000,
      updatedAt: 1000,
      generation: {
        providerId: input.providerId,
        modelId: input.modelId,
        requestId: input.requestId,
      },
    })),
    completeAssistantMessage: vi.fn(async (input: any) => ({
      id: input.messageId,
      conversationId: "conv_1",
      role: "ASSISTANT",
      status: "COMPLETED",
      parentId: "msg_parent",
      childIds: [],
      depth: 1,
      content: { text: input.contentText, format: "MARKDOWN" },
      createdAt: 1000,
      updatedAt: 2000,
      generation: {
        providerId: "prov_1",
        modelId: "model_1",
        requestId: "req_test",
      },
    })),
    failAssistantMessage: vi.fn(async (input: any) => ({
      id: input.messageId,
      conversationId: "conv_1",
      role: "ASSISTANT",
      status: "FAILED",
      parentId: "msg_parent",
      childIds: [],
      depth: 1,
      content: { text: input.partialContentText ?? "", format: "MARKDOWN" },
      createdAt: 1000,
      updatedAt: 2000,
      generation: {
        providerId: "prov_1",
        modelId: "model_1",
        requestId: "req_test",
      },
      error: {
        code: input.errorCode,
        message: input.errorMessage,
        retriable: input.errorRetriable,
      },
    })),
    startModelStream: vi.fn(async () => undefined),
    abortModelStream: vi.fn(async () => undefined),
  },
}));

vi.mock("../../services/tauriCommands", () => mockTauriCommands);

// Mock appStore
const mockAppStoreActions = {
  upsertMessageLocal: vi.fn(),
  patchMessageLocal: vi.fn(),
  patchBranchLocal: vi.fn(),
  setSendingState: vi.fn(),
  resetComposerAfterSend: vi.fn(),
};

vi.mock("../../stores/useAppStore", () => ({
  useAppStore: {
    getState: () => mockAppStoreActions,
  },
}));

// Mock streamStore
const mockSessions: Record<string, any> = {};

const mockStreamStoreActions = {
  createSession: vi.fn((meta: any) => { mockSessions[meta.requestId] = meta; }),
  patchSession: vi.fn((id: string, patch: any) => {
    if (mockSessions[id]) Object.assign(mockSessions[id], patch);
  }),
  completeSession: vi.fn((id: string) => {
    if (mockSessions[id]) mockSessions[id].status = "COMPLETED";
  }),
  failSession: vi.fn((id: string, error: any) => {
    if (mockSessions[id]) {
      mockSessions[id].status = "FAILED";
      mockSessions[id].error = error;
    }
  }),
  removeSession: vi.fn((id: string) => { delete mockSessions[id]; }),
};

vi.mock("../../stores/useStreamStore", () => ({
  useStreamStore: {
    getState: () => ({
      sessionsByRequestId: mockSessions,
      ...mockStreamStoreActions,
    }),
  },
}));

// Import after mocks
import { startAssistantStream, onStreamChunk, completeStream, failStream, cancelStream, attachSurfaceToRequest } from "../streamController";

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// Tests
// ============================================================================

describe("startAssistantStream", () => {
  beforeEach(() => {
    runtimeMap.clear();
    for (const k of Object.keys(mockSessions)) delete mockSessions[k];
    vi.clearAllMocks();
    mockTauriCommands.createAssistantPlaceholderForBranch.mockClear();
    mockTauriCommands.completeAssistantMessage.mockClear();
    mockTauriCommands.failAssistantMessage.mockClear();
  });

  it("creates placeholder message with STREAMING status", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });

    expect(result.requestId).toBeDefined();
    expect(result.assistantMessageId).toBe("msg_assistant");

    // Verify placeholder message created
    expect(mockAppStoreActions.upsertMessageLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "ASSISTANT",
        status: "STREAMING",
        parentId: "msg_parent",
        content: { text: "", format: "MARKDOWN" },
      })
    );
  });

  it("creates runtime session in registry (NOT in Zustand)", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });

    // Runtime session should be in the plain Map, not Zustand
    expect(runtimeMap.has(result.requestId)).toBe(true);
    const runtime = runtimeMap.get(result.requestId);
    expect(runtime.chunks).toEqual([]);
    expect(runtime.surface).toBeNull();
  });

  it("registers stream session metadata in streamStore", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });

    expect(mockStreamStoreActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: result.requestId,
        status: expect.any(String),
      })
    );
  });

  it("starts the backend model stream after placeholder setup", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [{ role: "USER", content: "Hello" }],
    });

    expect(mockTauriCommands.startModelStream).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: result.requestId,
        providerId: "prov_1",
        modelId: "model_1",
        promptMessages: [{ role: "USER", content: "Hello" }],
      }),
      expect.any(Function)
    );
  });
});

describe("onStreamChunk", () => {
  beforeEach(() => {
    runtimeMap.clear();
    for (const k of Object.keys(mockSessions)) delete mockSessions[k];
    vi.clearAllMocks();
    mockTauriCommands.createAssistantPlaceholderForBranch.mockClear();
    mockTauriCommands.completeAssistantMessage.mockClear();
    mockTauriCommands.failAssistantMessage.mockClear();
  });

  it("accumulates chunks in runtime buffer, not in message content", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });
    mockStreamStoreActions.patchSession.mockClear();

    // Push chunks
    onStreamChunk(result.requestId, "Hello ");
    onStreamChunk(result.requestId, "world!");

    const runtime = runtimeMap.get(result.requestId);
    expect(runtime.chunks).toEqual(["Hello ", "world!"]);
    expect(runtime.pendingChunks).toEqual(["Hello ", "world!"]);
    expect(runtime.totalChars).toBe(12);

    // Message content should NOT be updated per chunk
    // patchMessageLocal should NOT have been called yet for content
    const messagePatches = mockAppStoreActions.patchMessageLocal.mock.calls;
    const contentPatches = messagePatches.filter(
      (call: any[]) => call[1]?.content !== undefined
    );
    expect(contentPatches).toHaveLength(0);
    expect(mockStreamStoreActions.patchSession).not.toHaveBeenCalled();
  });

  it("does nothing for nonexistent request", () => {
    // Should not throw
    expect(() => onStreamChunk("nonexistent", "chunk")).not.toThrow();
  });

  it("flushes only the appended delta to the surface", async () => {
    vi.useFakeTimers();

    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });
    mockStreamStoreActions.patchSession.mockClear();

    const container = document.createElement("div");
    attachSurfaceToRequest(result.requestId, container, "DOM_TEXT");

    onStreamChunk(result.requestId, "Hello ");
    onStreamChunk(result.requestId, "world!");

    vi.advanceTimersByTime(30);

    expect(mockSurface.append).toHaveBeenCalledWith("Hello world!");
    expect(mockSurface.replaceAll).not.toHaveBeenCalledWith("Hello world!");
  });
});

describe("completeStream", () => {
  beforeEach(() => {
    runtimeMap.clear();
    for (const k of Object.keys(mockSessions)) delete mockSessions[k];
    vi.clearAllMocks();
    mockTauriCommands.createAssistantPlaceholderForBranch.mockClear();
    mockTauriCommands.completeAssistantMessage.mockClear();
    mockTauriCommands.failAssistantMessage.mockClear();
  });

  it("joins all chunks into final text and commits ONCE", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });

    // Simulate chunks
    onStreamChunk(result.requestId, "Hello ");
    onStreamChunk(result.requestId, "world!");

    // Complete the stream
    await completeStream(result.requestId);

    // Final text should be committed exactly ONCE
    expect(mockAppStoreActions.patchMessageLocal).toHaveBeenCalledWith(
      result.assistantMessageId,
      expect.objectContaining({
        status: "COMPLETED",
        content: { text: "Hello world!", format: "MARKDOWN" },
      })
    );

    // Runtime session should be cleaned up
    expect(runtimeMap.has(result.requestId)).toBe(false);
  });

  it("resets composer sending state after completion", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });

    await completeStream(result.requestId);

    expect(mockAppStoreActions.setSendingState).toHaveBeenCalledWith({
      isSending: false,
      activeRequestId: null,
    });
  });
});

describe("failStream", () => {
  beforeEach(() => {
    runtimeMap.clear();
    for (const k of Object.keys(mockSessions)) delete mockSessions[k];
    vi.clearAllMocks();
    mockTauriCommands.createAssistantPlaceholderForBranch.mockClear();
    mockTauriCommands.completeAssistantMessage.mockClear();
    mockTauriCommands.failAssistantMessage.mockClear();
  });

  it("preserves partial text and marks as FAILED with retriable=true", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });

    onStreamChunk(result.requestId, "Partial ");

    await failStream(result.requestId, {
      code: "RATE_LIMIT",
      message: "Rate limit exceeded",
    });

    // Should preserve partial text
    expect(mockAppStoreActions.patchMessageLocal).toHaveBeenCalledWith(
      result.assistantMessageId,
      expect.objectContaining({
        status: "FAILED",
        content: { text: "Partial ", format: "MARKDOWN" },
        error: {
          code: "RATE_LIMIT",
          message: "Rate limit exceeded",
          retriable: true, // All failures are retriable by default
        },
      })
    );
  });
});

describe("cancelStream", () => {
  beforeEach(() => {
    runtimeMap.clear();
    for (const k of Object.keys(mockSessions)) delete mockSessions[k];
    vi.clearAllMocks();
    mockTauriCommands.createAssistantPlaceholderForBranch.mockClear();
    mockTauriCommands.completeAssistantMessage.mockClear();
    mockTauriCommands.failAssistantMessage.mockClear();
  });

  it("marks message as ABORTED with partial text preserved", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });

    onStreamChunk(result.requestId, "Some partial ");

    await cancelStream(result.requestId);

    expect(mockTauriCommands.abortModelStream).toHaveBeenCalledWith(result.requestId);
    expect(mockAppStoreActions.patchMessageLocal).toHaveBeenCalledWith(
      result.assistantMessageId,
      expect.objectContaining({
        status: "FAILED",
        content: { text: "Some partial ", format: "MARKDOWN" },
        error: {
          code: "USER_CANCELLED",
          message: "Generation cancelled by user",
          retriable: true,
        },
      })
    );

    // Runtime should be cleaned up
    expect(runtimeMap.has(result.requestId)).toBe(false);
  });
});

describe("attachSurfaceToRequest", () => {
  beforeEach(() => {
    runtimeMap.clear();
    for (const k of Object.keys(mockSessions)) delete mockSessions[k];
    vi.clearAllMocks();
    mockSurface.mount.mockClear();
    mockSurface.replaceAll.mockClear();
    mockSurface.destroy.mockClear();
    mockTauriCommands.createAssistantPlaceholderForBranch.mockClear();
    mockTauriCommands.completeAssistantMessage.mockClear();
    mockTauriCommands.failAssistantMessage.mockClear();
  });

  it("flushes accumulated chunks immediately on attach", async () => {
    const result = await startAssistantStream({
      conversationId: "conv_1",
      branchId: "branch_1",
      parentMessageId: "msg_parent",
      providerId: "prov_1",
      modelId: "model_1",
      promptMessages: [],
    });

    // Accumulate chunks before surface is attached
    onStreamChunk(result.requestId, "Hello ");
    onStreamChunk(result.requestId, "world!");

    const container = document.createElement("div");
    attachSurfaceToRequest(result.requestId, container, "DOM_TEXT");

    // Surface should be created and mounted
    expect(mockSurface.mount).toHaveBeenCalledWith(container);

    // All accumulated chunks should be flushed immediately
    expect(mockSurface.replaceAll).toHaveBeenCalledWith("Hello world!");
  });
});
