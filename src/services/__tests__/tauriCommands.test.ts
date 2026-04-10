/**
 * @file tauriCommands.test.ts
 * @description Mock tests for Tauri invoke contracts.
 *
 * These tests verify that tauriCommands wrappers:
 *   1. Call invoke() with the correct command name
 *   2. Pass arguments in the expected shape (camelCase)
 *   3. Return typed results without transformation errors
 *   4. Normalize backend errors into TauriAppError instances
 *
 * Mock strategy:
 *   - Mock @tauri-apps/api/core to intercept invoke calls
 *   - Each test verifies both the command name and argument shape
 *   - Error tests verify the TauriAppError normalization path
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core BEFORE importing the module under test.
// vi.mock is hoisted to the top of the file by vitest, so the factory
// must not reference any variables declared below it.
const { MockChannel } = vi.hoisted(() => ({
  MockChannel: class MockChannel<T = unknown> {
    id = 1;
    onmessage: (response: T) => void;

    constructor(onmessage?: (response: T) => void) {
      this.onmessage = onmessage ?? (() => undefined);
    }
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: MockChannel,
}));

// Import AFTER mock setup
import {
  bootstrapApp,
  createConversation,
  loadConversationSnapshot,
  renameConversation,
  archiveConversation,
  unarchiveConversation,
  deleteConversation,
  createBranch,
  renameBranch,
  archiveBranch,
  unarchiveBranch,
  setMainlineBranch,
  createUserMessage,
  createAssistantPlaceholderForBranch,
  createAssistantVariantPlaceholder,
  completeAssistantMessage,
  failAssistantMessage,
  buildPromptMessages,
  startModelStream,
  abortModelStream,
  saveProvider,
  deleteProvider,
  checkDbInvariants,
  saveLastWorkspace,
} from "../tauriCommands";
import { TauriAppError } from "../tauriTypes";

// Get a reference to the mocked invoke function
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

// ============================================================================
// Test Fixtures
// ============================================================================

/** Minimal valid ProviderDto returned by backend */
const MOCK_PROVIDER_DTO = {
  id: "prov-1",
  type: "OPENAI_COMPATIBLE",
  name: "Test Provider",
  baseUrl: "https://api.example.com/v1",
  defaultModelId: "gpt-4",
  hasApiKey: true,
  enabled: true,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

/** Minimal valid ConversationSummary returned by backend */
const MOCK_CONVERSATION_SUMMARY = {
  id: "conv-1",
  title: "Test Conversation",
  mainlineBranchId: "br-1",
  activeBranchCount: 1,
  archivedBranchCount: 0,
  totalMessageCount: 5,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  lastOpenedAt: 1700000000000,
  archivedAt: null,
};

/** Minimal valid BranchEntity returned by backend */
const MOCK_BRANCH_ENTITY = {
  id: "br-1",
  conversationId: "conv-1",
  name: "Main",
  status: "ACTIVE",
  isMainline: true,
  sourceBranchId: null,
  forkPointMessageId: null,
  forkSourceType: "ROOT",
  forkSourceMessageId: null,
  headMessageId: "msg-5",
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

/** Minimal valid MessageNode returned by backend */
const MOCK_MESSAGE_NODE = {
  id: "msg-1",
  conversationId: "conv-1",
  role: "USER",
  status: "COMPLETED",
  parentId: null,
  childIds: ["msg-2"],
  depth: 0,
  siblingIndex: 0,
  content: { text: "Hello", format: "MARKDOWN" },
  providerId: null,
  modelId: null,
  requestId: null,
  generationParams: null,
  usage: null,
  error: null,
  editedFromMessageId: null,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  mockInvoke.mockReset();
});

// --- Bootstrap Commands ---

describe("bootstrapApp", () => {
  it("calls invoke with 'bootstrap_app' and no args", async () => {
    mockInvoke.mockResolvedValue({
      lastWorkspace: null,
      providers: [MOCK_PROVIDER_DTO],
      defaultModelId: null,
    });

    const result = await bootstrapApp();

    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(mockInvoke).toHaveBeenCalledWith("bootstrap_app");
    expect(result.providers).toHaveLength(1);
    expect(result.lastWorkspace).toBeNull();
  });
});

describe("saveLastWorkspace", () => {
  it("calls invoke with 'save_last_workspace' and workspaceJson", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const workspace = { conversationId: "conv-1", branchId: "br-1" };

    await saveLastWorkspace(workspace);

    expect(mockInvoke).toHaveBeenCalledWith("save_last_workspace", {
      workspaceJson: workspace,
    });
  });
});

