-- 004: keyword origin (manual vs auto-created by agent live fetch)

ALTER TABLE keywords ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

-- backfill: keywords auto-created by earlier live fetches carry a marked note
UPDATE keywords SET source = 'mcp-live' WHERE note LIKE 'auto: live fetch%';
