-- 009: fine-grained request progress for running harvests.
-- expected_requests = basic (1) + expansion requests planned for this keyword
-- done_requests     = logical requests already attempted (success or failure)
ALTER TABLE run_items ADD COLUMN expected_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_items ADD COLUMN done_requests INTEGER NOT NULL DEFAULT 0;