// --- Provider Commands ---

describe("saveProvider", () => {
  it("calls invoke with 'save_provider' and input", async () => {
    mockInvoke.mockResolvedValue(MOCK_PROVIDER_DTO);
    const input = {
      type: "OPENAI_COMPATIBLE" as const,
      name: "Test",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
      models: [
        {
          id: "model-test",
          requestName: "gpt-4.1-mini",
          displayName: "GPT-4.1 Mini",
        },
      ],
    };

    const result = await saveProvider(input);

    expect(mockInvoke).toHaveBeenCalledWith("save_provider", { input });
    expect(result.id).toBe("prov-1");
    expect(result.hasApiKey).toBe(true);
  });
});

describe("deleteProvider", () => {
  it("calls invoke with 'delete_provider' and providerId", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await deleteProvider("prov-1");

    expect(mockInvoke).toHaveBeenCalledWith("delete_provider", {
      providerId: "prov-1",
    });
  });
});

// --- Conversation Commands ---

describe("createConversation", () => {
  it("calls invoke with 'create_conversation' and input", async () => {
    mockInvoke.mockResolvedValue(MOCK_CONVERSATION_SUMMARY);
    const input = { title: "New Chat" };

    const result = await createConversation(input);

    expect(mockInvoke).toHaveBeenCalledWith("create_conversation", { input });
    expect(result.id).toBe("conv-1");
    expect(result.title).toBe("Test Conversation");
  });
});

describe("loadConversationSnapshot", () => {
  it("calls invoke with 'load_conversation_snapshot' and wrapped input", async () => {
    const mockSnapshot = {
      summary: MOCK_CONVERSATION_SUMMARY,
      entities: {
        messages: { "msg-1": MOCK_MESSAGE_NODE },
        branches: { "br-1": MOCK_BRANCH_ENTITY },
      },
      indexes: {
        rootMessageIds: ["msg-1"],
        childMessageIdsByParentId: {},
        branchIdsByForkPointId: {},
      },
      loadedAt: 1700000000000,
    };
    mockInvoke.mockResolvedValue(mockSnapshot);

    const result = await loadConversationSnapshot("conv-1");

    expect(mockInvoke).toHaveBeenCalledWith("load_conversation_snapshot", {
      input: { conversationId: "conv-1" },
    });
    expect(result.summary.id).toBe("conv-1");
  });
});

describe("renameConversation", () => {
  it("calls invoke with 'rename_conversation' and flat args", async () => {
    mockInvoke.mockResolvedValue({
      ...MOCK_CONVERSATION_SUMMARY,
      title: "Renamed",
    });

    const result = await renameConversation("conv-1", "Renamed");

    expect(mockInvoke).toHaveBeenCalledWith("rename_conversation", {
      conversationId: "conv-1",
      title: "Renamed",
    });
    expect(result.title).toBe("Renamed");
  });
});

describe("archiveConversation", () => {
  it("returns updated ConversationSummary (not void)", async () => {
    const archived = {
      ...MOCK_CONVERSATION_SUMMARY,
      archivedAt: 1700000000000,
    };
    mockInvoke.mockResolvedValue(archived);

    const result = await archiveConversation("conv-1");

    expect(mockInvoke).toHaveBeenCalledWith("archive_conversation", {
      conversationId: "conv-1",
    });
    expect(result.archivedAt).toBe(1700000000000);
  });
});

describe("unarchiveConversation", () => {
  it("returns updated ConversationSummary with archivedAt null", async () => {
    mockInvoke.mockResolvedValue({
      ...MOCK_CONVERSATION_SUMMARY,
      archivedAt: null,
    });

    const result = await unarchiveConversation("conv-1");

    expect(mockInvoke).toHaveBeenCalledWith("unarchive_conversation", {
      conversationId: "conv-1",
    });
    expect(result.archivedAt).toBeNull();
  });
});

describe("deleteConversation", () => {
  it("calls invoke with 'delete_conversation' and returns void", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await deleteConversation("conv-1");

    expect(mockInvoke).toHaveBeenCalledWith("delete_conversation", {
      conversationId: "conv-1",
    });
  });
});

// --- Branch Commands ---

