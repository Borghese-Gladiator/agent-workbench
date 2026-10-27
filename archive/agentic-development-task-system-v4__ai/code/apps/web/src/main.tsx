import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles.css';
import { App } from './App.js';
import { Board } from './pages/Board.js';
import { NewTask } from './pages/NewTask.js';
import { Projects } from './pages/Projects.js';
import { TaskDetailPage } from './pages/TaskDetail.js';
import { Usage } from './pages/Usage.js';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Board /> },
      { path: 'projects', element: <Projects /> },
      { path: 'usage', element: <Usage /> },
      { path: 'new', element: <NewTask /> },
      { path: 'tasks/:id', element: <TaskDetailPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
