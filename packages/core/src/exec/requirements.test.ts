import { describe, expect, it } from 'vitest';
import { assessCheckable, reqChangeInputSchema, requirementInputSchema } from '@forgepm/shared';

const sentence = 'The API returns status 201 for valid items and persists one row; test:req_create_201';
const validRequirement = {
  text: sentence,
  quote: 'The API returns status 201 for valid items',
  source: 'user_message',
};

describe('requirement input contract', () => {
  it('accepts a literal quote and checkable text', () => {
    expect(requirementInputSchema.safeParse(validRequirement).success).toBe(true);
    expect(assessCheckable(sentence).ok).toBe(true);
  });

  it('rejects altered, normalized, or non-substring quotes', () => {
    for (const quote of ['The API returns HTTP 201', ' the API returns status 201', 'status 201 valid']) {
      const parsed = requirementInputSchema.safeParse({ ...validRequirement, quote });
      expect(parsed.success, quote).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path[0] === 'quote')).toBe(true);
    }
  });

  it('accepts five separately quoted requirements from one five-sentence request fixture', () => {
    const sentences = [
      'The API returns status 201 for valid items and writes one row; test:req_create_201',
      'The API returns status 404 for missing items and writes no row; test:req_missing_404',
      'The API returns a request_id field in error responses; test:req_error_request_id',
      'The task list returns no more than 100 items per page; test:req_task_page_100',
      'The cancellation route returns an approval id for each canceled child; test:req_cancel_approval',
    ];
    const parsed = sentences.map((text) => requirementInputSchema.safeParse({
      text,
      quote: text.split(';')[0],
      source: 'user_message',
    }));
    expect(parsed).toHaveLength(5);
    expect(parsed.every((result) => result.success)).toBe(true);
    expect(sentences.every((text) => assessCheckable(text).ok)).toBe(true);
  });

  it('rejects vague requirements using the shared checkability assessment', () => {
    const vague = 'The API behaves properly and is robust overall';
    expect(requirementInputSchema.safeParse({ ...validRequirement, text: vague, quote: vague }).success).toBe(true);
    expect(assessCheckable(vague).ok).toBe(false);
  });

  it('requires the same literal quote for req_change', () => {
    expect(reqChangeInputSchema.safeParse({ requirement_ref: 'REQ-001', ...validRequirement }).success).toBe(true);
    expect(reqChangeInputSchema.safeParse({
      requirement_ref: 'REQ-001',
      ...validRequirement,
      quote: 'The API will probably return status 201',
    }).success).toBe(false);
  });
});
