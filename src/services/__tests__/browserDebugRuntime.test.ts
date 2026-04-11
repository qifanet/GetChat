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
});
