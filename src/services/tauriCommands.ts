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
  type SetBranchPreferredModelInput,
  type SetMainlineBranchInput,
  type SetMainlineResult,
  type CreateUserMessageInput,
  type DirectOverwriteUserMessageInput,
  type MessageNode,
  type CreateAssistantPlaceholderForBranchInput,
  type CreateAssistantVariantPlaceholderInput,
  type CompleteAssistantMessageInput,
  type FailAssistantMessageInput,
  type BuildPromptMessagesInput,
  type PromptMessage,
  type InvariantCheckResult,
  type ToolDefinitionDto,
  type DirectoryEntryDto,
  type FilePreviewDto,
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
      console.error(
        `[tauri] ${raw.code} ${commandName} (${duration}ms)`,
        raw.message,
        raw.details ? `details: ${raw.details}` : ""
      );
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

/** Get the helper model ID (used for AI title generation, summaries, etc.) */
export async function getHelperModel(): Promise<string | null> {
  return executeCommand<string | null>("get_helper_model");
}

/** Set the helper model ID. Pass null to clear. */
export async function setHelperModel(modelId: string | null): Promise<void> {
  return executeCommand<void>("set_helper_model", { modelId });
}

/** Get the app-wide system prompt used as the first prompt prefix. */
export async function getSystemPrompt(): Promise<string> {
  return executeCommand<string>("get_system_prompt");
}

/** Save the app-wide system prompt and return the normalized value. */
export async function setSystemPrompt(prompt: string): Promise<string> {
  return executeCommand<string>("set_system_prompt", { prompt });
}

// ============================================================================
// Close Behavior & Shell Path Settings
// ============================================================================

export type CloseBehavior = "exit" | "tray";

export async function getCloseBehavior(): Promise<CloseBehavior> {
  return executeCommand<CloseBehavior>("get_close_behavior");
}

export async function setCloseBehavior(behavior: CloseBehavior): Promise<CloseBehavior> {
  return executeCommand<CloseBehavior>("set_close_behavior", { behavior });
}

export async function getShellPath(): Promise<string> {
  return executeCommand<string>("get_shell_path");
}

export async function setShellPath(path: string): Promise<string> {
  return executeCommand<string>("set_shell_path", { path });
}

