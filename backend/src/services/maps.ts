import { AppError } from '../errors.js';
import type { MapDoc } from '../domain/types.js';
import { mapsCollection, type Doc } from '../store/types.js';
import type { Deps } from './common.js';

/** Qualquer coisa com `get` serve: o Store ou uma transação. */
interface Reader {
  get<T extends Doc>(collection: string, id: string): Promise<T | undefined>;
}

/**
 * Lê `maps/{mapId}/versions/{version}`. Versões são imutáveis, então o cache
 * por instância nunca fica desatualizado e poupa uma leitura por requisição.
 */
export async function loadMap(deps: Pick<Deps, 'mapCache'>, reader: Reader, mapId: string, version: number): Promise<MapDoc> {
  const key = `${mapId}@${version}`;
  const hit = deps.mapCache.get(key);
  if (hit) return hit;
  const doc = await reader.get<MapDoc>(mapsCollection(mapId), String(version));
  if (!doc) throw new AppError('INTERNAL', `Mapa ${mapId} v${version} ausente.`);
  deps.mapCache.set(key, doc);
  return doc;
}
