import { describe, expect, it } from 'vitest';
import { buildPlanTree } from './plan-view';

const tasks = [
  { id: 'parent', code: 'T-001', title: 'Parent task', status: 'in_progress', parent_id: null, blocked_on_kind: null, blocked_on_ref: null, blocked_reason: null, unblock_condition: null },
  { id: 'blocked', code: 'T-002', title: 'Blocked child', status: 'blocked', parent_id: 'parent', blocked_on_kind: 'task', blocked_on_ref: 'dependency', blocked_reason: 'dependency pending', unblock_condition: 'T-003 must be done' },
  { id: 'waiting', code: 'T-003', title: 'Human response child', status: 'awaiting_review', parent_id: 'parent', blocked_on_kind: 'question', blocked_on_ref: 'question-id', blocked_reason: null, unblock_condition: 'human answers Q-001' },
];

describe('buildPlanTree', () => {
  it('returns the full hierarchy and keeps blocked separate from awaiting_human', () => {
    const [root] = buildPlanTree({
      tasks,
      dependencies: [{ task_id: 'blocked', id: 'dependency', code: 'T-004', status: 'not_started' }],
      declarations: [{ task_id: 'blocked', req_ids: ['REQ-001'] }],
      criteria: [{ task_id: 'blocked', code: 'C-001', req_code: 'REQ-001', status: 'pending' }],
      cancellations: [],
    });
    expect(root.code).toBe('T-001');
    expect(root.children.map((child) => child.display_status)).toEqual(['blocked', 'awaiting_human']);
    expect(root.children[0]).toMatchObject({
      status: 'blocked',
      blocked_on: { kind: 'task', reason: 'dependency pending' },
      depends_on: [{ code: 'T-004', status: 'not_started' }],
      declared_req_ids: ['REQ-001'],
      criteria: [{ code: 'C-001', req_code: 'REQ-001', status: 'pending' }],
    });
    expect(root.children[1].status).toBe('awaiting_review');
    expect(root.children[1].display_status).toBe('awaiting_human');
  });

  it('marks only a human-canceled child as canceled in the projection', () => {
    const [root] = buildPlanTree({
      tasks,
      dependencies: [],
      declarations: [],
      criteria: [],
      cancellations: [{ child_id: 'blocked', waiver: 'cancel:T-002' }],
    });
    expect(root.children[0]).toMatchObject({ status: 'blocked', display_status: 'canceled', canceled_by_human: true });
    expect(root.children[1].canceled_by_human).toBe(false);
  });
});
