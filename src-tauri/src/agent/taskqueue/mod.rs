/**
 * @file agent/taskqueue/mod.rs
 * @description Event-driven background task scheduler (v1.5.0 M4).
 *
 * Owns the QUEUED -> RUNNING -> COMPLETED/FAILED/PAUSED/CANCELLED state
 * machine for `task_queue` rows. Replaces the prototype
 * `services/task_worker.rs` poller with:
 *
 *   - a `Notify`-driven event loop (no fixed-interval polling; a task enqueued
 *     while the scheduler idles wakes it immediately, and a PAUSED wake-up
 *     schedules a precise sleep);
 *   - startup recovery (RUNNING rows from a crashed session return to QUEUED
 *     with `attempts + 1`; PAUSED rows whose `next_run_at` passed resume);
 *   - per-conversation exclusivity enforced in SQL (`claim_due` refuses a
 *     conversation that already has a RUNNING task) so two parallel-fork tasks
 *     in the same conversation serialize while different conversations truly
 *     run in parallel;
 *   - 429 rate-limit handling: `MODEL_RATE_LIMITED` failures pause the task
 *     until the provider-advertised `Retry-After` (default 30s) instead of
 *     failing it outright, up to `MAX_TASK_ATTEMPTS`.
 *
 * Task execution drives a full agent stream session server-side: the scheduler
 * builds the prompt, resolves the model request, and feeds `run_react_loop`
 * through a server-created `Channel` -- the frontend only observes via
 * `task_stream_event` / `task_queue_changed` emissions. Progress is folded
 * into `config_json.progress` by the repository so list_task_queue reflects it.
 */

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use sqlx::SqlitePool;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{watch, Mutex, Notify};

use crate::agent::deps::{CompressionBackend, McpBackend, ReactLoopDeps, StreamBackend};
use crate::agent::runner::{run_react_loop, ReactLoopOutcome};
use crate::dto::messages::{
    BuildPromptMessagesInput, CompleteAssistantMessageInput, ContentBlockDto,
    FailAssistantMessageInput, ToolCallResultInput,
};
use crate::dto::streaming::{ModelPromptMessageDto, ModelStreamEventDto, StartModelStreamInput};
use crate::repositories::task_queue::{TaskQueueRepository, TaskQueueRow};
use crate::services::model_stream_service::{self, ModelStreamFailure};
use crate::services::snapshot_service;
use crate::state::{ActiveModelStream, AppState};

/** Default backoff when the provider sends no parseable `Retry-After`. */
const DEFAULT_RATE_LIMIT_RETRY_SECS: u64 = 30;

/** Give up on a task after this many attempts (startup recoveries + backoffs). */
const MAX_TASK_ATTEMPTS: i64 = 5;

/** Fallback wake-up cadence when nothing is scheduled (safety net). */
const IDLE_POLL_SECS: i64 = 30;

/** app_kv key for the global concurrency cap. */
const MAX_PARALLEL_KEY: &str = "task_queue.max_parallel";

/**
 * Accumulates the stream server-side exactly like the frontend stream
 * controller does, so the final `complete_assistant_message` payload matches
 * what an interactive stream would have persisted.
 */
#[derive(Default)]
struct StreamAccumulator {
    current_text: String,
    text: String,
    blocks: Vec<ContentBlockDto>,
    tool_calls: Vec<ToolCallResultInput>,
}

impl StreamAccumulator {
    fn flush_text(&mut self) {
        if !self.current_text.is_empty() {
            self.blocks.push(ContentBlockDto::Text {
                content: std::mem::take(&mut self.current_text),
            });
        }
    }

