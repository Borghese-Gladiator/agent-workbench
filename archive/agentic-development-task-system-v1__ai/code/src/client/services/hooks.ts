import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@client/services/client';
import type {
  Initiative,
  Epic,
  WorkItem,
  Artifact,
  Agent,
  ActivityEvent,
  TerminalSession,
  Comment,
} from '@shared/types';

// --- Initiatives ---

export function useInitiatives() {
  return useQuery<Initiative[]>({
    queryKey: ['initiatives'],
    queryFn: () => apiFetch<Initiative[]>('/initiatives'),
  });
}

export function useCreateInitiative() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      apiFetch<Initiative>('/initiatives', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['initiatives'] }); },
  });
}

// --- Epics ---

type EpicWithCounts = Epic & { workItemCount: number; doneCount: number };
type EpicDetail = Epic & { workItems: WorkItem[] };

export function useEpics(filter?: { initiativeId?: string; status?: string }) {
  const params = new URLSearchParams();
  if (filter?.initiativeId) params.set('initiative_id', filter.initiativeId);
  if (filter?.status) params.set('status', filter.status);
  const qs = params.toString();
  return useQuery<EpicWithCounts[]>({
    queryKey: ['epics', filter ?? 'all'],
    queryFn: () => apiFetch<EpicWithCounts[]>(`/epics${qs ? `?${qs}` : ''}`),
  });
}

export function useEpic(id: string) {
  return useQuery<EpicDetail>({
    queryKey: ['epics', id],
    queryFn: () => apiFetch<EpicDetail>(`/epics/${id}`),
    enabled: !!id,
  });
}

export function useCreateEpic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; description?: string; initiative_id?: string }) =>
      apiFetch<Epic>('/epics', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['epics'] }); },
  });
}

export function useUpdateEpic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...updates }: { id: string; title?: string; description?: string; status?: string }) =>
      apiFetch(`/epics/${id}`, { method: 'PATCH', body: JSON.stringify(updates) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['epics'] }); },
  });
}

// --- Work Items ---

type WorkItemDetail = WorkItem & { tags: string[]; reviews: unknown[]; subItems: WorkItem[]; artifacts: Artifact[]; comments: Comment[] };

type WorkItemFilters = {
  status?: string;
  kind?: string;
  epicId?: string;
  assignedAgentId?: string;
  tag?: string;
  parentId?: string | null;
  lane?: string;
  batchId?: string;
};

export function useWorkItems(filters?: WorkItemFilters) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.kind) params.set('kind', filters.kind);
  if (filters?.epicId) params.set('epic_id', filters.epicId);
  if (filters?.assignedAgentId) params.set('assigned_agent_id', filters.assignedAgentId);
  if (filters?.tag) params.set('tag', filters.tag);
  if (filters?.parentId !== undefined) params.set('parent_id', filters.parentId === null ? 'null' : filters.parentId);
  if (filters?.lane) params.set('lane', filters.lane);
  if (filters?.batchId) params.set('batch_id', filters.batchId);
  const qs = params.toString();
  return useQuery<WorkItem[]>({
    queryKey: ['work-items', filters ?? 'all'],
    queryFn: () => apiFetch<WorkItem[]>(`/work-items${qs ? `?${qs}` : ''}`),
  });
}

export function useWorkItem(id: string) {
  return useQuery<WorkItemDetail>({
    queryKey: ['work-items', id],
    queryFn: () => apiFetch<WorkItemDetail>(`/work-items/${id}`),
    enabled: !!id,
  });
}

export function useCreateWorkItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      kind: string; title: string; body?: string; status?: string; priority?: string;
      epic_id?: string; parent_id?: string; assigned_agent_id?: string; tags?: string[];
    }) =>
      apiFetch<WorkItem>('/work-items', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['work-items'] }); },
  });
}

