import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

/**
 * Bootstrap da aplicação.
 *
 * Em builds normais, `VITE_DEMO` não está definido e o bloco abaixo é
 * eliminado pelo Vite — nada do diretório `src/demo/` entra no bundle.
 * Ele só é incluído na publicação estática (GitHub Pages), onde não há
 * backend para responder às requisições.
 */
async function bootstrap() {
  if (import.meta.env.VITE_DEMO === 'true') {
    const { installDemoBackend } = await import('./demo/demoBackend');
    installDemoBackend(import.meta.env.VITE_API_URL || '/api');
  }

  createRoot(document.getElementById('root')!).render(<App />);
}

bootstrap();