    fn absorb(&mut self, event: &ModelStreamEventDto) {
        match event {
            ModelStreamEventDto::Chunk { chunk, .. } => {
                self.current_text.push_str(chunk);
                self.text.push_str(chunk);
            }
            ModelStreamEventDto::ToolCall {
                call_id,
                function_name,
                arguments,
                ..
            } => {
                self.flush_text();
                self.blocks.push(ContentBlockDto::ToolCall {
                    call_id: call_id.clone(),
                    function_name: function_name.clone(),
                    args: arguments.clone(),
                });
                self.tool_calls.push(ToolCallResultInput {
                    call_id: call_id.clone(),
                    function_name: function_name.clone(),
                    arguments_json: arguments.clone(),
                    result_json: String::new(),
                    status: "PENDING".to_string(),
                    error_message: None,
                });
            }
            ModelStreamEventDto::ToolResult {
                call_id,
                result,
                success,
                ..
            } => {
                self.flush_text();
                self.blocks.push(ContentBlockDto::ToolResult {
                    call_id: call_id.clone(),
                    result: result.clone(),
                    success: *success,
                });
                if let Some(entry) = self.tool_calls.iter_mut().find(|tc| &tc.call_id == call_id) {
                    entry.result_json = result.clone();
                    entry.status = if *success { "COMPLETED" } else { "FAILED" }.to_string();
                    entry.error_message = if *success { None } else { Some(result.clone()) };
                }
            }
            ModelStreamEventDto::UserInjected { content, .. } => {
                self.flush_text();
                self.blocks.push(ContentBlockDto::UserInjected {
                    content: content.clone(),
                });
            }
            _ => {}
        }
    }

    /** Snapshot for the final persistence payload. */
    fn snapshot(&self) -> StreamAccumulator {
        StreamAccumulator {
            current_text: String::new(),
            text: self.text.clone(),
            blocks: self.blocks.clone(),
            tool_calls: self.tool_calls.clone(),
        }
    }

    /// Finalize ordered blocks (flush any trailing text run).
    fn into_parts(
        mut self,
    ) -> (
        String,
        Option<Vec<ContentBlockDto>>,
        Option<Vec<ToolCallResultInput>>,
    ) {
        self.flush_text();
        let blocks = if self.blocks.is_empty() { None } else { Some(self.blocks) };
        let tool_calls = if self.tool_calls.is_empty() {
            None
        } else {
            Some(self.tool_calls)
        };
        (self.text, blocks, tool_calls)
    }
}

/** Parsed `config_json` contract shared with `execute_parallel_fork`. */
struct TaskConfig {
    branch_id: String,
    assistant_message_id: String,
    user_message_id: String,
    request_id: String,
    provider_id: String,
    model_id: String,
}

impl TaskConfig {
    fn parse(config: &serde_json::Value) -> Result<Self, String> {
        let field = |name: &str| -> Result<String, String> {
            config
                .get(name)
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .ok_or_else(|| format!("task config missing `{name}`"))
        };
        Ok(Self {
            branch_id: field("branch_id")?,
            assistant_message_id: field("assistant_message_id")?,
            user_message_id: field("user_message_id")?,
            request_id: field("request_id")?,
            provider_id: field("provider_id")?,
            model_id: field("model_id")?,
        })
    }
}

/**
 * Event-driven scheduler. Cloned into every spawned worker; shared state is
 * either SQL (source of truth) or the small in-flight cancel registry.
 */
pub(crate) struct TaskQueueScheduler {
    pool: SqlitePool,
    app_handle: Mutex<Option<AppHandle>>,
    notify: Notify,
    /// task_id -> cancel sender for in-flight (RUNNING) task streams.
    running: Mutex<HashMap<String, watch::Sender<bool>>>,
    max_parallel: AtomicUsize,
}

impl TaskQueueScheduler {
    pub(crate) fn new(pool: SqlitePool) -> Arc<Self> {
        Arc::new(Self {
            pool,
            app_handle: Mutex::new(None),
            notify: Notify::new(),
            running: Mutex::new(HashMap::new()),
            max_parallel: AtomicUsize::new(1),
        })
    }

