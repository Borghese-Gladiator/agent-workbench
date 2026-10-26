import type { AgentRole, Capability } from './roles.js';
import { hasCapability, capabilitiesForRole } from './capability-table.js';

export class CapabilityDeniedError extends Error {
  constructor(
    public readonly role: AgentRole,
    public readonly capability: Capability,
  ) {
    super(`Role "${role}" does not have capability "${capability}"`);
    this.name = 'CapabilityDeniedError';
  }
}

/**
 * The single enforcement point tool invocations must pass through before an agent session's
 * request is allowed to proceed. Deliberately has no bypass — there is no "unrestricted" role
 * and no escape hatch that skips this check (product spec §18: "Do not give every agent a
 * generic unrestricted shell").
 */
export class CapabilityBroker {
  constructor(private readonly role: AgentRole) {}

  can(capability: Capability): boolean {
    return hasCapability(this.role, capability);
  }

  /** Throws CapabilityDeniedError if the role lacks the capability; returns void otherwise. */
  assert(capability: Capability): void {
    if (!this.can(capability)) {
      throw new CapabilityDeniedError(this.role, capability);
    }
  }

  listGranted(): readonly Capability[] {
    return capabilitiesForRole(this.role);
  }
}

export function createCapabilityBroker(role: AgentRole): CapabilityBroker {
  return new CapabilityBroker(role);
}
