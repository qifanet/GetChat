-- 0006: Workspace support for file-system tools
-- Adds workspace_path to conversations for sandboxing file operations.

ALTER TABLE conversations ADD COLUMN workspace_path TEXT DEFAULT NULL;
