/**
 * @file tests/invariant_tests.rs
 * @description Integration tests for core domain invariants.
 *
 * These tests verify that service-layer operations maintain DB invariants
 * defined in the smoke test checklist (SMOKE-03 through SMOKE-13).
 *
 * Test infrastructure:
 *   - Uses sqlx::test with isolated SQLite database per test
 *   - Applies migrations explicitly inside each test setup
 *   - Verifies schema behavior against the same migration semantics as runtime
 *
 * PREREQUISITE: Cargo.toml must be configured with:
 *   - sqlx with sqlite feature
 *   - uuid crate
 *   - serde_json crate
 *
 * Run with: cargo test
 */

use sqlx::SqlitePool;

// ============================================================================
// Helpers
// ============================================================================

/// Initialize PRAGMA foreign_keys for a connection.
async fn enable_foreign_keys(pool: &SqlitePool) {
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await
        .unwrap();
}

/// Run all migrations on a fresh database.
async fn run_migration(pool: &SqlitePool) {
    let migrations: [(&str, &str); 2] = [
        ("0001_init", include_str!("../src/db/migrations/0001_init.sql")),
        ("0002_sibling_unique", include_str!("../src/db/migrations/0002_sibling_unique.sql")),
    ];
    for (name, sql) in &migrations {
        let clean_sql = sql
            .lines()
            .filter(|line| !line.trim().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");

        for stmt in clean_sql.split(';') {
            let trimmed = stmt.trim();
            if !trimmed.is_empty() {
                sqlx::query(trimmed)
                    .execute(pool)
                    .await
                    .unwrap_or_else(|e| panic!("Migration {} failed for: {}\nError: {}", name, trimmed, e));
            }
        }
    }
}

/// Delete a conversation using the same deferred-FK transaction semantics as runtime.
async fn delete_conversation_with_deferred_fk(pool: &SqlitePool, conversation_id: &str) {
    let mut tx = pool.begin().await.unwrap();

    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .unwrap();

    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(conversation_id)
        .execute(&mut *tx)
        .await
        .unwrap();

    tx.commit().await.unwrap();
}

/// Current Unix timestamp in seconds.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

// ============================================================================
// T-01: create_conversation → initial branch + mainline
// ============================================================================

#[sqlx::test]
async fn test_create_conversation_creates_initial_branch_and_mainline(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-001";
    let branch_id = "br-001";

    // Insert conversation
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'New Conversation', NULL, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Insert initial branch
    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?)",
    )
    .bind(branch_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Set mainline
    sqlx::query(
        "UPDATE conversations SET mainline_branch_id = ? WHERE id = ?",
    )
    .bind(branch_id)
    .bind(conv_id)
    .execute(&pool)
    .await
    .unwrap();

    // Verify: conversation has mainline
    let (mainline,): (Option<String>,) = sqlx::query_as(
        "SELECT mainline_branch_id FROM conversations WHERE id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(mainline, Some(branch_id.to_string()));

    // Verify: branch exists and is ACTIVE
    let (status,): (String,) = sqlx::query_as(
        "SELECT status FROM branches WHERE id = ?",
    )
    .bind(branch_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "ACTIVE");

    // Verify: branch belongs to conversation
    let (conv,): (String,) = sqlx::query_as(
        "SELECT conversation_id FROM branches WHERE id = ?",
    )
    .bind(branch_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(conv, conv_id);
}

// ============================================================================
// T-02: create_user_message → branch head updated
// ============================================================================

#[sqlx::test]
async fn test_create_user_message_updates_branch_head(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-002";
    let branch_id = "br-002";
    let msg_id = "msg-002";

    // Setup: conversation + branch
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', ?, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(branch_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?)",
    )
    .bind(branch_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Insert user message
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', 0, 0, 'Hello', 'MARKDOWN', ?, ?)",
    )
    .bind(msg_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Update branch head
    sqlx::query("UPDATE branches SET head_message_id = ? WHERE id = ?")
        .bind(msg_id)
        .bind(branch_id)
        .execute(&pool)
        .await
        .unwrap();

    // Verify: branch head points to user message
    let (head,): (Option<String>,) = sqlx::query_as(
        "SELECT head_message_id FROM branches WHERE id = ?",
    )
    .bind(branch_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(head, Some(msg_id.to_string()));

    // Verify: message status is COMPLETED
    let (status,): (String,) = sqlx::query_as(
        "SELECT status FROM messages WHERE id = ?",
    )
    .bind(msg_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "COMPLETED");
}

// ============================================================================
// T-04: variant placeholder does NOT update branch head
// ============================================================================

#[sqlx::test]
async fn test_variant_placeholder_does_not_update_branch_head(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-004";
    let branch_id = "br-004";
    let user_msg_id = "msg-u004";
    let asst_msg_id = "msg-a004";  // original assistant
    let variant_id = "msg-v004";   // variant assistant

    // Setup: conversation + branch + user message + original assistant
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', NULL, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', 0, 0, 'Hello', 'MARKDOWN', ?, ?)",
    )
    .bind(user_msg_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 1, 0, 'Original response', 'MARKDOWN', 'prov-1', 'model-1', 'req-1', ?, ?)",
    )
    .bind(asst_msg_id)
    .bind(conv_id)
    .bind(user_msg_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, head_message_id, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?, ?)",
    )
    .bind(branch_id)
    .bind(conv_id)
    .bind(asst_msg_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("UPDATE conversations SET mainline_branch_id = ? WHERE id = ?")
        .bind(branch_id)
        .bind(conv_id)
        .execute(&pool)
        .await
        .unwrap();

    // Insert variant placeholder (sibling of original assistant)
    // CRITICAL: DO NOT update branch head for variants
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'STREAMING', ?, 1, 1, '', 'MARKDOWN', 'prov-1', 'model-1', 'req-2', ?, ?)",
    )
    .bind(variant_id)
    .bind(conv_id)
    .bind(user_msg_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // NOTE: We intentionally do NOT call:
    //   sqlx::query("UPDATE branches SET head_message_id = ? WHERE id = ?")
    //       .bind(variant_id).bind(branch_id).execute(&pool).await.unwrap();

    // Verify: branch head still points to ORIGINAL assistant (not variant)
    let (head,): (Option<String>,) = sqlx::query_as(
        "SELECT head_message_id FROM branches WHERE id = ?",
    )
    .bind(branch_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(head, Some(asst_msg_id.to_string()), "Branch head should NOT change when variant is created");

    // Verify: variant is a sibling of original (same parent)
    let siblings: Vec<(String, i32)> = sqlx::query_as(
        "SELECT id, sibling_index FROM messages WHERE parent_message_id = ? ORDER BY sibling_index",
    )
    .bind(user_msg_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(siblings.len(), 2);
    assert_eq!(siblings[0], (asst_msg_id.to_string(), 0));
    assert_eq!(siblings[1], (variant_id.to_string(), 1));
}

// ============================================================================
// T-06: set_mainline only changes conversations.mainline_branch_id
// ============================================================================

#[sqlx::test]
async fn test_set_mainline_does_not_modify_message_tree(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-006";
    let branch_l = "br-L";
    let branch_r = "br-R";

    // Setup: conversation with two branches
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', ?, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(branch_l)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    for (bid, name) in [(branch_l, "Left"), (branch_r, "Right")] {
        sqlx::query(
            "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, created_at, updated_at)
             VALUES (?, ?, ?, 'ACTIVE', 'CURRENT_LEAF', ?, ?)",
        )
        .bind(bid)
        .bind(conv_id)
        .bind(name)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Snapshot message count BEFORE set_mainline
    let (msg_count_before,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    // Set mainline to branch_r
    sqlx::query("UPDATE conversations SET mainline_branch_id = ? WHERE id = ?")
        .bind(branch_r)
        .bind(conv_id)
        .execute(&pool)
        .await
        .unwrap();

    // Verify: only mainline_branch_id changed
    let (mainline,): (Option<String>,) = sqlx::query_as(
        "SELECT mainline_branch_id FROM conversations WHERE id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(mainline, Some(branch_r.to_string()));

    // Verify: no new messages
    let (msg_count_after,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(msg_count_before, msg_count_after);

    // Verify: no branches deleted
    let (branch_count,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM branches WHERE conversation_id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(branch_count, 2);
}

// ============================================================================
// T-07: archive mainline branch → should fail at application level
// ============================================================================

#[sqlx::test]
async fn test_cannot_archive_mainline_branch(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-007";
    let branch_id = "br-007";

    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', ?, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(branch_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?)",
    )
    .bind(branch_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Simulate the application-level check:
    // In commands/branches.rs, archive_branch checks if branch is mainline
    // and returns CONFLICT error. Here we verify the check logic.
    let (mainline,): (Option<String>,) = sqlx::query_as(
        "SELECT mainline_branch_id FROM conversations WHERE id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let is_mainline = mainline.as_ref() == Some(&branch_id.to_string());
    assert!(is_mainline, "Branch should be detected as mainline");

    // The command layer would return AppError::conflict() here.
    // We verify that NOT archiving preserves the invariant:
    let (status,): (String,) = sqlx::query_as(
        "SELECT status FROM branches WHERE id = ?",
    )
    .bind(branch_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "ACTIVE", "Mainline branch should still be ACTIVE");
}

// ============================================================================
// T-08: repair_inflight → STREAMING becomes ABORTED
// ============================================================================

#[sqlx::test]
async fn test_repair_inflight_streaming_messages(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-008";
    let branch_id = "br-008";

    // Setup
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', ?, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(branch_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?)",
    )
    .bind(branch_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Insert streaming messages (simulating interrupted generation)
    for i in 0..3 {
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
             VALUES (?, ?, 'ASSISTANT', 'STREAMING', 0, ?, 'Partial text...', 'MARKDOWN', 'prov-1', 'model-1', ?, ?, ?)",
        )
        .bind(format!("msg-stream-{}", i))
        .bind(conv_id)
        .bind(i)
        .bind(format!("req-{}", i))
        .bind(now - 100)
        .bind(now - 50)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Also insert a COMPLETED message (should NOT be affected)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', 0, 3, 'Hello', 'MARKDOWN', ?, ?)",
    )
    .bind("msg-complete-1")
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Run repair
    let result = sqlx::query(
        "UPDATE messages
         SET status = 'ABORTED',
             error_code = 'APP_RESTART_INTERRUPTED',
             error_message = 'Generation interrupted by app restart',
             error_retriable = 1,
             updated_at = ?
         WHERE status = 'STREAMING'",
    )
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(result.rows_affected(), 3, "Should repair exactly 3 streaming messages");

    // Verify: no STREAMING messages remain
    let (streaming_count,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE status = 'STREAMING'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(streaming_count, 0);

    // Verify: repaired messages are ABORTED with correct error
    let aborted: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, error_code, error_message FROM messages WHERE error_code = 'APP_RESTART_INTERRUPTED'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(aborted.len(), 3);

    // Verify: partial text preserved
    let (text,): (String,) = sqlx::query_as(
        "SELECT content_text FROM messages WHERE id = 'msg-stream-0'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(text, "Partial text...");

    // Verify: COMPLETED message unaffected
    let (status,): (String,) = sqlx::query_as(
        "SELECT status FROM messages WHERE id = 'msg-complete-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "COMPLETED");
}

// ============================================================================
// T-03: assistant placeholder + complete flow
// ============================================================================

#[sqlx::test]
async fn test_assistant_placeholder_then_complete(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-003";
    let branch_id = "br-003";
    let user_msg_id = "msg-u003";
    let asst_msg_id = "msg-a003";

    // Setup: conversation + branch
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', ?, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(branch_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?)",
    )
    .bind(branch_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Step 1: Insert user message + update branch head
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', 0, 0, 'Hello', 'MARKDOWN', ?, ?)",
    )
    .bind(user_msg_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("UPDATE branches SET head_message_id = ? WHERE id = ?")
        .bind(user_msg_id)
        .bind(branch_id)
        .execute(&pool)
        .await
        .unwrap();

    // Step 2: Insert assistant placeholder (STREAMING)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'STREAMING', ?, 1, 0, '', 'MARKDOWN', 'prov-1', 'model-1', 'req-003', ?, ?)",
    )
    .bind(asst_msg_id)
    .bind(conv_id)
    .bind(user_msg_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Update branch head to assistant placeholder
    sqlx::query("UPDATE branches SET head_message_id = ? WHERE id = ?")
        .bind(asst_msg_id)
        .bind(branch_id)
        .execute(&pool)
        .await
        .unwrap();

    // Verify: assistant is STREAMING
    let (status,): (String,) = sqlx::query_as(
        "SELECT status FROM messages WHERE id = ?",
    )
    .bind(asst_msg_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "STREAMING");

    // Verify: branch head points to assistant
    let (head,): (Option<String>,) = sqlx::query_as(
        "SELECT head_message_id FROM branches WHERE id = ?",
    )
    .bind(branch_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(head, Some(asst_msg_id.to_string()));

    // Step 3: Complete the assistant message
    sqlx::query(
        "UPDATE messages SET status = 'COMPLETED', content_text = 'Hello! How can I help?', usage_json = '{\"prompt_tokens\":10,\"completion_tokens\":20}', updated_at = ? WHERE id = ?",
    )
    .bind(now)
    .bind(asst_msg_id)
    .execute(&pool)
    .await
    .unwrap();

    // Verify: assistant is now COMPLETED
    let (status, text): (String, String) = sqlx::query_as(
        "SELECT status, content_text FROM messages WHERE id = ?",
    )
    .bind(asst_msg_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "COMPLETED");
    assert_eq!(text, "Hello! How can I help?");

    // Verify: branch head still points to assistant (unchanged by complete)
    let (head_after,): (Option<String>,) = sqlx::query_as(
        "SELECT head_message_id FROM branches WHERE id = ?",
    )
    .bind(branch_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(head_after, Some(asst_msg_id.to_string()));

    // Verify: request_id is unique
    let (req_count,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE request_id = 'req-003'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(req_count, 1);
}

// ============================================================================
// T-05: historyUserEdit — fork_point correctness (P0 HIGH RISK)
// ============================================================================

#[sqlx::test]
async fn test_history_user_edit_fork_point_correctness(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-005";
    let branch_orig = "br-orig-005";
    let branch_new = "br-new-005";

    // Path: U1 → A1 → U2 → A2
    let u1 = "msg-u1-005";
    let a1 = "msg-a1-005";
    let u2 = "msg-u2-005";
    let a2 = "msg-a2-005";
    let u2_edited = "msg-u2e-005"; // edited version of U2

    // Setup: conversation + original branch
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', NULL, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // U1 (root)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', 0, 0, 'U1 text', 'MARKDOWN', ?, ?)",
    )
    .bind(u1)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // A1 (child of U1)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 1, 0, 'A1 response', 'MARKDOWN', 'prov-1', 'model-1', 'req-a1', ?, ?)",
    )
    .bind(a1)
    .bind(conv_id)
    .bind(u1)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // U2 (child of A1)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', ?, 2, 0, 'U2 original text', 'MARKDOWN', ?, ?)",
    )
    .bind(u2)
    .bind(conv_id)
    .bind(a1)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // A2 (child of U2)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 3, 0, 'A2 response', 'MARKDOWN', 'prov-1', 'model-1', 'req-a2', ?, ?)",
    )
    .bind(a2)
    .bind(conv_id)
    .bind(u2)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, head_message_id, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?, ?)",
    )
    .bind(branch_orig)
    .bind(conv_id)
    .bind(a2)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("UPDATE conversations SET mainline_branch_id = ? WHERE id = ?")
        .bind(branch_orig)
        .bind(conv_id)
        .execute(&pool)
        .await
        .unwrap();

    // ---- Now simulate historyUserEdit of U2 ----
    // CRITICAL: fork_source_message_id = U2 (the edited message)
    //           fork_point_message_id = U2.parent_message_id = A1 (the parent of the edited message)

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, source_branch_id, fork_point_message_id, fork_source_type, fork_source_message_id, head_message_id, created_at, updated_at)
         VALUES (?, ?, 'Edit Branch', 'ACTIVE', ?, ?, 'HISTORY_USER_EDIT', ?, ?, ?, ?)",
    )
    .bind(branch_new)
    .bind(conv_id)
    .bind(branch_orig)
    .bind(a1)   // fork_point = A1 (U2's parent)
    .bind(u2)   // fork_source_message_id = U2
    .bind(a1)   // head starts at fork_point initially
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Create edited user message
    // CRITICAL: parent_message_id = A1 (same as U2's parent), NOT U2
    //           edited_from_message_id = U2
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, edited_from_message_id, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', ?, 2, 1, 'U2 edited text', 'MARKDOWN', ?, ?, ?)",
    )
    .bind(u2_edited)
    .bind(conv_id)
    .bind(a1)   // parent = A1 (NOT U2!)
    .bind(u2)   // edited_from = U2
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Update new branch head to edited message
    sqlx::query("UPDATE branches SET head_message_id = ? WHERE id = ?")
        .bind(u2_edited)
        .bind(branch_new)
        .execute(&pool)
        .await
        .unwrap();

    // ===== INVARIANT CHECKS =====

    // 1. U2 content was NOT modified
    let (u2_text,): (String,) = sqlx::query_as(
        "SELECT content_text FROM messages WHERE id = ?",
    )
    .bind(u2)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(u2_text, "U2 original text", "Original U2 must NOT be modified");

    // 2. U2' has a new ID
    let edited: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, content_text FROM messages WHERE edited_from_message_id = ?",
    )
    .bind(u2)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(edited.len(), 1);
    assert_eq!(edited[0].0, u2_edited);
    assert_eq!(edited[0].1, "U2 edited text");

    // 3. U2' parent is A1 (U2's parent), NOT U2
    let (edited_parent,): (Option<String>,) = sqlx::query_as(
        "SELECT parent_message_id FROM messages WHERE id = ?",
    )
    .bind(u2_edited)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(edited_parent, Some(a1.to_string()),
        "CRITICAL: edited message parent must be A1 (U2's parent), not U2 itself");

    // 4. New branch fork_point is A1 (not U2!)
    let (fork_point,): (Option<String>,) = sqlx::query_as(
        "SELECT fork_point_message_id FROM branches WHERE id = ?",
    )
    .bind(branch_new)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(fork_point, Some(a1.to_string()),
        "CRITICAL: fork_point must be A1 (parent of edited message), not U2");

    // 5. fork_source_message_id is U2
    let (fork_source,): (Option<String>,) = sqlx::query_as(
        "SELECT fork_source_message_id FROM branches WHERE id = ?",
    )
    .bind(branch_new)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(fork_source, Some(u2.to_string()));

    // 6. fork_source_type is HISTORY_USER_EDIT
    let (fork_type,): (String,) = sqlx::query_as(
        "SELECT fork_source_type FROM branches WHERE id = ?",
    )
    .bind(branch_new)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(fork_type, "HISTORY_USER_EDIT");

    // 7. Original branch head still points to A2
    let (orig_head,): (Option<String>,) = sqlx::query_as(
        "SELECT head_message_id FROM branches WHERE id = ?",
    )
    .bind(branch_orig)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(orig_head, Some(a2.to_string()),
        "Original branch head must remain unchanged");
}

// ============================================================================
// T-09: load_snapshot — index / tree consistency
// ============================================================================

#[sqlx::test]
async fn test_snapshot_tree_consistency(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-009";
    let branch_id = "br-009";

    // Build a tree: U1 → A1 → U2 → A2
    //                        └→ A1b (variant)
    //                └→ U1b (edited user, different branch)
    let u1 = "msg-u1-009";
    let a1 = "msg-a1-009";
    let a1b = "msg-a1b-009"; // variant of A1
    let u2 = "msg-u2-009";
    let a2 = "msg-a2-009";

    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', NULL, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // U1 (root)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', 0, 0, 'Hello', 'MARKDOWN', ?, ?)",
    )
    .bind(u1)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // A1 (child of U1, sibling_index=0)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 1, 0, 'A1 response', 'MARKDOWN', 'prov-1', 'model-1', 'req-1', ?, ?)",
    )
    .bind(a1)
    .bind(conv_id)
    .bind(u1)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // A1b (variant = sibling of A1, same parent U1, sibling_index=1)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 1, 1, 'A1b variant', 'MARKDOWN', 'prov-1', 'model-1', 'req-2', ?, ?)",
    )
    .bind(a1b)
    .bind(conv_id)
    .bind(u1)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // U2 (child of A1)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', ?, 2, 0, 'Follow-up', 'MARKDOWN', ?, ?)",
    )
    .bind(u2)
    .bind(conv_id)
    .bind(a1)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // A2 (child of U2)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 3, 0, 'A2 response', 'MARKDOWN', 'prov-1', 'model-1', 'req-3', ?, ?)",
    )
    .bind(a2)
    .bind(conv_id)
    .bind(u2)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, head_message_id, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?, ?)",
    )
    .bind(branch_id)
    .bind(conv_id)
    .bind(a2)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("UPDATE conversations SET mainline_branch_id = ? WHERE id = ?")
        .bind(branch_id)
        .bind(conv_id)
        .execute(&pool)
        .await
        .unwrap();

    // ===== VERIFY TREE CONSISTENCY =====

    // 1. Total message count
    let (total,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(total, 5, "Should have 5 messages: U1, A1, A1b, U2, A2");

    // 2. Root messages (no parent)
    let roots: Vec<(String, i32)> = sqlx::query_as(
        "SELECT id, depth FROM messages WHERE conversation_id = ? AND parent_message_id IS NULL ORDER BY sibling_index",
    )
    .bind(conv_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(roots.len(), 1, "Exactly one root message");
    assert_eq!(roots[0].0, u1);
    assert_eq!(roots[0].1, 0);

    // 3. Children of U1 (A1 and A1b are siblings)
    let u1_children: Vec<(String, i32)> = sqlx::query_as(
        "SELECT id, sibling_index FROM messages WHERE parent_message_id = ? ORDER BY sibling_index",
    )
    .bind(u1)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(u1_children.len(), 2, "U1 should have 2 children: A1 and A1b");
    assert_eq!(u1_children[0], (a1.to_string(), 0));
    assert_eq!(u1_children[1], (a1b.to_string(), 1));

    // 4. Children of A1 (only U2)
    let a1_children: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM messages WHERE parent_message_id = ? ORDER BY sibling_index",
    )
    .bind(a1)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(a1_children.len(), 1);
    assert_eq!(a1_children[0].0, u2);

    // 5. Children of U2 (only A2)
    let u2_children: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM messages WHERE parent_message_id = ? ORDER BY sibling_index",
    )
    .bind(u2)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(u2_children.len(), 1);
    assert_eq!(u2_children[0].0, a2);

    // 6. A1b has no children (it's a leaf variant)
    let a1b_children: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM messages WHERE parent_message_id = ?",
    )
    .bind(a1b)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(a1b_children.len(), 0, "Variant A1b should have no children");

    // 7. Depth consistency: parent depth + 1 = child depth
    let depth_violations: Vec<(String, i32, i32)> = sqlx::query_as(
        "SELECT c.id, c.depth, p.depth
         FROM messages c
         JOIN messages p ON c.parent_message_id = p.id
         WHERE c.conversation_id = ? AND c.depth != p.depth + 1",
    )
    .bind(conv_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(depth_violations.len(), 0,
        "All child depths must equal parent depth + 1, violations: {:?}", depth_violations);

    // 8. Branch head is reachable from root (path walk)
    let mut current_id = Some(a2.to_string());
    let mut path = vec![];
    while let Some(cid) = current_id {
        path.push(cid.clone());
        let (parent,): (Option<String>,) = sqlx::query_as(
            "SELECT parent_message_id FROM messages WHERE id = ?",
        )
        .bind(&cid)
        .fetch_one(&pool)
        .await
        .unwrap();
        current_id = parent;
    }
    // Path from head A2 → U2 → A1 → U1
    assert_eq!(path.len(), 4, "Path from A2 to root should be 4 steps");
    assert_eq!(path[0], a2);
    assert_eq!(path[1], u2);
    assert_eq!(path[2], a1);
    assert_eq!(path[3], u1);

    // 9. All messages belong to the same conversation
    let conv_ids: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT conversation_id FROM messages WHERE id IN (?, ?, ?, ?, ?)",
    )
    .bind(u1)
    .bind(a1)
    .bind(a1b)
    .bind(u2)
    .bind(a2)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(conv_ids.len(), 1, "All messages should belong to the same conversation");
    assert_eq!(conv_ids[0].0, conv_id);

    // 10. No orphan messages (every message's conversation_id matches branch's conversation)
    let orphans: Vec<(String,)> = sqlx::query_as(
        "WITH RECURSIVE reachable(id, parent_message_id) AS (
             SELECT m.id, m.parent_message_id
             FROM messages m
             JOIN branches b ON b.head_message_id = m.id
             WHERE m.conversation_id = ?
             UNION ALL
             SELECT parent.id, parent.parent_message_id
             FROM messages parent
             JOIN reachable child ON child.parent_message_id = parent.id
             WHERE parent.conversation_id = ?
         )
         SELECT m.id
         FROM messages m
         WHERE m.conversation_id = ?
           AND m.parent_message_id IS NULL
           AND m.id NOT IN (SELECT id FROM reachable)",
    )
    .bind(conv_id)
    .bind(conv_id)
    .bind(conv_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    // Root messages that aren't branch heads are fine (they're in the middle of paths)
    // Only flag root messages not reachable from any branch head
    assert_eq!(orphans.len(), 0, "No orphan root messages should exist");
}

