/**
 * @file agent/eval/mock_provider.rs
 * @description Scripted model backend for golden replay tests (v1.5.0 M0).
 *
 * Implements the same contract as
 * `model_stream_service::stream_model_response` but replays a pre-registered
 * script: every call to [`ScriptedModel::respond`] pops the next
 * [`ScriptedStep`]. Each incoming request is recorded so tests can assert on
 * prompt composition (tool results, injected messages, guidance) after the
 * loop finishes.
 *
 * The scripted backend never touches the network, never needs API keys, and
 * behaves deterministically — the properties that make golden replay tests
 * usable as a refactor safety net (DEVELOPMENT.md M0 → M1–M4).
 */

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::dto::common::ToolCallDto;
use crate::dto::streaming::{ModelStreamEventDto, ModelPromptMessageDto};
use crate::services::model_stream_service::{
    ModelStreamFailure, ModelStreamOutcome, ResolvedModelStreamRequest,
};

/** One scripted model turn. The script is consumed in FIFO order. */
#[derive(Clone, Debug)]
#[allow(dead_code)] // constructed only by golden cases (cfg(test))
pub(crate) enum ScriptedStep {
    /// Emit `chunks` as Chunk events, then complete (finish_reason "stop").
    Text {
        chunks: Vec<String>,
        reasoning_content: Option<String>,
    },
    /// Return `ToolCallsRequested`, making the loop execute the tools.
    ToolCalls {
        calls: Vec<ScriptedToolCall>,
        reasoning_content: Option<String>,
    },
    /// Fail like a provider error. `retriable: true` drives the loop's retry
    /// backoff (combine with a paused tokio clock in tests).
    Failure {
        code: String,
        message: String,
        retriable: bool,
    },
}

/** A scripted tool call requested by the scripted model. */
#[derive(Clone, Debug)]
pub(crate) struct ScriptedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[allow(dead_code)] // golden-case helpers
impl ScriptedToolCall {
    /** Build a tool call with a deterministic auto-generated id. */
    pub fn new(name: &str, arguments: Value) -> Self {
        Self {
            id: format!("call_{}_{}", name, AUTO_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)),
            name: name.to_string(),
            arguments,
        }
    }

    /** Build a tool call with an explicit id (needed when a test must know
     * the id in advance, e.g. to answer an approval prompt). */
    pub fn with_id(id: &str, name: &str, arguments: Value) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            arguments,
        }
    }
}

static AUTO_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/** A model request captured by the harness for post-run assertions. */
#[derive(Clone, Debug)]
#[allow(dead_code)] // consumed only by golden cases (cfg(test))
pub(crate) struct RecordedRequest {
    pub prompt_messages: Vec<ModelPromptMessageDto>,
    pub tool_names: Vec<String>,
    pub tool_choice: Option<String>,
}

// Assertion helpers are consumed only by the golden cases (cfg(test)); the
// allow covers the whole impl so release builds stay warning-free.
#[allow(dead_code)]
impl RecordedRequest {
    /** All roles in prompt order, e.g. for asserting message sequence. */
    pub fn roles(&self) -> Vec<String> {
        self.prompt_messages.iter().map(|m| m.role.clone()).collect()
    }

    /** Concatenated content of every message with the given role. */
    pub fn content_for_role(&self, role: &str) -> String {
        self.prompt_messages
            .iter()
            .filter(|m| m.role.eq_ignore_ascii_case(role))
            .map(|m| m.content.clone())
            .collect::<Vec<_>>()
            .join("\n---\n")
    }

    /** Content of tool-result messages joined (role "tool"). */
    pub fn tool_results(&self) -> Vec<String> {
        self.prompt_messages
            .iter()
            .filter(|m| m.role == "tool")
            .map(|m| m.content.clone())
            .collect()
    }

    /** (tool_call_id, content) of every tool-result message, in prompt order —
     * used to assert tool_call_id pairing after parallel execution (M2.4). */
    pub fn tool_result_pairs(&self) -> Vec<(String, String)> {
        self.prompt_messages
            .iter()
            .filter(|m| m.role == "tool")
            .map(|m| {
                (
                    m.tool_call_id.clone().unwrap_or_default(),
                    m.content.clone(),
                )
            })
            .collect()
    }
}

/** Scripted model shared between the test and the loop under test. */
#[allow(dead_code)] // constructed only by golden cases (cfg(test))
pub(crate) struct ScriptedModel {
    steps: Mutex<VecDeque<ScriptedStep>>,
    recorded: Mutex<Vec<RecordedRequest>>,
}

#[allow(dead_code)] // golden-case entry points
impl ScriptedModel {
    /** Create a scripted model that serves `steps` in order. */
    pub(crate) fn new(steps: Vec<ScriptedStep>) -> Arc<Self> {
        Arc::new(Self {
            steps: Mutex::new(VecDeque::from(steps)),
            recorded: Mutex::new(Vec::new()),
        })
    }

    /** Snapshot of every request the loop sent to the model, in order. */
    pub(crate) fn recorded_requests(&self) -> Vec<RecordedRequest> {
        self.recorded.lock().expect("scripted model recorder").clone()
    }

    /** Internal: serve one request according to the script. */
    pub(crate) async fn respond(
        &self,
        request: &ResolvedModelStreamRequest,
        channel: &Channel<ModelStreamEventDto>,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<ModelStreamOutcome, ModelStreamFailure> {
        self.recorded
            .lock()
            .expect("scripted model recorder")
            .push(RecordedRequest {
                prompt_messages: request.prompt_messages.clone(),
                tool_names: request.tools.iter().map(|t| t.function.name.clone()).collect(),
                tool_choice: request.tool_choice.clone(),
            });

        if *cancel_rx.borrow() {
            return Ok(ModelStreamOutcome::Cancelled);
        }

        let step = self
            .steps
            .lock()
            .expect("scripted model steps")
            .pop_front();

        let Some(step) = step else {
            return Err(ModelStreamFailure {
                code: "SCRIPT_EXHAUSTED".to_string(),
                message: "Scripted model ran out of steps — the loop made more model calls than the script provides".to_string(),
                retriable: false,
            });
        };

        match step {
            ScriptedStep::Text {
                chunks,
                reasoning_content,
            } => {
                for chunk in chunks {
                    let _ = channel.send(ModelStreamEventDto::Chunk {
                        request_id: request.request_id.clone(),
                        chunk,
                    });
                }
                Ok(ModelStreamOutcome::Completed {
                    usage: None,
                    reasoning_content,
                })
            }
            ScriptedStep::ToolCalls {
                calls,
                reasoning_content,
            } => {
                let tool_calls = calls
                    .into_iter()
                    .map(|call| ToolCallDto {
                        id: call.id,
                        call_type: "function".to_string(),
                        function: crate::dto::common::ToolCallFunctionDto {
                            name: call.name,
                            arguments: call.arguments.to_string(),
                        },
                    })
                    .collect();
                Ok(ModelStreamOutcome::ToolCallsRequested {
                    tool_calls,
                    usage: None,
                    reasoning_content,
                })
            }
            ScriptedStep::Failure {
                code,
                message,
                retriable,
            } => Err(ModelStreamFailure {
                code,
                message,
                retriable,
            }),
        }
    }
}
