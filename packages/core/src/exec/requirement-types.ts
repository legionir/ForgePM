export interface RequirementCoverageRow {
  id: string;
  code: string;
  text: string;
  status: string;
  assignment_tasks: string[];
  linked_criteria: { task: string; criterion: string; status: string; evidence_count: number }[];
  coverage: 'unassigned' | 'assigned' | 'in_progress' | 'covered' | 'dropped';
}
