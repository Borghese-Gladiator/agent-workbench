import { describe, expect, it } from 'vitest';
import { isAutoAdvanceable, STAGES, stageNeedsHumanApproval } from './lifecycle.js';
import {
  abandonTask,
  approveDelivery,
  approveExecutionPlan,
  approveTaskBrief,
  closeout,
  completeDeliveryPrep,
  completeFeatureE2e,
  completeImplementation,
  completeSelfReview,
  completeStaticChecks,
  generateTaskBrief,
  humanReviewBounce,
  humanReviewComplete,
  IllegalTransitionError,
  rejectDelivery,
  rejectExecutionPlan,
  rejectTaskBrief,
  submitPlan,
  type TaskState,
} from './transitions.js';

const active = (stage: TaskState['stage']): TaskState => ({ stage, status: 'active' });

describe('happy-path lifecycle transitions', () => {
  it('walks intake -> closeout via the full chain', () => {
    let s: TaskState = active('intake');
    s = active(generateTaskBrief(s).stage);
    expect(s.stage).toBe('human_brief_approval');

    s = active(approveTaskBrief(s).stage);
    expect(s.stage).toBe('discovery');

    // Discovery + planning are one stage: it produces the plan and parks at the gate.
    s = active(submitPlan(s).stage);
    expect(s.stage).toBe('human_plan_approval');

    s = active(approveExecutionPlan(s).stage);
    expect(s.stage).toBe('implementation');

    s = active(completeImplementation(s).stage);
    expect(s.stage).toBe('static_checks');

    s = active(completeStaticChecks(s).stage);
    expect(s.stage).toBe('feature_e2e');

    s = active(completeFeatureE2e(s).stage);
    expect(s.stage).toBe('agent_self_review');

    s = active(completeSelfReview(s).stage);
    expect(s.stage).toBe('human_review');

    s = active(humanReviewComplete(s).stage);
    expect(s.stage).toBe('delivery_prep');

    s = active(completeDeliveryPrep(s).stage);
    expect(s.stage).toBe('human_delivery_approval');

    const delivered = approveDelivery(s);
    expect(delivered.stage).toBe('publish');
    expect(delivered.status).toBe('ready_to_publish');

    // After delivery approval the task sits in publish/ready_to_publish; closeout
    // must work from there, not just from an `active` task.
    const closed = closeout({ stage: 'publish', status: 'ready_to_publish' });
    expect(closed.stage).toBe('closeout');
    expect(closed.status).toBe('done');
  });
});

describe('completeStaticChecks — optional E2E skip', () => {
  it('advances to feature_e2e by default', () => {
    expect(completeStaticChecks(active('static_checks')).stage).toBe('feature_e2e');
  });
  it('skips straight to agent_self_review when skipE2e is set', () => {
    const r = completeStaticChecks(active('static_checks'), { skipE2e: true });
    expect(r.stage).toBe('agent_self_review');
    expect(r.note).toMatch(/e2e skipped/i);
  });
});

describe('rejections loop back', () => {
  it('rejectTaskBrief returns to task_brief', () => {
    expect(rejectTaskBrief(active('human_brief_approval')).stage).toBe('task_brief');
  });
  it('rejectExecutionPlan returns to discovery', () => {
    expect(rejectExecutionPlan(active('human_plan_approval')).stage).toBe('discovery');
  });
  it('rejectDelivery returns to delivery_prep', () => {
    expect(rejectDelivery(active('human_delivery_approval')).stage).toBe('delivery_prep');
  });
});

describe('human review decisions', () => {
  it('bounce to implementation', () => {
    const r = humanReviewBounce(active('human_review'), 'implementation');
    expect(r.stage).toBe('implementation');
    expect(r.note).toContain('bounced');
  });
  it('bounce to discovery', () => {
    expect(humanReviewBounce(active('human_review'), 'discovery').stage).toBe('discovery');
  });
});

describe('abandonTask (the single operator escape hatch -> abandoned)', () => {
  it('abandons from any non-terminal stage, leaving the stage', () => {
    for (const stage of [
      'intake',
      'implementation',
      'human_review',
      'human_plan_approval',
    ] as const) {
      const r = abandonTask(active(stage));
      expect(r.status).toBe('abandoned');
      expect(r.stage).toBe(stage);
    }
  });
  it('abandons a ready_to_publish task', () => {
    const r = abandonTask({ stage: 'publish', status: 'ready_to_publish' });
    expect(r.status).toBe('abandoned');
  });
  it('refuses an already-terminal task', () => {
    for (const status of ['done', 'abandoned'] as const) {
      expect(() => abandonTask({ stage: 'implementation', status })).toThrow(
        IllegalTransitionError,
      );
    }
  });
});

describe('illegal transitions', () => {
  it('cannot approve a brief from intake', () => {
    expect(() => approveTaskBrief(active('intake'))).toThrow(IllegalTransitionError);
  });
  it('cannot complete implementation from discovery', () => {
    expect(() => completeImplementation(active('discovery'))).toThrow(IllegalTransitionError);
  });
  it('cannot act on an abandoned task', () => {
    expect(() => completeImplementation({ stage: 'implementation', status: 'abandoned' })).toThrow(
      IllegalTransitionError,
    );
  });
  it('cannot act on a done task', () => {
    expect(() => approveDelivery({ stage: 'human_delivery_approval', status: 'done' })).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('lifecycle metadata', () => {
  it('has 14 ordered stages', () => {
    expect(STAGES).toHaveLength(14);
    expect(STAGES[0]).toBe('intake');
    expect(STAGES[STAGES.length - 1]).toBe('closeout');
  });
  it('flags the four human approval gates', () => {
    const gates = STAGES.filter(stageNeedsHumanApproval);
    expect(gates).toEqual([
      'human_brief_approval',
      'human_plan_approval',
      'human_review',
      'human_delivery_approval',
    ]);
  });

  it('isAutoAdvanceable: exactly the non-gate work stages auto-advance', () => {
    const auto = STAGES.filter(isAutoAdvanceable);
    expect(auto).toEqual([
      'discovery',
      'implementation',
      'static_checks',
      'feature_e2e',
      'agent_self_review',
      'delivery_prep',
      'publish',
    ]);
  });

  it('isAutoAdvanceable: gates, terminal, and pre-first-gate stages do NOT auto-advance', () => {
    // The 4 gates stay manual.
    for (const g of [
      'human_brief_approval',
      'human_plan_approval',
      'human_review',
      'human_delivery_approval',
    ] as const) {
      expect(isAutoAdvanceable(g)).toBe(false);
    }
    // First-gate-manual decision: intake/task_brief require a human;
    // closeout is terminal.
    expect(isAutoAdvanceable('intake')).toBe(false);
    expect(isAutoAdvanceable('task_brief')).toBe(false);
    expect(isAutoAdvanceable('closeout')).toBe(false);
  });
});
