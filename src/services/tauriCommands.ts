/**
 * @file tauriCommands.ts
 * @description Type-safe Tauri invoke wrappers for all backend commands.
 *
 * Encapsulation layer responsibilities:
 *   1. Centralize all command names (no raw strings scattered in components)
 *   2. Provide type-safe async functions with proper input/output types
 *   3. Normalize errors to TauriAppError (consistent error handling)
 *   4. Single point for future additions: caching, retry, toast
 *   5. Structured error logging via cmd() wrapper (commandName + duration_ms)
 *
 * Usage in components/stores:
 *   import { createConversation } from "../services/tauriCommands";
 *   const summary = await createConversation({ title: "New Chat" });
 *
 * Do NOT import invoke directly in components — always use these wrappers.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import {
  TauriAppError,
  type BootstrapResult,
  type LastWorkspaceSelection,
  type ModelStreamEvent,
  type StartModelStreamInput,
  type ProviderDto,
  type SaveProviderInput,
  type CreateConversationInput,
  type ConversationSummary,
  type ConversationSnapshot,
  type CreateBranchInput,
  type BranchEntity,
  type RenameBranchInput,
  type SetBranchHeadMessageInput,
  type SetBranchPreferredModelInput,
  type SetMainlineBranchInput,
  type SetMainlineResult,
  type CreateUserMessageInput,
  type MessageNode,
  type CreateAssistantPlaceholderForBranchInput,
  type CreateAssistantVariantPlaceholderInput,
  type CompleteAssistantMessageInput,
  type FailAssistantMessageInput,
  type BuildPromptMessagesInput,
  type PromptMessage,
  type InvariantCheckResult,
} from "./tauriTypes";
import {
  abortBrowserDebugModelStream,
  invokeBrowserDebugCommand,
  shouldUseBrowserDebugRuntime,
  startBrowserDebugModelStream,
  type BrowserDebugCommandName,
} from "./browserDebugRuntime";

// ============================================================================
// Error Normalization
// ============================================================================

/**
 * Wrap a Tauri invoke promise with unified error handling and structured logging.
 * Converts raw invoke errors into typed TauriAppError instances.
 *
 * On error, logs `[tauri] ERROR_CODE commandName (duration_ms)` to console.error
 * for easy filtering in DevTools.
 *
 * @param promise - The invoke() promise to wrap
 * @param commandName - The Tauri command name for error logging
 */
function cmd<T>(promise: Promise<T>, commandName: string): Promise<T> {
  const start = Date.now();
  return promise.catch((err: unknown) => {
    const duration = Date.now() - start;
    if (typeof err === "object" && err !== null && "code" in err) {
      const raw = err as { code: string; message: string; details?: string };
      console.error(`[tauri] ${raw.code} ${commandName} (${duration}ms)`, raw.message);
      throw new TauriAppError(
        raw.code as TauriAppError["code"],
        raw.message,
        raw.details
      );
    }
    // Unexpected error format — wrap as DB_ERROR
    console.error(`[tauri] UNKNOWN ${commandName} (${duration}ms)`, err);
    throw new TauriAppError("DB_ERROR", String(err));
  });
}

/**
 * Execute a command against the real Tauri runtime when available, and
 * automatically fall back to the in-browser debug runtime otherwise.
 */
async function executeCommand<T>(
  commandName: BrowserDebugCommandName,
  args?: Record<string, unknown>
): Promise<T> {
  if (shouldUseBrowserDebugRuntime()) {
    return invokeBrowserDebugCommand<T>(commandName, args);
  }

  return cmd(
    Promise.resolve().then(() =>
      args ? invoke<T>(commandName, args) : invoke<T>(commandName)
    ),
    commandName
  );
}

// ============================================================================
// Bootstrap Commands
// ============================================================================

/** Load all data needed on app launch (last workspace, providers, settings) */
export async function bootstrapApp(): Promise<BootstrapResult> {
  return executeCommand<BootstrapResult>("bootstrap_app");
}

