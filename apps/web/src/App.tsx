import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Login } from '@/pages/Login';
import { Dashboard } from '@/pages/Dashboard';
import { ModulePlaceholder } from '@/pages/ModulePlaceholder';
import { MODULES } from '@/lib/modules';
import { RequireAuth } from '@/lib/auth';

export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Dashboard /> },
      ...MODULES.map((m) => ({
        path: m.path.replace(/^\//, ''),
        element: (
          <ModulePlaceholder
            moduleKey={m.key}
            title={m.label}
            description={m.description}
          />
        ),
      })),
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
