import { Routes, Route, Navigate } from 'react-router-dom';
import { BoardPage } from '@client/pages/BoardPage';
import { EpicsPage } from '@client/pages/EpicsPage';
import { LibraryPage } from '@client/pages/LibraryPage';
import { ActivityPage } from '@client/pages/ActivityPage';
import { WorkItemDetailPage } from '@client/pages/WorkItemDetailPage';
import { EpicDetailPage } from '@client/pages/EpicDetailPage';
import { TerminalPage } from '@client/pages/TerminalPage';

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<BoardPage />} />
      <Route path="/work-items/:id" element={<WorkItemDetailPage />} />
      <Route path="/epics" element={<EpicsPage />} />
      <Route path="/epics/:id" element={<EpicDetailPage />} />
      <Route path="/tasks" element={<LibraryPage />} />
      <Route path="/library" element={<Navigate to="/tasks" replace />} />
      <Route path="/terminal" element={<TerminalPage />} />
      <Route path="/activity" element={<ActivityPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