    /**
     * Attach the app handle and start the loop. Performs startup recovery
     * before the first tick: rows left RUNNING by a crashed session return to
     * QUEUED (attempts + 1), expired PAUSED rows resume.
     */
    pub(crate) async fn spawn(self: &Arc<Self>, app_handle: AppHandle) {
        *self.app_handle.lock().await = Some(app_handle.clone());

        if let Ok(recovered) = TaskQueueRepository::reset_running_for_startup(&self.pool).await {
            tracing::info!(recovered, "taskqueue: startup recovery of RUNNING tasks");
        }
        if let Ok(resumed) = TaskQueueRepository::resume_due_paused(&self.pool, now_secs()).await {
            if resumed > 0 {
                tracing::info!(resumed, "taskqueue: resumed expired PAUSED tasks");
            }
        }

        // Concurrency cap is a plain app_kv setting; default 1 (serial), higher
        // values unlock cross-conversation parallel execution.
        let max_parallel = crate::repositories::app_kv::get(&self.pool, MAX_PARALLEL_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|raw| {
                serde_json::from_str::<usize>(&raw)
                    .or_else(|_| raw.parse::<usize>())
                    .ok()
            })
            .filter(|value| *value >= 1)
            .unwrap_or(1);
        self.max_parallel.store(max_parallel, Ordering::Relaxed);
        tracing::info!(max_parallel, "taskqueue: scheduler started");

        let scheduler = self.clone();
        tauri::async_runtime::spawn(async move {
            scheduler.run_loop().await;
        });
    }

    /** Wake the loop (new task enqueued or cancelled). */
    pub(crate) fn notify_changes(&self) {
        self.notify.notify_one();
    }

    /**
     * Nudge the scheduler after a command inserted QUEUED rows. Row creation
     * stays in the command layer so it can share transactions with sibling
     * writes (branch + placeholder + task row).
     */
    pub(crate) async fn enqueue(&self, task_id: &str) {
        tracing::info!(task_id, "taskqueue: task enqueued");
        self.notify_changes();
    }

    /**
     * Cancel a task. RUNNING tasks get their stream cancelled (the worker then
     * marks the row CANCELLED); QUEUED/PAUSED rows are cancelled in place.
     * Returns false when the task is not in a cancellable state.
     */
    pub(crate) async fn cancel(&self, task_id: &str) -> Result<bool, crate::error::AppError> {
        let sender = self.running.lock().await.get(task_id).cloned();
        match sender {
            Some(tx) => {
                let _ = tx.send(true);
                tracing::info!(task_id, "taskqueue: cancel signal sent to running task");
                Ok(true)
            }
            None => {
                let cancelled = TaskQueueRepository::cancel(&self.pool, task_id).await?;
                if cancelled {
                    self.emit_changed(Some(task_id)).await;
                }
                Ok(cancelled)
            }
        }
    }

    /// Emit `task_queue_changed` so open panels refresh their list.
    async fn emit_changed(&self, task_id: Option<&str>) {
        let handle = self.app_handle.lock().await;
        if let Some(app) = handle.as_ref() {
            let _ = app.emit(
                "task_queue_changed",
                serde_json::json!({ "taskId": task_id }),
            );
        }
    }

