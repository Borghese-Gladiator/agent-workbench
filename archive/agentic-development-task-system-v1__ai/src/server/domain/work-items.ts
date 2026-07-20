import { ALLOWED_WORK_ITEM_TRANSITIONS } from "@shared/constants.js";

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    const allowed = ALLOWED_WORK_ITEM_TRANSITIONS[from] ?? [];
    super(
      `Invalid transition from "${from}" to "${to}". Allowed: [${allowed.join(", ")}]`
    );
    this.name = "InvalidTransitionError";
  }
}

export function validateTransition(fromStatus: string, toStatus: string): void {
  const allowed = ALLOWED_WORK_ITEM_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    throw new InvalidTransitionError(fromStatus, toStatus);
  }
}
