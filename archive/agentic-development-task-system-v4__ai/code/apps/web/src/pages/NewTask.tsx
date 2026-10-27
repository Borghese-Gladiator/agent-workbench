import { CreateTaskPage } from '@/components/CreateTaskDialog';
import { usePageHeader } from '@/components/PageHeader';

/** Deep-linkable /new route: renders the intake form full-page. */
export function NewTask() {
  usePageHeader({ title: 'New Task — Intake' });
  return <CreateTaskPage />;
}