/** Persist workspace state for restoration on next launch */
export async function saveLastWorkspace(
  workspaceJson: LastWorkspaceSelection
): Promise<void> {
  return executeCommand<void>("save_last_workspace", { workspaceJson });
}

/** Get the default model ID */
export async function getDefaultModel(): Promise<string | null> {
  return executeCommand<string | null>("get_default_model");
}

/** Set the default model ID */
export async function setDefaultModel(modelId: string | null): Promise<void> {
  return executeCommand<void>("set_default_model", { modelId });
}

// ============================================================================
// Provider Commands
// ============================================================================

/** List all configured providers (no API key references exposed) */
export async function listProviders(): Promise<ProviderDto[]> {
  return executeCommand<ProviderDto[]>("list_providers");
}

/** Save (create or update) a provider configuration */
export async function saveProvider(input: SaveProviderInput): Promise<ProviderDto> {
  return executeCommand<ProviderDto>("save_provider", { input });
}

/** Delete a provider and its stored API key */
export async function deleteProvider(providerId: string): Promise<void> {
  return executeCommand<void>("delete_provider", { providerId });
}

/** Test a saved provider's live API connection through the backend probe path. */
export async function testProviderConnection(providerId: string): Promise<void> {
  return executeCommand<void>("test_provider_connection", { providerId });
}

// ============================================================================
// Conversation Commands
// ============================================================================

/** List all active conversation summaries for the sidebar */
export async function listConversationSummaries(): Promise<ConversationSummary[]> {
  return executeCommand<ConversationSummary[]>("list_conversation_summaries");
}

/** Create a new conversation with an optional initial user message */
export async function createConversation(
  input: CreateConversationInput
): Promise<ConversationSummary> {
  return executeCommand<ConversationSummary>("create_conversation", { input });
}

/** Load the full conversation snapshot (entities + indexes) for the workspace */
export async function loadConversationSnapshot(
  conversationId: string
): Promise<ConversationSnapshot> {
  return executeCommand<ConversationSnapshot>("load_conversation_snapshot", {
    input: { conversationId },
  });
}

/** Rename a conversation. Returns the updated summary. */
export async function renameConversation(
  conversationId: string,
  title: string
): Promise<ConversationSummary> {
  return executeCommand<ConversationSummary>("rename_conversation", {
    conversationId,
    title,
  });
}

/** Archive a conversation. Returns the updated summary. */
export async function archiveConversation(conversationId: string): Promise<ConversationSummary> {
  return executeCommand<ConversationSummary>("archive_conversation", {
    conversationId,
  });
}

/** Unarchive a conversation. Returns the updated summary. */
export async function unarchiveConversation(conversationId: string): Promise<ConversationSummary> {
  return executeCommand<ConversationSummary>("unarchive_conversation", {
    conversationId,
  });
}

/** Delete a conversation and all its data (CASCADE) */
export async function deleteConversation(conversationId: string): Promise<void> {
  return executeCommand<void>("delete_conversation", { conversationId });
}

// ============================================================================
// Branch Commands
// ============================================================================

/** Create a new branch from an existing message. Non-destructive. */
export async function createBranch(input: CreateBranchInput): Promise<BranchEntity> {
  return executeCommand<BranchEntity>("create_branch", { input });
}

/** Rename a branch. Returns the updated branch DTO. */
export async function renameBranch(input: RenameBranchInput): Promise<BranchEntity> {
  return executeCommand<BranchEntity>("rename_branch", { input });
}

/** Persist the preferred model profile for one branch. */
export async function setBranchPreferredModel(
  input: SetBranchPreferredModelInput
): Promise<BranchEntity> {
  return executeCommand<BranchEntity>("set_branch_preferred_model", { input });
}

/** Promote an existing message to the current branch head. */
export async function setBranchHeadMessage(
  input: SetBranchHeadMessageInput
): Promise<BranchEntity> {
  return executeCommand<BranchEntity>("set_branch_head_message", { input });
}

