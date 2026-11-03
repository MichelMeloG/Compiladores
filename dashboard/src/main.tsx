import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { AuthGate } from './components/AuthGate';
import './index.css';

/**
 * Bootstrap da aplicação.
 *
 * Em builds normais, `VITE_DEMO` não está definido e o bloco abaixo é
 * eliminado pelo Vite — nada do diretório `src/demo/` entra no bundle.
 * Ele só é incluído quando o modo de demonstração é pedido explicitamente.
 */
async function bootstrap() {
  if (import.meta.env.VITE_DEMO === 'true') {
    const { installDemoBackend } = await import('./demo/demoBackend');
    installDemoBackend(import.meta.env.VITE_API_URL || '/api');
  }

  const demo = import.meta.env.VITE_DEMO === 'true';
  const authenticated = import.meta.env.PROD || Boolean(import.meta.env.VITE_FIREBASE_API_KEY);
  createRoot(document.getElementById('root')!).render(
    demo || !authenticated ? <App /> : <AuthGate><App /></AuthGate>
  );
}

bootstrap();
