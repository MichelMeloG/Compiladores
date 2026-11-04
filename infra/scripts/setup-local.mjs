import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const backendEnv = fileURLToPath(new URL('../../backend/.env', import.meta.url));
const dashboardEnv = fileURLToPath(new URL('../../dashboard/.env.local', import.meta.url));
if (!existsSync(backendEnv)) {
  writeFileSync(backendEnv, [
    'NODE_ENV=development', 'STORE=memory', 'AUTH_MODE=off', 'PORT=8080',
    'LOG_LEVEL=info', `DEVICE_SECRETS_JSON=${JSON.stringify({ 'RB-01': randomBytes(32).toString('hex') })}`,
    'SEED_PROFILE=clean', 'CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000', '',
  ].join('\n'), { flag: 'wx' });
  console.log('Criado backend/.env local com segredo aleatorio. Nao compartilhe nem versione esse arquivo.');
} else console.log('backend/.env existente preservado: confira STORE=memory e AUTH_MODE=off.');
if (!existsSync(dashboardEnv)) {
  writeFileSync(dashboardEnv, 'VITE_API_URL=/api\nVITE_DEMO=false\nVITE_FIREBASE_API_KEY=\n', { flag: 'wx' });
  console.log('Criado dashboard/.env.local sem acesso a nuvem.');
} else console.log('dashboard/.env.local existente preservado: confira API local e Firebase desativado.');