/** Archive a branch (cannot archive the mainline branch). Returns the updated branch DTO. */
export async function archiveBranch(branchId: string): Promise<BranchEntity> {
  return executeCommand<BranchEntity>("archive_branch", { branchId });
}

/** Unarchive a branch. Returns the updated branch DTO. */
export async function unarchiveBranch(branchId: string): Promise<BranchEntity> {
  return executeCommand<BranchEntity>("unarchive_branch", { branchId });
}

/** Set the mainline branch (only ACTIVE branches allowed). Returns result with IDs for isMainline update. */
export async function setMainlineBranch(
  input: SetMainlineBranchInput
): Promise<SetMainlineResult> {
  return executeCommand<SetMainlineResult>("set_mainline_branch", { input });
}

// ============================================================================
// Message Commands
// ============================================================================

/** Create a user message and append to the current branch */
export async function createUserMessage(
  input: CreateUserMessageInput
): Promise<MessageNode> {
  return executeCommand<MessageNode>("create_user_message", { input });
}

/** Create a STREAMING assistant placeholder (appended to branch head) */
export async function createAssistantPlaceholderForBranch(
  input: CreateAssistantPlaceholderForBranchInput
): Promise<MessageNode> {
  return executeCommand<MessageNode>("create_assistant_placeholder_for_branch", {
    input,
  });
}

/** Create a STREAMING assistant variant placeholder (regenerate — does NOT update branch head) */
export async function createAssistantVariantPlaceholder(
  input: CreateAssistantVariantPlaceholderInput
): Promise<MessageNode> {
  return executeCommand<MessageNode>("create_assistant_variant_placeholder", {
    input,
  });
}

/** Complete a streaming assistant message (STREAMING → COMPLETED) */
export async function completeAssistantMessage(
  input: CompleteAssistantMessageInput
): Promise<MessageNode> {
  return executeCommand<MessageNode>("complete_assistant_message", { input });
}

/** Fail a streaming assistant message (STREAMING → FAILED) */
export async function failAssistantMessage(
  input: FailAssistantMessageInput
): Promise<MessageNode> {
  return executeCommand<MessageNode>("fail_assistant_message", { input });
}

/** Build the prompt message array by walking the tree from leaf to root */
export async function buildPromptMessages(
  input: BuildPromptMessagesInput
): Promise<PromptMessage[]> {
  return executeCommand<PromptMessage[]>("build_prompt_messages", { input });
}

// ============================================================================
// Runtime Streaming Commands
/** Hard delete a variant/candidate assistant message */
export async function deleteMessage(messageId: string): Promise<void> {
  return executeCommand<void>("delete_message", { messageId });
}

/** Edit a user message inline — replaces content, deletes assistant children */
export async function editUserMessageInline(
  messageId: string,
  newContent: string
): Promise<MessageNode> {
  return executeCommand<MessageNode>("edit_user_message_inline", {
    messageId,
    newContent,
  });
}
// ============================================================================

/**
 * Start a provider-backed model stream and forward normalized events through a
 * Tauri Channel.
 */
export async function startModelStream(
  input: StartModelStreamInput,
  onEvent: (event: ModelStreamEvent) => void
): Promise<void> {
  if (shouldUseBrowserDebugRuntime()) {
    return startBrowserDebugModelStream(input, onEvent);
  }

  const channel = new Channel<ModelStreamEvent>(onEvent);
  return cmd(invoke("start_model_stream", { input, channel }), "start_model_stream");
}

/** Request cancellation of an active backend model stream. */
export async function abortModelStream(requestId: string): Promise<void> {
  if (shouldUseBrowserDebugRuntime()) {
    return abortBrowserDebugModelStream(requestId);
  }

  return cmd(invoke("abort_model_stream", { requestId }), "abort_model_stream");
}

// ============================================================================
// Debug Commands — Dev-only, not for production UI
// ============================================================================

/** Run all database invariant checks. Returns structured violation report. */
export async function checkDbInvariants(): Promise<InvariantCheckResult> {
  return executeCommand<InvariantCheckResult>("check_db_invariants");
}
