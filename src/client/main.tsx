import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminPage } from './admin';
import { AccessPage, HomePage, JoinPage, MePage, NotFoundPage, ResultsPage } from './pages';
import { usePath } from './router';
import './styles.css';

function App() {
  const path = usePath().replace(/\/+$/, '') || '/';
  switch (path) {
    case '/':
      return <HomePage />;
    case '/join':
      return <JoinPage />;
    case '/access':
      return <AccessPage />;
    case '/me':
      return <MePage />;
    case '/results':
      return <ResultsPage />;
    case '/admin':
      return <AdminPage />;
    default:
      return <NotFoundPage />;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
