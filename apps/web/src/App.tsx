import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
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
      <div className="app-shell">
        <nav className="app-nav">
          <NavLink to="/" end>
            Repositories
          </NavLink>
          <NavLink to="/tasks">Tasks</NavLink>
          <NavLink to="/approvals">Approvals</NavLink>
          <NavLink to="/evidence">Evidence</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<RepositoriesPage />} />
            <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tasks/:repositoryId/:taskId" element={<TaskDetailPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/evidence" element={<EvidenceViewerPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
