import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Sufixo aleatório curto, legível e sem caracteres ambíguos. */
export function shortId(len = 6): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  return out;
}

export const newMissionId = () => `MS-${shortId(7)}`;
export const newRouteId = () => `RT-${shortId(6)}`;
export const newCommandId = () => `cmd-${shortId(8).toLowerCase()}`;
export const newAlertId = (prefix: string) => `${prefix}-${shortId(6).toLowerCase()}`;

export const eventDocId = (deviceId: string, sessionId: string, sequence: number) =>
  `${deviceId}_${sessionId}_${sequence}`;

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
