export interface WaiverCheckInput {
  humanApproved: boolean;
  waiverCandidateSha: string;
  currentCandidateSha: string;
}

/** A waiver only counts toward Verify completion when it was human-approved AND scoped to the exact current candidate SHA (product spec §11). */
export function isWaiverValidForCandidate(waiver: WaiverCheckInput): boolean {
  return waiver.humanApproved && waiver.waiverCandidateSha === waiver.currentCandidateSha;
}

export function allWaiversValid(waivers: WaiverCheckInput[]): boolean {
  return waivers.every(isWaiverValidForCandidate);
}
