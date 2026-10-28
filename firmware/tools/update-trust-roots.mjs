// Raízes públicas; nunca baixa ou usa credenciais do projeto.
import { X509Certificate } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const fingerprints = new Set([
  'D947432ABDE7B7FA90FC2E6B59101B1280E0E1C7E4E40FA3C6887FFF57A7F4CF',
  '8D25CD97229DBF70356BDA4EB3CC734031E24CF00FAFCFD32DC76EB5841C7EA8',
  '34D8A73EE208D9BCDB0D956520934B4E40E69482596E8B6F73C8426B010A6F48',
  '349DFA4058C5E263123B398AE795573C4E1313C83FE68F93556CD5E8031B3C7D',
]);
const response = await fetch('https://pki.goog/roots.pem');
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const certs = (await response.text()).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
const selected = certs.filter(pem => fingerprints.has(new X509Certificate(pem).fingerprint256.replaceAll(':', '')));
if (selected.length !== 4) {
  for (const pem of certs) {
    const c = new X509Certificate(pem);
    if (c.subject.includes('GTS Root')) console.log(c.subject, c.fingerprint256.replaceAll(':', ''));
  }
  throw new Error('Esperadas as quatro raízes GTS verificadas em PROVISIONAMENTO.md.');
}
await writeFile(new URL('../roboflow_esp32/trust_roots.h', import.meta.url),
  '#pragma once\n// GTS Root R1..R4 de https://pki.goog/roots.pem; fingerprints verificados.\n' +
  'static const char ROOT_CAS[] = R"PEM(\n' + selected.join('\n') + '\n)PEM";\n');
console.log('Quatro raízes GTS verificadas e gravadas.');
