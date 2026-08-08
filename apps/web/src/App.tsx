import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppSidebar } from './components/layout/AppSidebar.js';
import { RepositoriesPage } from './pages/RepositoriesPage.js';
import { RepositoryDetailPage } from './pages/RepositoryDetailPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { TaskDetailPage } from './pages/TaskDetailPage.js';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { EvidenceViewerPage } from './pages/EvidenceViewerPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

export function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <AppSidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-8 py-8">
            <Routes>
              <Route path="/" element={<RepositoriesPage />} />
              <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:repositoryId/:taskId" element={<TaskDetailPage />} />
              <Route path="/approvals" element={<ApprovalsPage />} />
              <Route path="/evidence" element={<EvidenceViewerPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  );
}
