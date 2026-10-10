export const MIGRATION_0009_PERF = `
-- 0009_perf — add the composite cursor index the §12 contract requires for the
-- work-item list path ("list indexes start with organization_id or project_id
-- and cover the cursor order created_at DESC, id DESC"). Without it P-02 (the
-- filtered list on the 200k-item project) scans the org-wide index and removes
-- every other project's rows (PERFORMANCE_BUDGET.md §3b-7). Forward-only.

CREATE INDEX workitems_project_cursor_idx
  ON work_items (project_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- saved-view / search list path also orders (organization_id, created_at DESC,
-- id DESC) over non-deleted rows; the org+created index above is not partial,
-- so add the soft-delete-aware variant for the search GIN follow-up sort.
CREATE INDEX workitems_org_cursor_undel_idx
  ON work_items (organization_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
`;
