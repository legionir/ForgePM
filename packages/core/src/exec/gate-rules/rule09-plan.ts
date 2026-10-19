import type { BlockedRef, GateContext, Rule } from '../gate-types';

/**
 * Rule 9 — children are done (or a human cancelled them) and dependencies are done.
 *
 * A cancelled child needs a human's waiver naming its code: an agent may not
 * cancel its own subtask, so the waiver is what makes the exception legible.
 */
const rule09: Rule = (ctx: GateContext): BlockedRef[] => {
  const out: BlockedRef[] = [];
  for (const c of ctx.task.children) {
    if (c.status === 'done') continue;
    if (
      c.cancelled &&
      (ctx.task.human_waivers.includes(`cancel:${c.code}`) ||
        ctx.task.human_waivers.includes(`cancel:${c.code}:${c.req_codes.join(',')}`))
    )
      continue;
    out.push({
      rule: 9,
      ref: c.code,
      title: c.title,
      needed: 'finish the subtask (or have a human cancel it)',
      tool_to_call: 'exec_plan_view',
    });
  }
  for (const d of ctx.task.depends_on) {
    if (d.status !== 'done')
      out.push({
        rule: 9,
        ref: d.code,
        title: `dependency ${d.code} is '${d.status}'`,
        needed: `dependency is '${d.status}', not done`,
        tool_to_call: 'exec_plan_view',
      });
  }
  return out;
};

export default rule09;
