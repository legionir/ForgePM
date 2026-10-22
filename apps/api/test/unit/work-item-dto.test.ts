import { describe, it, expect } from 'vitest';
import { normalizeCriteria, rowToDto } from '../../src/modules/work-items/items-repository';

const BASE = {
  id: '01a16317-6c94-79b0-a45f-bb6143aadd90', organization_id: '01a1363b-a5e0-740e-aa70-83bfb583030f',
  project_id: '01a1496e-66f2-73a7-bab3-038ebac16444', project_key: 'SSS', number: 5, type: 'task', title: 't',
  description: null, state_id: '01a14970-c07c-745b-8431-84f77e827f49', state_name: 'Todo', state_category: 'unstarted',
  priority: 'none', source: 'manual', created_at: new Date('2026-10-22T10:00:00Z'), updated_at: new Date('2026-10-22T10:00:00Z'),
};

describe('work item DTO criteria', () => {
  it('string criteria map to {text, done:false}', () => {
    expect(normalizeCriteria(['AGENTS.md must exist (file:AGENTS.md)'])).toEqual([{ text: 'AGENTS.md must exist (file:AGENTS.md)', done: false }]);
    expect(rowToDto({ ...BASE, acceptance_criteria: ['a must b'] }, []).acceptance_criteria).toEqual([{ text: 'a must b', done: false }]);
  });

  it('mixed criteria keep objects and drop unusable entries', () => {
    expect(normalizeCriteria([{ text: 'x', done: true }, 'y', 3, null, { done: true }, '', { text: '' }])).toEqual([
      { text: 'x', done: true },
      { text: 'y', done: false },
    ]);
    expect(normalizeCriteria(null)).toEqual([]);
  });
});