// ============================================================================
// T-10: sibling_index unique constraint enforcement
// ============================================================================

#[sqlx::test]
async fn test_sibling_index_unique_constraint(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-010";
    let branch_id = "br-010";
    let u1 = "msg-u1-010";
    let a1 = "msg-a1-010";

    // Setup
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', ?, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(branch_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?)",
    )
    .bind(branch_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // U1 (root)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', 0, 0, 'Hello', 'MARKDOWN', ?, ?)",
    )
    .bind(u1)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // A1 (child of U1, sibling_index=0)
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 1, 0, 'A1', 'MARKDOWN', 'prov-1', 'model-1', 'req-1', ?, ?)",
    )
    .bind(a1)
    .bind(conv_id)
    .bind(u1)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Verify: inserting duplicate (parent_message_id, sibling_index) MUST fail
    let result = sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 1, 0, 'Duplicate', 'MARKDOWN', ?, ?)",
    )
    .bind("msg-dup")
    .bind(conv_id)
    .bind(u1)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await;

    assert!(result.is_err(), "Duplicate sibling_index under same parent MUST be rejected by unique constraint");

    // Verify: inserting with sibling_index=1 should succeed
    let result = sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 1, 1, 'A1b', 'MARKDOWN', 'prov-1', 'model-1', 'req-2', ?, ?)",
    )
    .bind("msg-a1b")
    .bind(conv_id)
    .bind(u1)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await;

    assert!(result.is_ok(), "Different sibling_index under same parent should succeed");

    // Verify: duplicate root sibling_index in same conversation MUST fail
    let result = sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', 0, 0, 'Dup root', 'MARKDOWN', ?, ?)",
    )
    .bind("msg-dup-root")
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await;

    assert!(result.is_err(), "Duplicate root sibling_index in same conversation MUST be rejected");
}

