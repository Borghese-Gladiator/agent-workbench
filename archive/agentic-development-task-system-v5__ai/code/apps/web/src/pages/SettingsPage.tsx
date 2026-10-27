import { useEffect, useState } from 'react';
import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';

const DENSITY_KEY = 'awb.ui.density';

/**
 * Settings, split by who owns the value:
 *  - "System & diagnostics" is READ-ONLY: it reflects runtime facts (daemon URL, origin) that have no
 *    write route, each labelled with its scope. No editable controls are offered for config the daemon
 *    cannot persist.
 *  - "Preferences" are UI-local only (persisted in localStorage), clearly scoped to this browser.
 */
export function SettingsPage() {
  const daemonProxy = `${window.location.origin} → /api forwards to the daemon`;
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');

  useEffect(() => {
    const saved = window.localStorage.getItem(DENSITY_KEY);
    if (saved === 'compact' || saved === 'comfortable') setDensity(saved);
  }, []);

  function updateDensity(value: 'comfortable' | 'compact'): void {
    setDensity(value);
    window.localStorage.setItem(DENSITY_KEY, value);
  }

  return (
    <div>
      <PageHeader title="Settings" />

      <Panel className="mb-6">
        <PanelHeader
          title="System & diagnostics"
          action={<span className="text-[10px] uppercase tracking-wider text-muted-foreground">Read-only · system</span>}
        />
        <PanelBody>
          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatTile label="Daemon (scope: system)" value={daemonProxy} />
            <StatTile label="Browser origin (scope: session)" value={window.location.origin} />
          </div>
          <p className="text-sm text-muted-foreground">
            These values are runtime facts with no write route, so they are shown read-only. Repository
            trust defaults, the agent provider, and similar workbench-wide settings will appear here once
            the daemon exposes a config write API.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Preferences"
          action={<span className="text-[10px] uppercase tracking-wider text-muted-foreground">UI-local · this browser</span>}
        />
        <PanelBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">Table density</div>
              <div className="text-xs text-muted-foreground">
                Stored locally in this browser (scope: UI-local). Does not affect the daemon.
              </div>
            </div>
            <div className="flex gap-1">
              {(['comfortable', 'compact'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => updateDensity(value)}
                  className={
                    density === value
                      ? 'rounded-md border border-primary bg-primary/10 px-3 py-1 text-sm capitalize text-primary'
                      : 'rounded-md border px-3 py-1 text-sm capitalize text-muted-foreground hover:text-foreground'
                  }
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
