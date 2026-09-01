import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';

/**
 * Compatibility redirect: the standalone Evidence viewer was folded into the Task Detail Verification
 * tab (TASK-86). `/evidence` is kept only so old links resolve — it looks up a repo + task and forwards
 * to that task's Verification tab, where evidence + QA media now live.
 */
export function EvidenceRedirectPage() {
  const navigate = useNavigate();
  const [repositoryId, setRepositoryId] = useState('');
  const [taskId, setTaskId] = useState('');

  function go(): void {
    if (!repositoryId.trim() || !taskId.trim()) return;
    navigate(`/tasks/${repositoryId.trim()}/${taskId.trim()}?tab=verification`);
  }

  return (
    <div>
      <PageHeader title="Evidence" />
      <Panel>
        <PanelHeader title="Evidence moved into a task's Verification tab" />
        <PanelBody className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Evidence and QA media are now shown under a task's Verification tab. Enter a repository and
            task id to jump there.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="repository id"
              aria-label="Repository id"
              value={repositoryId}
              onChange={(e) => setRepositoryId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go();
              }}
              className="w-64"
            />
            <Input
              placeholder="task id"
              aria-label="Task id"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go();
              }}
              className="w-64"
            />
            <Button onClick={go} disabled={!repositoryId.trim() || !taskId.trim()}>
              Open Verification
            </Button>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
