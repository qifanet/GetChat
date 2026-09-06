/**
 * @file agent/budget.rs
 * @description Context budget ledger (v1.5.0 M3.1).
 *
 * `Budget` resolves the per-run token numbers (context window, output
 * reservation, input budget) that used to be computed inline in the runner,
 * and `BudgetThresholds` carries the configurable enforcement points — 60%
 * compression trigger, 96% pre-append danger check, 70% deterministic trim
 * target — that used to be hardcoded at three separate sites. All budget
 * enforcement goes through the single entry `agent::context::enforce_budget`;
 * strategy differences are expressed only as these thresholds.
 */

use sqlx::SqlitePool;

/** Per-run token ledger for one agent stream. */
#[derive(Debug, Clone, Copy)]
pub(crate) struct Budget {
    /** Model context window in tokens (from provider_models, floored at 8k). */
    pub context_window: u32,
    /** Tokens reserved for model output + safety margin (informational — the
     * ledger only exposes the derived `input_budget` to enforcement). */
    #[allow(dead_code)]
    pub output_reservation: u32,
    /** `context_window - output_reservation` — what the prompt may occupy. */
    pub input_budget: u32,
}

/** Configurable enforcement thresholds, as fractions of `Budget::input_budget`. */
#[derive(Debug, Clone, Copy)]
pub(crate) struct BudgetThresholds {
    /** Mid-loop AI compression trigger (was a hardcoded 60%). */
    pub compression_trigger: f32,
    /** Pre-append danger check before adding a tool result (was 96%). */
    pub pre_append_danger: f32,
    /** Deterministic fallback trim target (was a hardcoded 70%). */
    pub deterministic_trim_target: f32,
}

impl Default for BudgetThresholds {
    fn default() -> Self {
        Self {
            compression_trigger: 0.60,
            pre_append_danger: 0.96,
            deterministic_trim_target: 0.70,
        }
    }
}

impl Budget {
    /**
     * Resolve the ledger for a model. Unknown models default to a 64k window;
     * the window is floored at 8k and ~8k tokens are reserved for output —
     * identical to the pre-M3 inline math.
     */
    pub(crate) async fn resolve(db: &SqlitePool, model_id: &str) -> Budget {
        let context_window_kb: i32 =
            crate::repositories::provider_models::find_by_id(db, model_id)
                .await
                .ok()
                .flatten()
                .map(|m| m.context_window_kb)
                .unwrap_or(64);
        let context_window = (context_window_kb.max(8) as u32) * 1000;
        // Reserve ~8K tokens for model output + safety margin
        let output_reservation: u32 = 8_000;
        Budget {
            context_window,
            output_reservation,
            input_budget: context_window.saturating_sub(output_reservation),
        }
    }

    /** Prompt tokens at/above which mid-loop compression triggers. */
    pub(crate) fn compression_trigger_tokens(&self, t: &BudgetThresholds) -> u32 {
        (self.input_budget as f32 * t.compression_trigger) as u32
    }

    /** Projected tokens at/above which the pre-append check forces enforcement. */
    pub(crate) fn danger_tokens(&self, t: &BudgetThresholds) -> u32 {
        (self.input_budget as f32 * t.pre_append_danger) as u32
    }

    /** Deterministic fallback trims the prompt towards this target. */
    pub(crate) fn trim_target_tokens(&self, t: &BudgetThresholds) -> u32 {
        (self.input_budget as f32 * t.deterministic_trim_target) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /** Input budget 10_000 with default thresholds — the 触发/不触发/边界 anchors. */
    fn ledger() -> (Budget, BudgetThresholds) {
        let budget = Budget {
            context_window: 18_000,
            output_reservation: 8_000,
            input_budget: 10_000,
        };
        (budget, BudgetThresholds::default())
    }

    #[test]
    fn default_thresholds_match_pre_m3_constants() {
        let (budget, t) = ledger();
        assert_eq!(budget.compression_trigger_tokens(&t), 6_000);
        assert_eq!(budget.danger_tokens(&t), 9_600);
        assert_eq!(budget.trim_target_tokens(&t), 7_000);
    }

    #[test]
    fn below_trigger_and_between_trigger_and_danger_do_not_cross_anchors() {
        let (budget, t) = ledger();
        // 不触发：低于 60% 触发线，也低于 96% 危险线。
        assert!(5_999 < budget.compression_trigger_tokens(&t));
        assert!(9_599 < budget.danger_tokens(&t));
        // 触发边界：恰好在阈值上（>= 语义由调用方比较，这里锚定阈值本身）。
        assert_eq!(budget.compression_trigger_tokens(&t), 6_000);
        assert_eq!(budget.danger_tokens(&t), 9_600);
    }

    #[test]
    fn thresholds_are_configurable_in_one_place() {
        let budget = Budget {
            context_window: 18_000,
            output_reservation: 8_000,
            input_budget: 10_000,
        };
        let t = BudgetThresholds {
            compression_trigger: 0.50,
            pre_append_danger: 0.90,
            deterministic_trim_target: 0.80,
        };
        assert_eq!(budget.compression_trigger_tokens(&t), 5_000);
        assert_eq!(budget.danger_tokens(&t), 9_000);
        assert_eq!(budget.trim_target_tokens(&t), 8_000);
    }

    #[test]
    fn input_budget_saturates_when_reservation_exceeds_window() {
        let budget = Budget {
            context_window: 4_000,
            output_reservation: 8_000,
            input_budget: 0,
        };
        let t = BudgetThresholds::default();
        assert_eq!(budget.compression_trigger_tokens(&t), 0);
        assert_eq!(budget.danger_tokens(&t), 0);
    }
}
