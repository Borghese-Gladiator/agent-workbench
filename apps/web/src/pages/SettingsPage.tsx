import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';

export function SettingsPage() {
  const daemonBaseUrl = `${window.location.origin} (proxied /api requests forward to the daemon)`;

  return (
    <div>
      <PageHeader title="Settings" />

      <div className="mb-4 grid grid-cols-1">
        <StatTile label="Daemon base URL" value={daemonBaseUrl} />
      </div>

      <Panel>
        <PanelHeader title="About this page" />
        <PanelBody className="text-sm text-muted-foreground">
          There is no daemon route yet to read or write persisted configuration, so this page is a
          placeholder. Once wired up, this is where repository trust defaults, the agent provider,
          and similar workbench-wide settings will live.
        </PanelBody>
      </Panel>
    </div>
  );
}
