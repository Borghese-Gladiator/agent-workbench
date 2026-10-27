import type { CommandPurpose, CommandSource } from '@awb/domain';

/** A command discovered from a specific provenance, prior to being persisted as a ValidatedCommand. */
export interface DiscoveredCommand {
  purpose: CommandPurpose;
  command: string;
  cwd: string;
  source: CommandSource;
}
