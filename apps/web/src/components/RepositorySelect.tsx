import { useMemo, useState } from 'react';
import type { Repository } from '../api/client.js';

/**
 * Searchable repository picker that displays repository names and yields the repository id to the
 * caller. Users never type or see a UUID. Uses a native datalist-backed text input filtered by name
 * or path so it stays dependency-free while remaining keyboard- and screen-reader-accessible.
 */
export function RepositorySelect({
  repositories,
  value,
  onChange,
  id,
}: {
  repositories: Repository[];
  value: string;
  onChange: (repositoryId: string) => void;
  id: string;
}) {
  const selected = repositories.find((r) => r.id === value);
  const [text, setText] = useState(selected?.name ?? '');
  const listId = `${id}-options`;

  const byLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of repositories) map.set(r.name, r.id);
    return map;
  }, [repositories]);

  return (
    <>
      <input
        id={id}
        list={listId}
        className="repo-select-input"
        placeholder="Search repositories…"
        value={text}
        autoComplete="off"
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const matchedId = byLabel.get(next);
          onChange(matchedId ?? '');
        }}
      />
      <datalist id={listId}>
        {repositories.map((r) => (
          <option key={r.id} value={r.name}>
            {r.canonicalPath}
          </option>
        ))}
      </datalist>
    </>
  );
}