export async function detectShellPath(): Promise<string | null> {
  return executeCommand<string | null>("detect_shell_path");
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

export interface OllamaModelInfo {
  name: string;
  size: number | null;
  quantization: string | null;
}

/** Fetch available models from a running Ollama instance. */
export async function fetchOllamaModels(baseUrl: string): Promise<OllamaModelInfo[]> {
  return executeCommand<OllamaModelInfo[]>("fetch_ollama_models", { baseUrl });
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

/** Auto-generate a conversation title using the helper AI model */
export async function generateConversationTitle(
  conversationId: string
): Promise<{ title: string | null; skipReason: string | null } | null> {
  return executeCommand<{ title: string | null; skipReason: string | null } | null>("generate_conversation_title", {
    conversationId,
  });
}

/** Import conversations from external formats (ChatGPT, GetChat JSON) */
export async function importConversations(
  input: { format: string; jsonContent: string }
): Promise<{ importedCount: number; skippedCount: number; errors: string[] }> {
  return executeCommand<{ importedCount: number; skippedCount: number; errors: string[] }>(
    "import_conversations",
    { input }
  );
}

/** Set or clear the workspace directory path for file-system tools */
export async function setConversationWorkspace(
  conversationId: string,
  workspacePath: string | null
): Promise<void> {
  return executeCommand<void>("set_conversation_workspace", {
    conversationId,
    workspacePath,
  });
}

export interface TodoItemResult {
  id: string;
  content: string;
  status: string;
}

export async function readTodoItems(conversationId?: string): Promise<TodoItemResult[]> {
  return executeCommand<TodoItemResult[]>("read_todo_items", { conversationId });
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

/** Archive a branch (cannot archive the mainline branch). Returns the updated branch DTO. */
export async function archiveBranch(branchId: string): Promise<BranchEntity> {
  return executeCommand<BranchEntity>("archive_branch", { branchId });
}

/** Unarchive a branch. Returns the updated branch DTO. */
export async function unarchiveBranch(branchId: string): Promise<BranchEntity> {
  return executeCommand<BranchEntity>("unarchive_branch", { branchId });
}

export interface DeleteBranchResult {
  deletedBranchIds: string[];
  deletedMessageIds: string[];
  conversationId: string;
}

export async function deleteBranch(branchId: string): Promise<DeleteBranchResult> {
  return executeCommand<DeleteBranchResult>("delete_branch", { branchId });
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

/** Explicit destructive history-edit exception: mutate a USER node in place. */
export async function directOverwriteUserMessage(
  input: DirectOverwriteUserMessageInput
): Promise<MessageNode> {
  return executeCommand<MessageNode>("direct_overwrite_user_message", { input });
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
/** Delete a non-head leaf assistant variant. */
export async function deleteAssistantVariantMessage(messageId: string): Promise<void> {
  return executeCommand<void>("delete_assistant_variant_message", { messageId });
}

export interface SearchMessagesInput {
  query: string;
  conversationId?: string;
  limit?: number;
}

export interface SearchResultItem {
  messageId: string;
  conversationId: string;
  role: string;
  snippet: string;
  createdAt: number;
}

/** Search messages by keyword across all conversations or a specific one. */
export async function searchMessages(
  input: SearchMessagesInput
): Promise<SearchResultItem[]> {
  return executeCommand<SearchResultItem[]>("search_messages", { input });
}

export interface DiffSummaryResult {
  summary: string;
}

/** Generate an AI summary of the differences between two branches. */
export async function generateBranchDiffSummary(
  conversationId: string,
  leftBranchId: string,
  rightBranchId: string
): Promise<DiffSummaryResult | null> {
  return executeCommand<DiffSummaryResult | null>("generate_branch_diff_summary", {
    conversationId,
    leftBranchId,
    rightBranchId,
  });
}

// ============================================================================

/** Fetch all enabled tool definitions from the backend executor registry. */
export async function getEnabledToolDefinitions(): Promise<ToolDefinitionDto[]> {
  if (shouldUseBrowserDebugRuntime()) {
    return [];
  }
  return cmd(invoke<ToolDefinitionDto[]>("get_enabled_tool_definitions"), "get_enabled_tool_definitions");
}

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

/** Approve or reject a pending destructive tool action. */
export async function approveToolAction(
  approvalId: string,
  approved: boolean
): Promise<boolean> {
  return executeCommand<boolean>("approve_tool_action", {
    approvalId,
    approved,
  });
}

export interface ToolSettingsDto {
  max_iterations: number;
  max_consecutive_failures: number;
  approval_timeout_secs: number;
  tool_execution_timeout_secs: number;
}

export async function getToolSettings(): Promise<ToolSettingsDto> {
  return executeCommand<ToolSettingsDto>("get_tool_settings");
}

export async function updateToolSettings(params: {
  max_iterations?: number;
  max_consecutive_failures?: number;
  approval_timeout_secs?: number;
  tool_execution_timeout_secs?: number;
}): Promise<ToolSettingsDto> {
  const camelParams: Record<string, unknown> = {};
  if (params.max_iterations !== undefined) camelParams.maxIterations = params.max_iterations;
  if (params.max_consecutive_failures !== undefined) camelParams.maxConsecutiveFailures = params.max_consecutive_failures;
  if (params.approval_timeout_secs !== undefined) camelParams.approvalTimeoutSecs = params.approval_timeout_secs;
  if (params.tool_execution_timeout_secs !== undefined) camelParams.toolExecutionTimeoutSecs = params.tool_execution_timeout_secs;
  return executeCommand<ToolSettingsDto>("update_tool_settings", camelParams);
}

export interface ToolStateDto {
  name: string;
  description: string;
  enabled: boolean;
}

export async function getBuiltinToolStates(): Promise<ToolStateDto[]> {
  return executeCommand<ToolStateDto[]>("get_builtin_tool_states");
}

export async function setBuiltinToolEnabled(
  name: string,
  enabled: boolean
): Promise<boolean> {
  return executeCommand<boolean>("set_builtin_tool_enabled", { name, enabled });
}

// ============================================================================
// Security Policy Commands
// ============================================================================

export interface SecurityPolicyDto {
  level: "permissive" | "standard" | "strict";
  terminalBlacklist: string[];
  fileWriteBlacklist: string[];
}

export async function getSecurityPolicy(): Promise<SecurityPolicyDto> {
  return executeCommand<SecurityPolicyDto>("get_security_policy");
}

export async function updateSecurityPolicy(params: {
  level?: SecurityPolicyDto["level"];
  terminalBlacklist?: string[];
  fileWriteBlacklist?: string[];
}): Promise<SecurityPolicyDto> {
  return executeCommand<SecurityPolicyDto>("update_security_policy", params);
}

// ============================================================================
// MCP Server Management Commands
// ============================================================================

export interface McpServerConfig {
  transport?: "stdio" | "streamable_http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolDto {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerStateDto {
  name: string;
  transport: "stdio" | "streamable_http" | "sse";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  status: string;
  enabled: boolean;
  tools: McpToolDto[];
}

export interface AddMcpServerInput {
  name: string;
  config: McpServerConfig;
}

export async function listMcpServers(): Promise<McpServerStateDto[]> {
  return executeCommand<McpServerStateDto[]>("list_mcp_servers");
}

export async function addMcpServer(input: AddMcpServerInput): Promise<void> {
  return executeCommand<void>("add_mcp_server", { input });
}

export async function removeMcpServer(name: string): Promise<void> {
  return executeCommand<void>("remove_mcp_server", { name });
}

export async function setMcpServerEnabled(
  name: string,
  enabled: boolean
): Promise<boolean> {
  return executeCommand<boolean>("set_mcp_server_enabled", { name, enabled });
}

export async function getMcpConfigJson(): Promise<string> {
  return executeCommand<string>("get_mcp_config_json");
}

export async function saveMcpConfigJson(jsonContent: string): Promise<string> {
  return executeCommand<string>("save_mcp_config_json", { jsonContent });
}

export interface ContextTokenBreakdownDto {
  systemTokens: number;
  toolPromptTokens: number;
  userTokens: number;
  assistantTokens: number;
  toolTokens: number;
  compressedContextTokens: number;
}

export interface ContextStatusDto {
  /** Estimate of the actual next model request after prompt-budget trimming. */
  usedTokens: number;
  /** Untrimmed full-path estimate for diagnostics/compression decisions. */
  rawUsedTokens: number;
  totalTokens: number;
  percentage: number;
  rawPercentage: number;
  messageCount: number;
  rawMessageCount: number;
  promptBudgetTokens: number;
  breakdown: ContextTokenBreakdownDto;
}

export async function getContextStatus(
  conversationId: string,
  branchId: string,
  modelId: string
): Promise<ContextStatusDto> {
  return executeCommand<ContextStatusDto>("get_context_status", {
    conversationId,
    branchId,
    modelId,
  });
}

export interface CompressContextResult {
  compressedId: string;
  summaryText: string;
  compressedMessageCount: number;
  estimatedTokens: number;
  skipped: boolean;
  skipReason?: string;
}

export async function compressContext(
  conversationId: string,
  branchId: string,
  modelId: string
): Promise<CompressContextResult> {
  return executeCommand<CompressContextResult>("compress_context", {
    conversationId,
    branchId,
    modelId,
  });
}

export async function getMcpToolDefinitions(): Promise<ToolDefinitionDto[]> {
  return executeCommand<ToolDefinitionDto[]>("get_mcp_tool_definitions");
}

// ============================================================================
// Debug Commands — Dev-only, not for production UI
// ============================================================================

/** Run all database invariant checks. Returns structured violation report. */
export async function checkDbInvariants(): Promise<InvariantCheckResult> {
  return executeCommand<InvariantCheckResult>("check_db_invariants");
}

// ============================================================================
// Skills & Slash Commands
// ============================================================================

export interface SlashItemDto {
  itemType: string;
  name: string;
  displayName: string;
  description: string;
  argumentsJson: string;
  serverName?: string;
}

export async function listSlashItems(): Promise<SlashItemDto[]> {
  return executeCommand<SlashItemDto[]>("list_slash_items");
}

export async function executeMcpPrompt(
  serverName: string,
  promptName: string,
  argumentsJson: string
): Promise<string> {
  return executeCommand<string>("execute_mcp_prompt", {
    serverName,
    promptName,
    argumentsJson,
  });
}

export async function getSkillsDirectory(): Promise<string> {
  return executeCommand<string>("get_skills_directory");
}

// ============================================================================
// Filesystem Commands (v1.3.0)
// ============================================================================

export async function listDirectoryEntries(
  conversationId: string,
  dirPath: string,
): Promise<DirectoryEntryDto[]> {
  return executeCommand<DirectoryEntryDto[]>("list_directory_entries", {
    conversationId,
    dirPath,
  });
}

export async function readFilePreview(
  conversationId: string,
  filePath: string,
  maxLines?: number,
): Promise<FilePreviewDto> {
  return executeCommand<FilePreviewDto>("read_file_preview", {
    conversationId,
    filePath,
    maxLines: maxLines ?? undefined,
  });
}

export async function revealInFileManager(conversationId: string, path: string): Promise<void> {
  return executeCommand<void>("reveal_in_file_manager", { conversationId, path });
}

// ============================================================================
// Task Queue Commands (v1.5.0)
// ============================================================================

export async function listTaskQueue(): Promise<import("../types/taskQueue").TaskQueueItemDto[]> {
  return executeCommand("list_task_queue", {});
}

export async function cancelTask(taskId: string): Promise<void> {
  return executeCommand<void>("cancel_task", { taskId });
}

// ============================================================================
// Dual-Queue Injection (v1.5.0)
// ============================================================================

export async function injectUserMessageToStream(requestId: string, message: string): Promise<void> {
  return executeCommand<void>("inject_user_message_to_stream", { requestId, message });
}

// ============================================================================
// Proposal Commands (v1.5.0)
// ============================================================================

export async function getProposal(proposalId: string): Promise<import("./tauriTypes").ProposalDto | null> {
  return executeCommand("get_proposal", { proposalId });
}

export async function listProposals(conversationId: string): Promise<import("./tauriTypes").ProposalDto[]> {
  return executeCommand("list_proposals", { conversationId });
}

export async function executeParallelFork(
  proposalId: string,
  branches: import("./tauriTypes").ProposalBranchDto[]
): Promise<string[]> {
  return executeCommand("execute_parallel_fork", { proposalId, branches });
}
