import { PageHeader } from '../components/PageHeader.js';
import { Note } from '../components/Note.js';

export function SettingsPage() {
  const daemonBaseUrl = `${window.location.origin} (proxied /api requests forward to the daemon)`;

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <dl className="task-facts">
        <dt>Daemon base URL</dt>
        <dd>{daemonBaseUrl}</dd>
      </dl>
      <Note>
        There is no daemon route yet to read or write persisted configuration, so this page is a
        placeholder. Once wired up, this is where repository trust defaults, the agent provider, and
        similar workbench-wide settings will live.
      </Note>
    </div>
  );
}
