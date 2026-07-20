export interface ReviewPromptWorkItem {
  id: string;
  title: string;
  body: string;
  acceptance_criteria: string | null;
  branch_name: string | null;
}

export function renderAdversarialReviewPrompt(workItem: ReviewPromptWorkItem): string {
  const title = workItem.title.replace(/[\r\n]+/g, " ").trim();
  const criteria = (workItem.acceptance_criteria ?? "").trim();

  const invocation = `/codex:adversarial-review --base main challenge whether this was the right approach for ${title}.`;

  if (!criteria) return invocation;

  return `${invocation}

Acceptance criteria:
${criteria}`;
}