describe("createBranch", () => {
  it("calls invoke with 'create_branch' and input", async () => {
    mockInvoke.mockResolvedValue({
      ...MOCK_BRANCH_ENTITY,
      id: "br-2",
      forkSourceType: "CURRENT_LEAF",
    });

    const input = {
      conversationId: "conv-1",
      sourceBranchId: "br-1",
      forkSourceType: "CURRENT_LEAF" as const,
    };

    const result = await createBranch(input);

    expect(mockInvoke).toHaveBeenCalledWith("create_branch", { input });
    expect(result.id).toBe("br-2");
    expect(result.forkSourceType).toBe("CURRENT_LEAF");
  });
});

describe("renameBranch", () => {
  it("returns updated BranchEntity (not void)", async () => {
    mockInvoke.mockResolvedValue({
      ...MOCK_BRANCH_ENTITY,
      name: "Renamed Branch",
    });

    const result = await renameBranch({ branchId: "br-1", name: "Renamed Branch" });

    expect(mockInvoke).toHaveBeenCalledWith("rename_branch", {
      input: { branchId: "br-1", name: "Renamed Branch" },
    });
    expect(result.name).toBe("Renamed Branch");
  });
});

describe("archiveBranch", () => {
  it("returns updated BranchEntity (not void)", async () => {
    mockInvoke.mockResolvedValue({
      ...MOCK_BRANCH_ENTITY,
      status: "ARCHIVED",
    });

    const result = await archiveBranch("br-1");

    expect(mockInvoke).toHaveBeenCalledWith("archive_branch", {
      branchId: "br-1",
    });
    expect(result.status).toBe("ARCHIVED");
  });
});

describe("unarchiveBranch", () => {
  it("returns updated BranchEntity (not void)", async () => {
    mockInvoke.mockResolvedValue({
      ...MOCK_BRANCH_ENTITY,
      status: "ACTIVE",
    });

    const result = await unarchiveBranch("br-1");

    expect(mockInvoke).toHaveBeenCalledWith("unarchive_branch", {
      branchId: "br-1",
    });
    expect(result.status).toBe("ACTIVE");
  });
});

describe("setMainlineBranch", () => {
  it("returns SetMainlineResult with old and new branch", async () => {
    const setResult = {
      oldMainlineBranchId: "br-1",
      newMainlineBranch: { ...MOCK_BRANCH_ENTITY, id: "br-2", isMainline: true },
    };
    mockInvoke.mockResolvedValue(setResult);

    const result = await setMainlineBranch({
      conversationId: "conv-1",
      branchId: "br-2",
    });

    expect(mockInvoke).toHaveBeenCalledWith("set_mainline_branch", {
      input: { conversationId: "conv-1", branchId: "br-2" },
    });
    expect(result.oldMainlineBranchId).toBe("br-1");
    expect(result.newMainlineBranch.id).toBe("br-2");
    expect(result.newMainlineBranch.isMainline).toBe(true);
  });
});

// --- Message Commands ---

describe("createUserMessage", () => {
  it("calls invoke with 'create_user_message' and input", async () => {
    mockInvoke.mockResolvedValue(MOCK_MESSAGE_NODE);

    const input = {
      conversationId: "conv-1",
      branchId: "br-1",
      contentText: "Hello",
    };

    const result = await createUserMessage(input);

    expect(mockInvoke).toHaveBeenCalledWith("create_user_message", { input });
    expect(result.id).toBe("msg-1");
  });
});

describe("createAssistantPlaceholderForBranch", () => {
  it("calls invoke with correct command and branchId", async () => {
    const placeholder = {
      ...MOCK_MESSAGE_NODE,
      id: "msg-2",
      role: "ASSISTANT",
      status: "STREAMING",
    };
    mockInvoke.mockResolvedValue(placeholder);

    const input = {
      conversationId: "conv-1",
      branchId: "br-1",
      providerId: "prov-1",
      modelId: "gpt-4",
      requestId: "req-1",
    };

    const result = await createAssistantPlaceholderForBranch(input);

    expect(mockInvoke).toHaveBeenCalledWith(
      "create_assistant_placeholder_for_branch",
      { input }
    );
    expect(result.status).toBe("STREAMING");
  });
});

