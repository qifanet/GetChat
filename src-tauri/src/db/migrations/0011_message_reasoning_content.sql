-- 0011: Persist provider reasoning content for compatible thinking models.
-- Some OpenAI-compatible providers require assistant reasoning_content to be
-- replayed in later turns, but it must stay hidden from the normal message UI.

ALTER TABLE messages ADD COLUMN reasoning_content TEXT NOT NULL DEFAULT '';
