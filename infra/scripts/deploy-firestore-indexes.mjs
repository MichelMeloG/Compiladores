#!/usr/bin/env node
// Cria no Firestore os índices compostos de backend/firestore.indexes.json (idempotente).
// Índices não cobram por si; só ocupam armazenamento (cota de 1 GiB).
// Uso: node infra/scripts/deploy-firestore-indexes.mjs [--project ID] [--dry-run]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const project = args.includes('--project') ? args[args.indexOf('--project') + 1] : 'compiladores-512823';
const dry = args.includes('--dry-run');
const rawGcloud = process.env.GCLOUD_BIN || 'gcloud';
// No Windows o shell precisa do caminho entre aspas quando há espaços ("Cloud SDK").
const gcloud = process.platform === 'win32' && /\s/.test(rawGcloud) ? `"${rawGcloud}"` : rawGcloud;

const file = JSON.parse(readFileSync(join(here, '..', '..', 'backend', 'firestore.indexes.json'), 'utf8'));

let created = 0;
let existing = 0;
let failed = 0;
for (const ix of file.indexes ?? []) {
  const cmd = [
    'firestore', 'indexes', 'composite', 'create',
    `--project=${project}`,
    `--collection-group=${ix.collectionGroup}`,
    `--query-scope=${ix.queryScope === 'COLLECTION_GROUP' ? 'collection-group' : 'collection'}`,
    '--async',
    ...ix.fields.map((f) => `--field-config=field-path=${f.fieldPath},order=${f.order.toLowerCase()}`),
  ];
  const label = `${ix.collectionGroup}(${ix.fields.map((f) => f.fieldPath).join(',')})`;
  if (dry) {
    console.log('DRY', gcloud, cmd.join(' '));
    continue;
  }
  const r = spawnSync(gcloud, cmd, { encoding: 'utf8', shell: process.platform === 'win32' });
  const out = `${r.stdout}${r.stderr}`;
  if (r.status === 0) {
    created++;
    console.log('criado ', label);
  } else if (/already exists|ALREADY_EXISTS/i.test(out)) {
    existing++;
    console.log('já existe', label);
  } else {
    failed++;
    console.error('FALHOU ', label, '\n', out.trim().split('\n').slice(-3).join('\n'));
  }
}
console.log(`\nÍndices: ${created} criados, ${existing} já existiam, ${failed} falharam.`);
process.exit(failed ? 1 : 0);