type UpdateWorkItemInput = {
  id: string;
  title?: string;
  body?: string;
  status?: string;
  priority?: string;
  epic_id?: string | null;
  parent_id?: string | null;
  assigned_agent_id?: string | null;
  reviewer_agent_id?: string | null;
  branch_name?: string | null;
  acceptance_criteria?: string | null;
  awaiting_input?: 0 | 1;
  tags?: string[];
  lane?: string | null;
  depends_on_id?: string | null;
};

export function useUpdateWorkItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...updates }: UpdateWorkItemInput) =>
      apiFetch(`/work-items/${id}`, { method: 'PATCH', body: JSON.stringify(updates) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['work-items'] });
      qc.invalidateQueries({ queryKey: ['epics'] });
    },
  });
}

export function useTransitionWorkItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/work-items/${id}/transition`, { method: 'POST', body: JSON.stringify({ status }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['work-items'] }); },
  });
}

export function useReorderWorkItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: { work_item_id: string; sort_order: number }[]) =>
      apiFetch('/work-items/reorder', { method: 'PUT', body: JSON.stringify({ items }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['work-items'] }); },
  });
}

export function useTags() {
  return useQuery<string[]>({
    queryKey: ['tags'],
    queryFn: () => apiFetch<string[]>('/work-items/tags'),
  });
}

// --- Agents ---

export function useAgents() {
  return useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: () => apiFetch<Agent[]>('/agents'),
  });
}

// --- Activity ---

export function useActivityEvents(filters?: {
  entityType?: string;
  entityId?: string;
  limit?: number;
  refetchInterval?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.entityType) params.set('entity_type', filters.entityType);
  if (filters?.entityId) params.set('entity_id', filters.entityId);
  if (filters?.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return useQuery<ActivityEvent[]>({
    queryKey: ['activity', filters?.entityType, filters?.entityId, filters?.limit],
    queryFn: () => apiFetch<ActivityEvent[]>(`/activity${qs ? `?${qs}` : ''}`),
    refetchInterval: filters?.refetchInterval,
  });
}

// --- Terminal Sessions ---

export function useSessions(filter?: { state?: string }) {
  const params = new URLSearchParams();
  if (filter?.state) params.set('state', filter.state);
  const qs = params.toString();
  return useQuery<TerminalSession[]>({
    queryKey: ['sessions', filter ?? 'all'],
    queryFn: () => apiFetch<TerminalSession[]>(`/sessions${qs ? `?${qs}` : ''}`),
    refetchInterval: 5_000,
  });
}

type SessionDetail = TerminalSession & { workItem?: WorkItem; epic?: Epic };

export function useSession(id: string) {
  return useQuery<SessionDetail>({
    queryKey: ['sessions', id],
    queryFn: () => apiFetch<SessionDetail>(`/sessions/${id}`),
    enabled: !!id,
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) =>
      apiFetch<TerminalSession>('/sessions', { method: 'POST', body: JSON.stringify({ workItemId }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['work-items'] });
    },
  });
}

export function useResumeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<TerminalSession>(`/sessions/${id}/resume`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); },
  });
}

export function useCloseSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['work-items'] });
    },
  });
}

// --- Comments ---

export function useComments(workItemId: string) {
  return useQuery<Comment[]>({
    queryKey: ['comments', workItemId],
    queryFn: () => apiFetch<Comment[]>(`/work-items/${workItemId}/comments`),
    enabled: !!workItemId,
  });
}

export function useCreateComment(workItemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiFetch<Comment>(`/work-items/${workItemId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['comments', workItemId] }); },
  });
}

export function useUpdateComment(workItemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, body }: { commentId: string; body: string }) =>
      apiFetch<Comment>(`/comments/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['comments', workItemId] }); },
  });
}

export function useDeleteComment(workItemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      apiFetch(`/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['comments', workItemId] }); },
  });
}

// --- Terminal paste ---

export function useSendToTerminal() {
  return useMutation({
    mutationFn: ({ sessionId, text }: { sessionId: string; text: string }) =>
      apiFetch<{ ok: true }>(`/sessions/${sessionId}/paste`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
  });
}
