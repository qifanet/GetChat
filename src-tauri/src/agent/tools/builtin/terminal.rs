/**
 * @file agent/tools/builtin/terminal.rs
 * @description `terminal` tool with passive timeout detection (idle vs total
 * runtime limits instead of hard kills). Verbatim relocation from
 * services/tool_executor.rs (M2.1).
 */

use std::path::PathBuf;
use std::process::Stdio;

use serde_json::{json, Value};

use crate::agent::tools::executor::{BuiltinToolExecutor, ToolExecutionContext, ToolExecutionResult};
use crate::agent::tools::registry::{ToolConcurrency, ToolMeta, ToolRisk};
use crate::dto::common::{ToolDefinitionDto, ToolFunctionDefDto};

pub(crate) fn register(executor: &mut BuiltinToolExecutor) {
    let definition = ToolDefinitionDto {
        tool_type: "function".to_string(),
        function: ToolFunctionDefDto {
            name: "terminal".to_string(),
            description: "Execute a shell command in the workspace directory. THIS IS A POWERFUL TOOL that requires user approval. The command runs with the user's configured shell (default: system shell). Use this for any command-line operation: listing files, running scripts, installing packages, git operations, creating/deleting files/directories, etc.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30, max: 600)"
                    }
                },
                "required": ["command"]
            }),
        },
    };

    const META: ToolMeta = ToolMeta {
        risk: ToolRisk::High,
        concurrency: ToolConcurrency::Exclusive,
        max_output_chars: 100_000,
        timeout_secs: 600,
    };

    executor.register_async(definition, META, |args, context| {
        Box::pin(terminal_handler(args, context))
    });
}

async fn terminal_handler(args: Value, context: ToolExecutionContext) -> ToolExecutionResult {
    let command = match args.get("command").and_then(Value::as_str) {
        Some(c) => c.trim(),
        None => return ToolExecutionResult { success: false, output: "Missing required parameter: command".to_string() },
    };
    if command.is_empty() {
        return ToolExecutionResult { success: false, output: "Command cannot be empty".to_string() };
    }

    let requested_timeout = args.get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .min(600);

    // Resolve working directory
    let working_dir = context.workspace_path.as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        });

    // Resolve shell: prefer user-configured shell_path, fallback to system default
    let shell = context.shell_path.clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(get_default_shell);

    // Passive timeout detection: instead of hard-killing the process,
    // check at each timeout boundary whether it's still producing output.
    // If active (producing new output), extend the deadline.
    let result = run_shell_with_passive_timeout(
        &shell, command, &working_dir, requested_timeout,
    ).await;

    result
}

