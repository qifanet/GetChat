-- ============================================================================
-- Migration 0003
-- Description: Normalize provider models and persist per-branch model preference
-- ============================================================================

CREATE TABLE IF NOT EXISTS provider_models (
    id            TEXT NOT NULL PRIMARY KEY,
    provider_id   TEXT NOT NULL,
    request_name  TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),

    FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_models_provider_request_name
    ON provider_models(provider_id, request_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_models_provider_display_name
    ON provider_models(provider_id, display_name);

ALTER TABLE branches
    ADD COLUMN preferred_model_id TEXT NOT NULL DEFAULT '';

INSERT INTO provider_models (id, provider_id, request_name, display_name, created_at, updated_at)
SELECT
    'model_' || lower(hex(randomblob(16))),
    providers.id,
    providers.default_model_id,
    providers.default_model_id,
    unixepoch(),
    unixepoch()
FROM providers
WHERE trim(providers.default_model_id) <> ''
  AND NOT EXISTS (
      SELECT 1
      FROM provider_models
      WHERE provider_models.id = providers.default_model_id
  )
  AND NOT EXISTS (
      SELECT 1
      FROM provider_models
      WHERE provider_models.provider_id = providers.id
        AND provider_models.request_name = providers.default_model_id
  );

UPDATE providers
SET default_model_id = (
    SELECT provider_models.id
    FROM provider_models
    WHERE provider_models.provider_id = providers.id
      AND provider_models.request_name = providers.default_model_id
    LIMIT 1
)
WHERE trim(providers.default_model_id) <> ''
  AND NOT EXISTS (
      SELECT 1
      FROM provider_models
      WHERE provider_models.id = providers.default_model_id
  );