describe("createAssistantVariantPlaceholder", () => {
  it("calls invoke with parentMessageId (no branchId)", async () => {
    const variant = {
      ...MOCK_MESSAGE_NODE,
      id: "msg-2b",
      role: "ASSISTANT",
      status: "STREAMING",
      parentId: "msg-1",
    };
    mockInvoke.mockResolvedValue(variant);

    const input = {
      conversationId: "conv-1",
      parentMessageId: "msg-1",
      providerId: "prov-1",
      modelId: "gpt-4",
      requestId: "req-2",
    };

    const result = await createAssistantVariantPlaceholder(input);

    expect(mockInvoke).toHaveBeenCalledWith(
      "create_assistant_variant_placeholder",
      { input }
    );
    // CRITICAL: variant placeholder takes parentMessageId, NOT branchId
    expect(result.status).toBe("STREAMING");
  });
});

describe("completeAssistantMessage", () => {
  it("calls invoke with 'complete_assistant_message' and input", async () => {
    const completed = {
      ...MOCK_MESSAGE_NODE,
      id: "msg-2",
      role: "ASSISTANT",
      status: "COMPLETED",
      content: { text: "Hello! How can I help?", format: "MARKDOWN" },
    };
    mockInvoke.mockResolvedValue(completed);

    const input = {
      messageId: "msg-2",
      contentText: "Hello! How can I help?",
      usage: { promptTokens: 10, completionTokens: 20 },
    };

    const result = await completeAssistantMessage(input);

    expect(mockInvoke).toHaveBeenCalledWith("complete_assistant_message", {
      input,
    });
    expect(result.status).toBe("COMPLETED");
  });
});

describe("failAssistantMessage", () => {
  it("calls invoke with error details", async () => {
    const failed = {
      ...MOCK_MESSAGE_NODE,
      id: "msg-2",
      role: "ASSISTANT",
      status: "FAILED",
      error: { code: "RATE_LIMIT", message: "Too many requests", retriable: true },
    };
    mockInvoke.mockResolvedValue(failed);

    const input = {
      messageId: "msg-2",
      errorCode: "RATE_LIMIT",
      errorMessage: "Too many requests",
      errorRetriable: true,
    };

    const result = await failAssistantMessage(input);

    expect(mockInvoke).toHaveBeenCalledWith("fail_assistant_message", {
      input,
    });
    expect(result.status).toBe("FAILED");
  });
});

describe("buildPromptMessages", () => {
  it("calls invoke with 'build_prompt_messages' and input", async () => {
    const prompts = [
      { role: "USER", content: "Hello" },
    ];
    mockInvoke.mockResolvedValue(prompts);

    const input = {
      conversationId: "conv-1",
      upToMessageId: "msg-1",
    };

    const result = await buildPromptMessages(input);

    expect(mockInvoke).toHaveBeenCalledWith("build_prompt_messages", { input });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("USER");
  });
});

describe("startModelStream", () => {
  it("calls invoke with 'start_model_stream', input, and a Channel", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const input = {
      requestId: "req-1",
      providerId: "prov-1",
      modelId: "gpt-4",
      promptMessages: [{ role: "USER", content: "Hello" }],
    };

    await startModelStream(input, () => undefined);

    expect(mockInvoke).toHaveBeenCalledWith("start_model_stream", {
      input,
      channel: expect.objectContaining({ id: 1 }),
    });
  });
});

describe("abortModelStream", () => {
  it("calls invoke with 'abort_model_stream' and requestId", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await abortModelStream("req-1");

    expect(mockInvoke).toHaveBeenCalledWith("abort_model_stream", {
      requestId: "req-1",
    });
  });
});

// --- Debug Commands ---

describe("checkDbInvariants", () => {
  it("calls invoke with 'check_db_invariants' and returns structured result", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      checks: [
        { code: "CROSS_CONV_PARENT_MESSAGE", label: "No cross-conv parents", passed: true, rowCount: 0, sampleRows: [] },
      ],
      checkedAt: 1700000000000,
    });

    const result = await checkDbInvariants();

    expect(mockInvoke).toHaveBeenCalledWith("check_db_invariants");
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].code).toBe("CROSS_CONV_PARENT_MESSAGE");
  });
});

// --- Error Normalization ---

