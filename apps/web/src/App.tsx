import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { RepositoriesPage } from './pages/RepositoriesPage.js';
import { RepositoryDetailPage } from './pages/RepositoryDetailPage.js';

export function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <nav className="app-nav">
          <NavLink to="/" end>
            Repositories
          </NavLink>
          <NavLink to="/tasks">Tasks</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<RepositoriesPage />} />
            <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
