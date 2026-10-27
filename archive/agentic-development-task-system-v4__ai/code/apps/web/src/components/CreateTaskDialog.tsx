import type { Project } from '@workbench/core';
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../api.js';

/** The intake form body, shared by the modal and the full-page fallback. */
function CreateTaskForm({ onDone }: { onDone?: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [rawRequest, setRawRequest] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nav = useNavigate();
  const titleId = useId();
  const reqId = useId();

  useEffect(() => {
    api
      .listProjects()
      .then((p) => {
        setProjects(p);
        if (p[0]) setProjectId(p[0].id);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const task = await api.createTask({ projectId, title, rawRequest });
      onDone?.();
      nav(`/tasks/${task.id}`);
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Create a project first in the Project Registry.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <div className="text-sm text-danger">{error}</div>}
      <div className="space-y-1.5">
        <Label>Project</Label>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger>
            <SelectValue placeholder="Choose a project…" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={titleId}>Title</Label>
        <Input id={titleId} value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={reqId}>Raw request</Label>
        <Textarea
          id={reqId}
          value={rawRequest}
          onChange={(e) => setRawRequest(e.target.value)}
          placeholder="Describe what you want done, in your own words…"
          required
        />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        {onDone && (
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
        )}
        <Button disabled={saving}>{saving ? 'Creating…' : 'Create task'}</Button>
      </div>
    </form>
  );
}

/** Modal variant — used from the Board top bar. */
export function CreateTaskDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>The task starts in Intake.</DialogDescription>
        </DialogHeader>
        {/* Remount the form each open so it resets cleanly. */}
        {open && <CreateTaskForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** Full-page variant — the deep-linkable /new route fallback. */
export function CreateTaskPage() {
  return (
    <Card className="max-w-[640px]">
      <CardContent className="p-4">
        <CreateTaskForm />
      </CardContent>
    </Card>
  );
}