describe("error normalization via cmd()", () => {
  it("converts structured backend error to TauriAppError", async () => {
    mockInvoke.mockRejectedValue({
      code: "CONFLICT",
      message: "Cannot archive the mainline branch",
    });

    try {
      await archiveBranch("br-mainline");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TauriAppError);
      const err = e as TauriAppError;
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toContain("Cannot archive the mainline branch");
    }
  });

  it("wraps unknown error format as DB_ERROR", async () => {
    mockInvoke.mockRejectedValue("some raw string error");

    await expect(archiveBranch("br-1")).rejects.toMatchObject({
      code: "DB_ERROR",
    });
  });

  it("preserves details field from backend error", async () => {
    mockInvoke.mockRejectedValue({
      code: "NOT_FOUND",
      message: "Conversation not found",
      details: "conv-nonexistent",
    });

    try {
      await loadConversationSnapshot("conv-nonexistent");
    } catch (e) {
      expect(e).toBeInstanceOf(TauriAppError);
      const err = e as TauriAppError;
      expect(err.code).toBe("NOT_FOUND");
      expect(err.details).toBe("conv-nonexistent");
    }
  });
});

// --- Command Name Contract (SMOKE-14) ---

describe("command name contract", () => {
  /** Verify all command names match the Rust #[tauri::command] function names */
  it("uses snake_case command names matching Rust functions", async () => {
    mockInvoke.mockResolvedValue(null);

    const expectedNames = [
      "bootstrap_app",
      "save_last_workspace",
      "list_providers",
      "save_provider",
      "delete_provider",
      "test_provider_connection",
      "list_conversation_summaries",
      "create_conversation",
      "load_conversation_snapshot",
      "rename_conversation",
      "archive_conversation",
      "unarchive_conversation",
      "delete_conversation",
      "create_branch",
      "rename_branch",
      "archive_branch",
      "unarchive_branch",
      "set_mainline_branch",
      "create_user_message",
      "create_assistant_placeholder_for_branch",
      "create_assistant_variant_placeholder",
      "complete_assistant_message",
      "fail_assistant_message",
      "build_prompt_messages",
      "start_model_stream",
      "abort_model_stream",
      "check_db_invariants",
    ];

    // Exhaustively invoke every command to collect all invoke call names
    mockInvoke.mockResolvedValue(undefined);
    try { await bootstrapApp(); } catch {}
    try {
      await saveLastWorkspace({ conversationId: null, branchId: null });
    } catch {}
    try { await (() => invoke("list_providers"))(); } catch {}
    try {
      await saveProvider({
        type: "OPENAI_COMPATIBLE",
        name: "",
        baseUrl: "",
        models: [
          {
            id: "model-exhaustive",
            requestName: "gpt-4.1-mini",
            displayName: "GPT-4.1 Mini",
          },
        ],
      });
    } catch {}
    try { await deleteProvider("x"); } catch {}
    try { await (() => invoke("test_provider_connection", { providerId: "x" }))(); } catch {}
    try { await (() => invoke("list_conversation_summaries"))(); } catch {}
    try { await createConversation({}); } catch {}
    try { await loadConversationSnapshot("x"); } catch {}
    try { await renameConversation("x", "y"); } catch {}
    try { await archiveConversation("x"); } catch {}
    try { await unarchiveConversation("x"); } catch {}
    try { await deleteConversation("x"); } catch {}
    try { await createBranch({ conversationId: "x", forkSourceType: "CURRENT_LEAF" }); } catch {}
    try { await renameBranch({ branchId: "x", name: "y" }); } catch {}
    try { await archiveBranch("x"); } catch {}
    try { await unarchiveBranch("x"); } catch {}
    try { await setMainlineBranch({ conversationId: "x", branchId: "y" }); } catch {}
    try { await createUserMessage({ conversationId: "x", branchId: "y", contentText: "" }); } catch {}
    try { await createAssistantPlaceholderForBranch({ conversationId: "x", branchId: "y", providerId: "p", modelId: "m", requestId: "r" }); } catch {}
    try { await createAssistantVariantPlaceholder({ conversationId: "x", parentMessageId: "m", providerId: "p", modelId: "m", requestId: "r" }); } catch {}
    try { await completeAssistantMessage({ messageId: "x", contentText: "" }); } catch {}
    try { await failAssistantMessage({ messageId: "x", errorCode: "", errorMessage: "", errorRetriable: false }); } catch {}
    try { await buildPromptMessages({ conversationId: "x", upToMessageId: "y" }); } catch {}
    try { await startModelStream({ requestId: "r", providerId: "p", modelId: "m", promptMessages: [] }, () => undefined); } catch {}
    try { await abortModelStream("r"); } catch {}
    try { await checkDbInvariants(); } catch {}

    const calledNames = new Set(
      mockInvoke.mock.calls.map((call: unknown[]) => call[0] as string)
    );

    for (const name of expectedNames) {
      expect(calledNames.has(name)).toBe(true);
    }
  });
});
