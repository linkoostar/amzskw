-- 007 (P2): soft-delete API keys so credits_ledger / api_calls audit survives.
ALTER TABLE api_keys ADD COLUMN deleted_at TEXT;

-- synchronous MCP live-fetch budget (ms); overridable from the admin settings page.
INSERT OR IGNORE INTO settings(key, value) VALUES ('mcp_live_sync_deadline_ms', '25000');