    /// Main loop: sleep until notified or the next scheduled wake, then run.
    async fn run_loop(self: Arc<Self>) {
        loop {
            let next_wake = self.next_wake_delay().await;
            let timer = tokio::time::sleep(next_wake);
            tokio::select! {
                _ = self.notify.notified() => {}
                _ = timer => {}
            }
            if let Err(error) = self.clone().run_due_tasks().await {
                tracing::warn!(error = %error, "taskqueue: tick failed");
                // Avoid a hot loop on a persistent claim error.
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }

    /// Duration until the earliest scheduled PAUSED wake-up (or idle poll).
    async fn next_wake_delay(&self) -> Duration {
        let next: Option<i64> = sqlx::query_scalar(
            "SELECT MIN(next_run_at) FROM task_queue \
             WHERE status = 'PAUSED' AND next_run_at IS NOT NULL",
        )
        .fetch_optional(&self.pool)
        .await
        .ok()
        .flatten();

        match next {
            Some(at) => {
                let delta = (at - now_secs()).clamp(0, IDLE_POLL_SECS);
                Duration::from_secs(delta as u64)
            }
            None => Duration::from_secs(IDLE_POLL_SECS as u64),
        }
    }

    /// Resume expired backoffs, then claim and spawn due tasks up to the cap.
    async fn run_due_tasks(self: Arc<Self>) -> Result<(), crate::error::AppError> {
        let _ = TaskQueueRepository::resume_due_paused(&self.pool, now_secs()).await?;

        loop {
            let in_flight = self.running.lock().await.len();
            if in_flight >= self.max_parallel.load(Ordering::Relaxed) {
                break;
            }
            let Some(task) = TaskQueueRepository::claim_due(&self.pool, now_secs()).await? else {
                break;
            };

            // Create the cancel channel here so the in-flight count is exact
            // before the spawned worker starts (claim loop is sequential).
            let (cancel_tx, cancel_rx) = watch::channel(false);
            self.running.lock().await.insert(task.id.clone(), cancel_tx);

            let scheduler = self.clone();
            let task_id = task.id.clone();
            tauri::async_runtime::spawn(async move {
                scheduler.settle_task(task, cancel_rx).await;
                // settle_task also removes the slot; this catches panics.
                scheduler.running.lock().await.remove(&task_id);
            });
        }

        self.emit_changed(None).await;
        Ok(())
    }

    /**
     * Drive one task's full agent stream session, then persist the outcome.
     * Every expected path (completed / cancelled / backoff paused / failed)
     * leaves both the task row and the assistant placeholder in a consistent
     * state; `Err` is reserved for unexpected internal errors.
     */
    async fn settle_task(&self, task: TaskQueueRow, cancel_rx: watch::Receiver<bool>) {
        let task_id = task.id.clone();
        match self.drive_task_stream(&task, cancel_rx).await {
            Ok(()) => {
                tracing::info!(task_id = %task_id, "taskqueue: task settled");
            }
            Err(error) => {
                tracing::error!(task_id = %task_id, error = %error, "taskqueue: task crashed");
                let _ = TaskQueueRepository::mark_failed(&self.pool, &task_id, &error).await;
            }
        }
        self.emit_changed(Some(&task_id)).await;
    }

    /** Build + run the stream session for one task row. */
    async fn drive_task_stream(
        &self,
        task: &TaskQueueRow,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let app = self
            .app_handle
            .lock()
            .await
            .clone()
            .ok_or_else(|| "app handle unavailable".to_string())?;
        let app_state = app.state::<AppState>();
        let state: &AppState = app_state.inner();

        let config: serde_json::Value = serde_json::from_str(&task.config_json)
            .map_err(|error| format!("corrupt task config: {error}"))?;
        let cfg = TaskConfig::parse(&config)?;

        // 1. Prompt for everything up to and including the fork user message.
        let skills_dir = state
            .app_handle
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| {
                crate::services::skill_fs::skills_root_from_app_data(&dir)
                    .to_string_lossy()
                    .to_string()
            });
        let prompt_input = BuildPromptMessagesInput {
            conversation_id: task.conversation_id.clone(),
            up_to_message_id: cfg.user_message_id.clone(),
            max_tokens_budget: None,
            branch_id: Some(cfg.branch_id.clone()),
            skills_dir,
            activated_skill: None,
        };
        let prompt =
            crate::services::prompt_service::build_prompt_messages(&state.db, &prompt_input)
                .await
                .map_err(|error| format!("build prompt failed: {error:?}"))?;
        let prompt_messages: Vec<ModelPromptMessageDto> = prompt
            .into_iter()
            .map(|message| ModelPromptMessageDto {
                source_message_id: message.source_message_id,
                role: message.role,
                content: message.content,
                reasoning_content: message.reasoning_content,
                tool_calls: message.tool_calls,
                tool_call_id: message.tool_call_id,
                name: message.name,
            })
            .collect();

        let tools =
            crate::commands::streaming::build_backend_enabled_tool_definitions(state).await;
        let stream_input = StartModelStreamInput {
            request_id: cfg.request_id.clone(),
            provider_id: cfg.provider_id.clone(),
            model_id: cfg.model_id.clone(),
            prompt_messages,
            generation_params: None,
            tools,
            tool_choice: Some("auto".to_string()),
            conversation_id: Some(task.conversation_id.clone()),
            branch_id: Some(cfg.branch_id.clone()),
            activated_skill: None,
        };

        let resolved = model_stream_service::resolve_stream_request(
            &state.db,
            state.key_store.as_ref(),
            &stream_input,
        )
        .await
        .map_err(|failure| format!("{}: {}", failure.code, failure.message))?;

        // 2. Register the session + stream lock so injects, approvals and
        //    aborts behave exactly like an interactive stream. The cancel
        //    sender is the same channel `cancel()` signals.
        let session = crate::agent::session::new_shared_session();
        state
            .agent_sessions
            .lock()
            .await
            .insert(cfg.request_id.clone(), session.clone());
        let task_cancel_tx = self
            .running
            .lock()
            .await
            .get(&task.id)
            .cloned()
            .ok_or_else(|| "task cancelled before start".to_string())?;
        state.active_model_streams.lock().await.insert(
            cfg.request_id.clone(),
            ActiveModelStream {
                conversation_id: Some(task.conversation_id.clone()),
                cancel: task_cancel_tx,
            },
        );

        // 3. Server-side channel: parse events, accumulate the final payload,
        //    forward to the frontend and record progress.
        let accumulator = Arc::new(StdMutex::new(StreamAccumulator::default()));
        let event_app = app.clone();
        let envelope = serde_json::json!({
            "taskId": task.id,
            "conversationId": task.conversation_id,
            "branchId": cfg.branch_id,
            "requestId": cfg.request_id,
            "assistantMessageId": cfg.assistant_message_id,
        });
        let progress_pool = state.db.clone();
        let progress_task_id = task.id.clone();
        let progress_accumulator = accumulator.clone();
        let stream_accumulator = accumulator.clone();
        type TaskEventChannel = Channel<ModelStreamEventDto>;
        let channel = TaskEventChannel::new(
            move |body: InvokeResponseBody| {
            let raw = match body {
                InvokeResponseBody::Json(text) => text,
                InvokeResponseBody::Raw(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => text,
                    Err(_) => return Ok(()),
                },
            };
            let Ok(event) = serde_json::from_str::<ModelStreamEventDto>(&raw) else {
                return Ok(());
            };
            {
                let mut acc = stream_accumulator
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                acc.absorb(&event);
            }
            let is_tool_result = matches!(event, ModelStreamEventDto::ToolResult { .. });
            let _ = event_app.emit(
                "task_stream_event",
                serde_json::json!({ "context": envelope.clone(), "event": event }),
            );
            if is_tool_result {
                let pool = progress_pool.clone();
                let task_id = progress_task_id.clone();
                let acc = progress_accumulator.clone();
                tauri::async_runtime::spawn(async move {
                    let done = acc
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .tool_calls
                        .len();
                    let _ = TaskQueueRepository::update_progress(
                        &pool,
                        &task_id,
                        serde_json::json!({
                            "phase": "TOOLS_RUNNING",
                            "toolCallsDone": done,
                        }),
                    )
                    .await;
                });
            }
            Ok(())
            },
        );

        let deps = ReactLoopDeps {
            db: state.db.clone(),
            tool_executor: state.tool_executor.clone(),
            tool_definitions: stream_input.tools.clone(),
            security_policy: state.security_policy.clone(),
            pending_approvals: state.pending_approvals.clone(),
            app_data_dir: state.app_handle.path().app_data_dir().ok(),
            mcp: McpBackend::Real(state.mcp_manager.clone()),
            stream: StreamBackend::Real,
            compression: CompressionBackend::Real(state),
            session,
        };
        let tool_limits = state.tool_limits.lock().await.clone();

        let _ = TaskQueueRepository::update_progress(
            &state.db,
            &task.id,
            serde_json::json!({ "phase": "STREAMING", "toolCallsDone": 0 }),
        )
        .await;

        let result = run_react_loop(
            &deps,
            resolved,
            &channel,
            cancel_rx,
            tool_limits.max_iterations,
            tool_limits.max_consecutive_failures,
            tool_limits.approval_timeout_secs,
            tool_limits.tool_execution_timeout_secs,
        )
        .await;

        // 4. Unregister session + stream lock on every path.
        state.agent_sessions.lock().await.remove(&cfg.request_id);
        state.active_model_streams.lock().await.remove(&cfg.request_id);

        // 5. Snapshot the accumulated stream for the persistence payload.
        let (text, blocks, tool_calls) = {
            let guard = accumulator.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.snapshot().into_parts()
        };

        match result {
            Ok(ReactLoopOutcome::Completed {
                usage,
                reasoning_content,
            }) => {
                let usage_value = usage
                    .as_ref()
                    .and_then(|usage| serde_json::to_value(usage).ok());
                let complete_input = CompleteAssistantMessageInput {
                    message_id: cfg.assistant_message_id.clone(),
                    request_id: cfg.request_id.clone(),
                    content_text: text,
                    content_blocks: blocks,
                    usage: usage_value,
                    reasoning_content,
                    tool_calls,
                };
                let completed =
                    snapshot_service::complete_assistant_message(&state.db, &complete_input)
                        .await
                        .map_err(|error| {
                            format!("complete assistant message failed: {error:?}")
                        })?;
                let result_json = serde_json::json!({
                    "branchId": cfg.branch_id,
                    "assistantMessageId": completed.id,
                })
                .to_string();
                TaskQueueRepository::mark_completed(&self.pool, &task.id, &result_json)
                    .await
                    .map_err(|error| format!("{error:?}"))?;
                Ok(())
            }
            Ok(ReactLoopOutcome::Cancelled) => {
                let fail_input = FailAssistantMessageInput {
                    message_id: cfg.assistant_message_id.clone(),
                    request_id: cfg.request_id.clone(),
                    error_code: "TASK_CANCELLED".to_string(),
                    error_message: "Task cancelled by user".to_string(),
                    error_retriable: false,
                    partial_content_text: if text.is_empty() { None } else { Some(text) },
                    partial_content_blocks: blocks,
                    tool_calls,
                };
                if let Err(error) =
                    snapshot_service::fail_assistant_message(&state.db, &fail_input).await
                {
                    tracing::warn!(
                        task_id = %task.id,
                        error = ?error,
                        "taskqueue: cancel placeholder cleanup failed"
                    );
                }
                TaskQueueRepository::mark_cancelled(&self.pool, &task.id)
                    .await
                    .map_err(|error| format!("{error:?}"))?;
                Ok(())
            }
            Err(failure) => {
                self.handle_stream_failure(
                    task, &cfg, failure, text, blocks, tool_calls, &state.db,
                )
                .await
            }
        }
    }

    /** Route a stream failure to either a 429 backoff or a hard failure. */
    async fn handle_stream_failure(
        &self,
        task: &TaskQueueRow,
        cfg: &TaskConfig,
        failure: ModelStreamFailure,
        text: String,
        blocks: Option<Vec<ContentBlockDto>>,
        tool_calls: Option<Vec<ToolCallResultInput>>,
        db: &SqlitePool,
    ) -> Result<(), String> {
        let is_rate_limit = failure.code == "MODEL_RATE_LIMITED";
        if is_rate_limit && task.attempts < MAX_TASK_ATTEMPTS {
            let wait = failure
                .retry_after_secs
                .unwrap_or(DEFAULT_RATE_LIMIT_RETRY_SECS);
            let reason = format!("rate limited; retrying in {wait}s");
            TaskQueueRepository::pause_for_retry(
                &self.pool,
                &task.id,
                now_secs() + wait as i64,
                &reason,
            )
            .await
            .map_err(|error| format!("{error:?}"))?;
            tracing::warn!(
                task_id = %task.id,
                attempts = task.attempts + 1,
                wait_secs = wait,
                "taskqueue: rate limited, task paused for backoff"
            );
            return Ok(());
        }

        let fail_input = FailAssistantMessageInput {
            message_id: cfg.assistant_message_id.clone(),
            request_id: cfg.request_id.clone(),
            error_code: failure.code.clone(),
            error_message: failure.message.clone(),
            error_retriable: failure.retriable,
            partial_content_text: if text.is_empty() { None } else { Some(text) },
            partial_content_blocks: blocks,
            tool_calls,
        };
        if let Err(error) = snapshot_service::fail_assistant_message(db, &fail_input).await {
            tracing::warn!(
                task_id = %task.id,
                error = ?error,
                "taskqueue: fail placeholder cleanup failed"
            );
        }
        let error_text = format!("{}: {}", failure.code, failure.message);
        TaskQueueRepository::mark_failed(&self.pool, &task.id, &error_text)
            .await
            .map_err(|error| format!("{error:?}"))?;
        Ok(())
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
