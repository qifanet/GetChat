/**
 * @file agent/eval/drift.rs
 * @description Baseline drift detection prototype (v1.5.0 M5.4).
 *
 * Replays four canonical scenario shapes — BFCL simple / multiple-catalog /
 * parallel / irrelevance — and compares the loop's model-call and tool-call
 * counts against the committed [`BASELINES`] table. A deviation beyond
 * [`DRIFT_TOLERANCE`] fails with a formatted drift report; in CI that failure
 * is the alarm. When a loop change legitimately shifts the shape, update
 * BASELINES in the same PR and say why.
 *
 * Token baselines are deferred until eval runs against a provider that
 * reports usage: the scripted backend completes with `usage: None`, so turn
 * and tool-call counts are the only stable signals today. The audit trail
 * (M5.1) already records per-turn tokens for when that lands.
 */

use serde_json::json;
use tokio::sync::watch;

use super::cases::{recording_channel, test_deps, test_request};
use super::mock_provider::{ScriptedModel, ScriptedStep, ScriptedToolCall};
use crate::agent::runner::{run_react_loop, ReactLoopOutcome};

/** Committed shape of one canonical scenario. */
struct DriftBaseline {
    scenario: &'static str,
    expected_model_calls: u32,
    expected_tool_calls: u32,
}

/** Relative deviation that counts as drift (DEVELOPMENT.md M5.4: 20%). */
const DRIFT_TOLERANCE: f64 = 0.20;

/// One row per canonical scenario, in replay order. Update deliberately.
const BASELINES: &[DriftBaseline] = &[
    DriftBaseline {
        scenario: "simple_single_tool",
        expected_model_calls: 2,
        expected_tool_calls: 1,
    },
    DriftBaseline {
        scenario: "multiple_catalog_pick",
        expected_model_calls: 2,
        expected_tool_calls: 1,
    },
    DriftBaseline {
        scenario: "parallel_two_calls",
        expected_model_calls: 2,
        expected_tool_calls: 2,
    },
    DriftBaseline {
        scenario: "irrelevance_no_tool",
        expected_model_calls: 1,
        expected_tool_calls: 0,
    },
];

/// What one replayed scenario actually produced.
struct ScenarioShape {
    model_calls: u32,
    tool_calls: u32,
}

async fn replay(
    request_id: &str,
    tool_catalog: &[&str],
    steps: Vec<ScriptedStep>,
) -> ScenarioShape {
    let scripted = ScriptedModel::new(steps);
    let deps = test_deps(scripted.clone(), tool_catalog).await;
    let (channel, channel_events) = recording_channel();
    let (_cancel_tx, cancel_rx) = watch::channel(false);

    let request = test_request(request_id, &deps.tool_definitions, None);
    let outcome = run_react_loop(&deps, request, &channel, cancel_rx, 5, 5, 10, 30).await;
    assert!(
        matches!(outcome, Ok(ReactLoopOutcome::Completed { .. })),
        "drift replay '{request_id}' must complete, got {outcome:?}"
    );

    let tool_calls = channel_events
        .lock()
        .expect("event recorder")
        .iter()
        .filter(|e| matches!(e, crate::dto::streaming::ModelStreamEventDto::ToolCall { .. }))
        .count() as u32;
    ScenarioShape {
        model_calls: scripted.recorded_requests().len() as u32,
        tool_calls,
    }
}

/// A drift test with tolerance semantics: small honest changes pass, shape
/// changes (extra model round, lost tool execution) alarm with a report.
#[tokio::test]
async fn golden_shape_matches_committed_baselines() {
    // simple: one tool turn + final text.
    let simple = replay(
        "req_drift_simple",
        &["calculator"],
        vec![
            ScriptedStep::ToolCalls {
                calls: vec![ScriptedToolCall::new("calculator", json!({"expression": "6*7"}))],
                reasoning_content: None,
            },
            ScriptedStep::Text {
                chunks: vec!["42".to_string()],
                reasoning_content: None,
            },
        ],
    )
    .await;

    // multiple: full catalog visible, exactly one decoy-free execution.
    let multiple = replay(
        "req_drift_multiple",
        &["calculator", "file", "todo"],
        vec![
            ScriptedStep::ToolCalls {
                calls: vec![ScriptedToolCall::new("calculator", json!({"expression": "2+2"}))],
                reasoning_content: None,
            },
            ScriptedStep::Text {
                chunks: vec!["4".to_string()],
                reasoning_content: None,
            },
        ],
    )
    .await;

    // parallel: two calls in one turn.
    let parallel = replay(
        "req_drift_parallel",
        &["calculator"],
        vec![
            ScriptedStep::ToolCalls {
                calls: vec![
                    ScriptedToolCall::new("calculator", json!({"expression": "7*1"})),
                    ScriptedToolCall::new("calculator", json!({"expression": "7*2"})),
                ],
                reasoning_content: None,
            },
            ScriptedStep::Text {
                chunks: vec!["7 14".to_string()],
                reasoning_content: None,
            },
        ],
    )
    .await;

    // irrelevance: direct answer, no tool phase.
    let irrelevance = replay(
        "req_drift_irrelevance",
        &["calculator", "file", "todo"],
        vec![ScriptedStep::Text {
            chunks: vec!["out of scope".to_string()],
            reasoning_content: None,
        }],
    )
    .await;

    let actual = [
        ("simple_single_tool", &simple),
        ("multiple_catalog_pick", &multiple),
        ("parallel_two_calls", &parallel),
        ("irrelevance_no_tool", &irrelevance),
    ];

    let mut drifts: Vec<String> = Vec::new();
    for (baseline, (name, shape)) in BASELINES.iter().zip(actual.iter()) {
        debug_assert_eq!(baseline.scenario, *name, "baseline/table order desynced");
        for (metric, expected, observed) in [
            (
                "model_calls",
                baseline.expected_model_calls,
                shape.model_calls,
            ),
            ("tool_calls", baseline.expected_tool_calls, shape.tool_calls),
        ] {
            let drifted = if expected == 0 {
                observed != expected
            } else {
                let rel = (observed as f64 - expected as f64) / expected as f64;
                rel.abs() > DRIFT_TOLERANCE
            };
            if drifted {
                drifts.push(format!(
                    "[drift] scenario '{name}': {metric} = {observed} vs baseline {expected} \
                     (tolerance {:.0}%)",
                    DRIFT_TOLERANCE * 100.0
                ));
            }
        }
    }

    assert!(
        drifts.is_empty(),
        "loop shape drifted from committed baselines — investigate, or update \
         BASELINES in agent/eval/drift.rs with justification:\n{}",
        drifts.join("\n")
    );
}
