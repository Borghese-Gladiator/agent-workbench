import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { tasksApi, type TaskSummary } from '../api/tasks.js';

export function TasksPage() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const result = await tasksApi.list();
      setTasks(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(): Promise<void> {
    if (!repositoryId.trim() || !prompt.trim()) return;
    setBusy(true);
    try {
      const result = await tasksApi.create(repositoryId.trim(), prompt.trim());
      setError(undefined);
      navigate(`/tasks/${repositoryId.trim()}/${result.taskId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Tasks</h1>
      <p className="note">
        This list only shows tasks created since the daemon last started — it is an in-memory,
        process-lifetime record, not a durable registry.
      </p>
      <div className="form-row">
        <input
          type="text"
          placeholder="repository id"
          value={repositoryId}
          onChange={(e) => setRepositoryId(e.target.value)}
        />
        <input
          type="text"
          placeholder="task prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button type="button" disabled={busy} onClick={() => void handleCreate()}>
          Create task
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : tasks.length === 0 ? (
        <p>No tasks created this session yet.</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.workflowId}>
              <Link to={`/tasks/${task.repositoryId}/${task.taskId}`}>{task.taskId}</Link>
              <span className="repository-path">{task.repositoryId}</span>
              <span className="repository-path">{task.prompt}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
