-- 006: repair snapshots that were orphaned by the previous re-attach logic.
-- reattachOrphanHistory used to relink only run_items, leaving suggestions_raw rows pointing
-- at the deleted keyword id; trend/rising/digest queries filter on that column, so restored
-- history showed empty rows. Align every snapshot with its run_item's current keyword id.

UPDATE suggestions_raw
SET keyword_id = (
  SELECT ri.keyword_id FROM run_items ri
  WHERE ri.id = suggestions_raw.run_item_id AND ri.keyword_id IS NOT NULL
)
WHERE EXISTS (
  SELECT 1 FROM run_items ri
  WHERE ri.id = suggestions_raw.run_item_id AND ri.keyword_id IS NOT NULL
);
