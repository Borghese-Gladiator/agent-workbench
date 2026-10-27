/**
 * The shape of a reviewer's request for a deterministic probe (product spec §24: "The reviewer
 * may request deterministic probes but may not edit code."). This package does not execute
 * probes — that is @awb/verification's/@awb/execution's job via whatever Activity wires review
 * probes to real commands later. The enforcement here is structural: this type has no field
 * that could represent a patch, edit, or write — a probe request can describe what to look at,
 * never what to change.
 */
export interface ProbeRequest {
  description: string;
  targetPath?: string;
}

export function createProbeRequest(description: string, targetPath?: string): ProbeRequest {
  return targetPath === undefined ? { description } : { description, targetPath };
}