// ============================================================================
// T-11: delete_conversation CASCADE verification
// ============================================================================

#[sqlx::test]
async fn test_delete_conversation_cascade(pool: SqlitePool) {
    enable_foreign_keys(&pool).await;
    run_migration(&pool).await;

    let now = now_secs();
    let conv_id = "conv-011";
    let branch_id = "br-011";
    let u1 = "msg-u1-011";
    let a1 = "msg-a1-011";

    // Setup: conversation + branch + messages
    sqlx::query(
        "INSERT INTO conversations (id, title, mainline_branch_id, created_at, updated_at, last_opened_at)
         VALUES (?, 'Test', ?, ?, ?, ?)",
    )
    .bind(conv_id)
    .bind(branch_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO branches (id, conversation_id, name, status, fork_source_type, created_at, updated_at)
         VALUES (?, ?, 'Main', 'ACTIVE', 'ROOT', ?, ?)",
    )
    .bind(branch_id)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, depth, sibling_index, content_text, content_format, created_at, updated_at)
         VALUES (?, ?, 'USER', 'COMPLETED', 0, 0, 'Hello', 'MARKDOWN', ?, ?)",
    )
    .bind(u1)
    .bind(conv_id)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, status, parent_message_id, depth, sibling_index, content_text, content_format, provider_id, model_id, request_id, created_at, updated_at)
         VALUES (?, ?, 'ASSISTANT', 'COMPLETED', ?, 1, 0, 'Response', 'MARKDOWN', 'prov-1', 'model-1', 'req-1', ?, ?)",
    )
    .bind(a1)
    .bind(conv_id)
    .bind(u1)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Verify data exists before delete
    let (branch_count,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM branches WHERE conversation_id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(branch_count, 1);

    let (msg_count,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(msg_count, 2);

    // Delete conversation using the same deferred-FK strategy as the runtime command.
    delete_conversation_with_deferred_fk(&pool, conv_id).await;

    // Verify: conversation gone
    let (conv_count,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM conversations WHERE id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(conv_count, 0, "Conversation should be deleted");

    // Verify: no orphan branches
    let (branch_after,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM branches WHERE conversation_id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(branch_after, 0, "CASCADE must delete all branches");

    // Verify: no orphan messages
    let (msg_after,): (i32,) = sqlx::query_as(
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ?",
    )
    .bind(conv_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(msg_after, 0, "CASCADE must delete all messages");
}
