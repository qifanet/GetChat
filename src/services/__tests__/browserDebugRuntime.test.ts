/**
 * @file browserDebugRuntime.test.ts
 * @description Tests for the browser debug runtime used outside Tauri.
 *
 * These tests verify that the fallback runtime can bootstrap the app,
 * persist provider settings, mutate conversations, and simulate a stream
 * without relying on Playwright-side mock injection.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortBrowserDebugModelStream,
  invokeBrowserDebugCommand,
  resetBrowserDebugRuntimeForTests,
  startBrowserDebugModelStream,
} from "../browserDebugRuntime";
import type {
  BootstrapResult,
  ConversationSnapshot,
  ConversationSummary,
  ModelStreamEvent,
  ProviderDto,
} from "../tauriTypes";

/** Reset browser debug storage after each test for deterministic assertions. */
afterEach(() => {
  resetBrowserDebugRuntimeForTests();
});

describe("browserDebugRuntime", () => {
  it("bootstraps with a workspace-first dataset and no mandatory provider", async () => {
    const bootstrap =
      await invokeBrowserDebugCommand<BootstrapResult>("bootstrap_app");
    const summaries = await invokeBrowserDebugCommand<ConversationSummary[]>(
      "list_conversation_summaries"
    );

    expect(bootstrap.providers).toEqual([]);
    expect(bootstrap.defaultModelId).toBeNull();
    expect(bootstrap.lastWorkspace?.conversationId).toBeTruthy();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe("架构方案评审");
  });

  it("persists and resets the application system prompt", async () => {
    const bootstrap =
      await invokeBrowserDebugCommand<BootstrapResult>("bootstrap_app");
    expect(bootstrap.systemPrompt).toContain("local-first desktop AI assistant");

    const savedPrompt = await invokeBrowserDebugCommand<string>(
      "set_system_prompt",
      {
        prompt: "Custom browser debug prompt",
      }
    );
    expect(savedPrompt).toBe("Custom browser debug prompt");

    const reloadedPrompt = await invokeBrowserDebugCommand<string>(
      "get_system_prompt"
    );
    expect(reloadedPrompt).toBe("Custom browser debug prompt");

    const resetPrompt = await invokeBrowserDebugCommand<string>(
      "set_system_prompt",
      {
        prompt: "   ",
      }
    );
    expect(resetPrompt).toContain("local-first desktop AI assistant");
  });

  it("persists provider settings and default model", async () => {
    const provider = await invokeBrowserDebugCommand<ProviderDto>("save_provider", {
      input: {
        type: "OPENAI_COMPATIBLE",
        name: "OpenAI Test",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        defaultModelId: "gpt-4.1-mini",
        models: [
          {
            id: "gpt-4.1-mini",
            requestName: "gpt-4.1-mini",
            displayName: "GPT-4.1 Mini",
          },
        ],
        enabled: true,
      },
    });

    await invokeBrowserDebugCommand("set_default_model", {
      modelId: provider.defaultModelId,
    });

    const providers = await invokeBrowserDebugCommand<ProviderDto[]>(
      "list_providers"
    );
    const defaultModel = await invokeBrowserDebugCommand<string | null>(
      "get_default_model"
    );

    expect(providers).toHaveLength(1);
    expect(providers[0].hasApiKey).toBe(true);
    expect(defaultModel).toBe("gpt-4.1-mini");
  });

  it("creates and loads a new conversation snapshot", async () => {
    const summary = await invokeBrowserDebugCommand<ConversationSummary>(
      "create_conversation",
      {
      input: {
        title: "浏览器调试会话",
      },
      }
    );

    const snapshot = await invokeBrowserDebugCommand<ConversationSnapshot>(
      "load_conversation_snapshot",
      {
        input: { conversationId: summary.id },
      }
    );

    expect(snapshot.summary.title).toBe("浏览器调试会话");
    expect(Object.values(snapshot.entities.branches)).toHaveLength(1);
    expect(snapshot.summary.totalMessageCount).toBe(0);
  });

  it("simulates a streaming lifecycle and supports abort", async () => {
    const onEvent = vi.fn<(event: ModelStreamEvent) => void>();

    await startBrowserDebugModelStream(
      {
        requestId: "req_debug_stream_missing",
        providerId: "provider_missing",
        modelId: "browser-debug-model",
        promptMessages: [{ role: "user", content: "请总结当前状态" }],
      },
      onEvent
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "FAILED",
        requestId: "req_debug_stream_missing",
      })
    );

    onEvent.mockClear();

    const provider = await invokeBrowserDebugCommand<ProviderDto>("save_provider", {
      input: {
        type: "OPENAI_COMPATIBLE",
        name: "Debug Provider",
        baseUrl: "https://debug.local/v1",
        defaultModelId: "browser-debug-model",
        models: [
          {
            id: "browser-debug-model",
            requestName: "browser-debug-model",
            displayName: "Browser Debug Model",
          },
        ],
        enabled: true,
      },
    });

    await startBrowserDebugModelStream(
      {
        requestId: "req_debug_stream_ok",
        providerId: provider.id,
        modelId: "browser-debug-model",
        promptMessages: [{ role: "user", content: "请总结当前状态" }],
      },
      onEvent
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "CHUNK",
        requestId: "req_debug_stream_ok",
      })
    );

    await abortBrowserDebugModelStream("req_debug_stream_ok");
  });

  it("supports non-destructive history user edit by creating a fork", async () => {
    const snapshotBefore = await invokeBrowserDebugCommand<ConversationSnapshot>(
      "load_conversation_snapshot",
      { input: { conversationId: "conv_seed_architecture_review" } }
    );

    const branch = await invokeBrowserDebugCommand<ConversationSnapshot["entities"]["branches"][string]>(
      "create_branch",
      {
        input: {
          conversationId: "conv_seed_architecture_review",
          sourceBranchId: "branch_seed_mainline",
          forkPointMessageId: null,
          forkSourceType: "HISTORY_USER_EDIT",
          forkSourceMessageId: "msg_seed_user_request",
        },
      }
    );

    const edited = await invokeBrowserDebugCommand<ConversationSnapshot["entities"]["messages"][string]>(
      "create_user_message",
      {
        input: {
          conversationId: "conv_seed_architecture_review",
          branchId: branch.id,
          contentText: "新的问题描述",
          parentMessageId: null,
          editedFromMessageId: "msg_seed_user_request",
        },
      }
    );

    const snapshotAfter = await invokeBrowserDebugCommand<ConversationSnapshot>(
      "load_conversation_snapshot",
      { input: { conversationId: "conv_seed_architecture_review" } }
    );

    expect(edited.content.text).toBe("新的问题描述");
    expect(edited.editedFromMessageId).toBe("msg_seed_user_request");
    expect(Object.keys(snapshotBefore.entities.messages).length).toBe(3);
    expect(snapshotAfter.entities.messages.msg_seed_user_request.content.text).toBe(
      "请给出两套后端重构路径，并说明差异。"
    );
    expect(snapshotAfter.entities.branches[branch.id].headMessageId).toBe(edited.id);
  });

  it("supports assistant variant deletion for non-head assistant leaf variants", async () => {
    const summary = await invokeBrowserDebugCommand<ConversationSummary>("create_conversation", {
      input: {
        title: "delete-message-test",
        initialUserMessage: "hello",
      },
    });
    const snapshot = await invokeBrowserDebugCommand<ConversationSnapshot>(
      "load_conversation_snapshot",
      { input: { conversationId: summary.id } }
    );
    const userId = snapshot.indexes.rootMessageIds[0];
    const branchId = Object.values(snapshot.entities.branches)[0].id;

    const mainAssistant = await invokeBrowserDebugCommand<ConversationSnapshot["entities"]["messages"][string]>(
      "create_assistant_placeholder_for_branch",
      {
        input: {
          conversationId: summary.id,
          branchId,
          providerId: "provider.debug",
          modelId: "model.debug",
          requestId: "req_keep_candidate",
        },
      }
    );
    await invokeBrowserDebugCommand("complete_assistant_message", {
      input: {
        messageId: mainAssistant.id,
        requestId: "req_keep_candidate",
        contentText: "keep",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    const variant = await invokeBrowserDebugCommand<ConversationSnapshot["entities"]["messages"][string]>(
      "create_assistant_variant_placeholder",
      {
        input: {
          conversationId: summary.id,
          parentMessageId: userId,
          providerId: "provider.debug",
          modelId: "model.debug",
          requestId: "req_delete_variant",
        },
      }
    );
    await invokeBrowserDebugCommand("complete_assistant_message", {
      input: {
        messageId: variant.id,
        requestId: "req_delete_variant",
        contentText: "done",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    await invokeBrowserDebugCommand("delete_assistant_variant_message", { messageId: variant.id });
    const afterDelete = await invokeBrowserDebugCommand<ConversationSnapshot>(
      "load_conversation_snapshot",
      { input: { conversationId: summary.id } }
    );

    expect(afterDelete.entities.messages[variant.id]).toBeUndefined();
  });
});
