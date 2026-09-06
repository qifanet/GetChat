-- 0017: Message provenance (C13, M4.5).
-- source marks dual-queue injected user messages so they survive refresh:
-- 'inject' rows are materialized when the receiving assistant message
-- completes and replayed into future prompts after that assistant turn.
-- NULL means a normally-typed message.

ALTER TABLE messages ADD COLUMN source TEXT;
