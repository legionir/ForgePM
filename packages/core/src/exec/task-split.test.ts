import { describe, expect, it } from 'vitest';
import { parseTaskSplit } from './task-split';

const GOOD = 'POST /v1/items returns 201 for a valid payload; test:task-split_create';
const child = (key: string, depends_on: string[] = []) => ({
  key,
  title: `Implement ${key} slice`,
  acceptance_criteria: [GOOD],
  allowed_paths: [`packages/${key}/**`],
  depends_on,
});

const input = (children: ReturnType<typeof child>[]) => ({ parent_ref: 'T-001', children });

describe('parseTaskSplit', () => {
  it('accepts child-key dependencies and applies declaration defaults', () => {
    expect(parseTaskSplit(input([child('models'), child('routes', ['models'])]))).toMatchObject({
      parent_ref: 'T-001',
      children: [
        { key: 'models', req_ids: [], depends_on: [] },
        { key: 'routes', req_ids: [], depends_on: ['models'] },
      ],
    });
  });

  it.each([
    ['self', [child('one', ['one']), child('two')]],
    ['two-task', [child('one', ['two']), child('two', ['one'])]],
    ['three-task', [child('one', ['two']), child('two', ['three']), child('three', ['one'])]],
  ])('rejects %s dependency cycles with DEPENDENCY_CYCLE', (_label, children) => {
    expect(() => parseTaskSplit(input(children as ReturnType<typeof child>[]))).toThrowError(
      expect.objectContaining({ code: 'DEPENDENCY_CYCLE' }),
    );
  });

  it('rejects duplicate keys and repeated dependency refs', () => {
    expect(() => parseTaskSplit(input([child('same'), child('same')]))).toThrow(/unique/);
    expect(() => parseTaskSplit(input([child('one', ['two', 'two']), child('two')]))).toThrow(/repeats/);
  });

  it('rejects a malformed child rather than silently dropping fields', () => {
    expect(() => parseTaskSplit({ parent_ref: 'T-001', children: [{ ...child('one'), status: 'done' }, child('two')] })).toThrow();
  });
});
