import { Command } from 'commander';
import { initDataDir } from '@awb/config';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Initialize the local Agentic Workbench data directory')
    .action(() => {
      const { layout, created } = initDataDir();
      if (created) {
        console.log(`Initialized Agentic Workbench data directory at ${layout.root}`);
      } else {
        console.log(`Agentic Workbench data directory already exists at ${layout.root}`);
      }
    });
}