/// Run a shell command with passive timeout detection.
///
/// Instead of killing the process at the timeout boundary, this checks whether
/// the process is still producing output. If it is, the deadline is extended.
/// Maximum total runtime is capped at 600s to prevent infinite runs.
async fn run_shell_with_passive_timeout(
    shell: &str,
    command: &str,
    working_dir: &std::path::Path,
    initial_timeout_secs: u64,
) -> ToolExecutionResult {
    let _max_total_secs: u64 = 600;

    // Determine how to invoke the shell
    let (program, args) = if shell.ends_with("cmd.exe") || shell.ends_with("cmd") {
        (shell.to_string(), vec!["/C".to_string(), command.to_string()])
    } else if shell.ends_with("powershell.exe")
        || shell.ends_with("pwsh.exe")
        || shell.ends_with("pwsh")
        || shell.ends_with("powershell")
    {
        (shell.to_string(), vec!["-NoProfile".to_string(), "-Command".to_string(), command.to_string()])
    } else {
        (shell.to_string(), vec!["-c".to_string(), command.to_string()])
    };

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args)
        .current_dir(working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ToolExecutionResult {
                success: false,
                output: format!("Failed to execute command: {e}\nShell: {program}"),
            };
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Streaming read with passive timeout and output activity tracking
    const MAX_OUTPUT_BYTES: usize = 100_000;
    const OUTPUT_IDLE_THRESHOLD_SECS: u64 = 30;
    const MAX_TOTAL_SECS: u64 = 600;

    let mut total_output = String::new();
    let mut truncated = false;
    let start = std::time::Instant::now();
    let mut last_output_at = std::time::Instant::now();
    let mut deadline_exts = 0u32;

    // Merge stdout and stderr into a single line stream via a channel
    let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(256);

    // Spawn reader tasks for stdout and stderr
    if let Some(out) = stdout {
        let tx = line_tx.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(out);
            let mut lines = reader.lines();
            while let Some(line) = lines.next_line().await.transpose() {
                if tx.send(line).await.is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = stderr {
        let tx = line_tx.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(err);
            let mut lines = reader.lines();
            while let Some(line) = lines.next_line().await.transpose() {
                if tx.send(line).await.is_err() {
                    break;
                }
            }
        });
    }
    // Drop the original sender so line_rx gets None when all readers finish
    drop(line_tx);

    // Initial deadline
    let deadline_duration = std::time::Duration::from_secs(initial_timeout_secs.min(MAX_TOTAL_SECS));
    let mut deadline = tokio::time::Instant::now() + deadline_duration;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let sleep = tokio::time::sleep(remaining);

        tokio::select! {
            line_result = line_rx.recv() => {
                match line_result {
                    Some(Ok(line)) => {
                        if !total_output.is_empty() {
                            total_output.push('\n');
                        }
                        if total_output.len() + line.len() < MAX_OUTPUT_BYTES {
                            total_output.push_str(&line);
                        } else if !truncated {
                            truncated = true;
                        }
                        last_output_at = std::time::Instant::now();
                    }
                    Some(Err(_)) => {
                        // IO error on one of the readers, continue draining
                    }
                    None => {
                        // All readers finished — check if process actually exited
                        match child.try_wait() {
                            Ok(Some(_)) => break, // process exited, safe to break
                            Ok(None) => {
                                // Readers hit EOF but process still alive — keep waiting
                                // with a short timeout so we don't hang forever
                                continue;
                            }
                            Err(_) => {
                                let _ = child.kill().await;
                                break;
                            }
                        }
                    }
                }
            }
            _ = sleep => {
                // Deadline reached — decide whether to extend or kill
                let elapsed = start.elapsed().as_secs();
                let idle_secs = last_output_at.elapsed().as_secs();

                match child.try_wait() {
                    Ok(Some(_)) => {
                        // Process already exited, drain remaining lines
                        loop {
                            match line_rx.try_recv() {
                                Ok(Ok(line)) => {
                                    if !total_output.is_empty() {
                                        total_output.push('\n');
                                    }
                                    if total_output.len() + line.len() < MAX_OUTPUT_BYTES {
                                        total_output.push_str(&line);
                                    } else if !truncated {
                                        truncated = true;
                                    }
                                }
                                _ => break,
                            }
                        }
                        break;
                    }
                    Ok(None) => {
                        // Still running — check activity
                        if elapsed >= MAX_TOTAL_SECS {
                            tracing::warn!(elapsed_secs = elapsed, "terminal: hard total timeout, killing");
                            let _ = child.kill().await;
                            total_output.push_str(&format!(
                                "\n\n[Process killed after {}s (total runtime limit)]",
                                elapsed
                            ));
                            break;
                        }
                        if idle_secs >= OUTPUT_IDLE_THRESHOLD_SECS {
                            tracing::warn!(
                                elapsed_secs = elapsed,
                                idle_secs,
                                "terminal: idle timeout, killing"
                            );
                            let _ = child.kill().await;
                            total_output.push_str(&format!(
                                "\n\n[Process killed after {}s ({}s idle)]",
                                elapsed, idle_secs
                            ));
                            break;
                        }
                        // Still producing output — extend deadline
                        let ext_secs = (initial_timeout_secs / 2).max(60).min(120);
                        deadline_exts += 1;
                        deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(ext_secs);
                        tracing::info!(
                            elapsed_secs = elapsed,
                            ext_secs,
                            deadline_exts,
                            "terminal: active output, extending deadline"
                        );
                    }
                    Err(_) => {
                        let _ = child.kill().await;
                        break;
                    }
                }
            }
        }
    }

    if truncated {
        total_output.push_str("\n... (output truncated at 100KB)");
    }

    // Wait for process exit if not already done
    let exit_status: Option<std::process::ExitStatus> = child.wait().await.ok();

    let success = exit_status.map_or(false, |s: std::process::ExitStatus| s.success());
    ToolExecutionResult { success, output: total_output }
}

fn get_default_shell() -> String {
    // Default shells per platform
    if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}
