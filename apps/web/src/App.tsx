import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import { AppSidebar } from './components/layout/AppSidebar.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { TaskBoard } from './pages/TaskBoard.js';
import { RepositoriesPage } from './pages/RepositoriesPage.js';
import { RepositoryDetailPage } from './pages/RepositoryDetailPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { TaskDetailPage } from './pages/TaskDetailPage.js';
import { EvidenceRedirectPage } from './pages/EvidenceViewerPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

export function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <AppSidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-8 py-8">
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/board" element={<TaskBoard />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:repositoryId/:taskId" element={<TaskDetailPage />} />
              <Route path="/repositories" element={<RepositoriesPage />} />
              <Route path="/repositories/:repositoryId" element={<RepositoryDetailPage />} />
              <Route path="/evidence" element={<EvidenceRedirectPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  );
}
