import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_REGISTRY, schemaFor } from '../src/index.js';

const root = join(import.meta.dirname, '..', 'fixtures');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(root).filter((f) => f.endsWith('.json'));

describe('fixtures', () => {
  it('existem exemplos válidos e inválidos', () => {
    expect(files.filter((f) => f.endsWith('.valid.json')).length).toBeGreaterThan(40);
    expect(files.filter((f) => f.endsWith('.invalid.json')).length).toBeGreaterThan(40);
  });

  for (const file of files) {
    const rel = file.slice(root.length + 1).replace(/\\/g, '/');
    it(rel, () => {
      const { schema, value } = JSON.parse(readFileSync(file, 'utf8')) as {
        schema: string;
        value: unknown;
      };
      expect(SCHEMA_REGISTRY.has(schema), `schema ${schema} não registrado`).toBe(true);
      const result = schemaFor(schema).safeParse(value);
      if (file.endsWith('.valid.json')) {
        expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      } else {
        expect(result.success, 'a fixture inválida foi aceita').toBe(false);
      }
    });
  }

  it('todo endpoint tem pelo menos uma fixture de resposta válida', () => {
    const used = new Set(
      files
        .filter((f) => f.endsWith('.valid.json'))
        .map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { schema: string }).schema)
    );
    const missing = [...SCHEMA_REGISTRY.keys()]
      .filter((k) => k.endsWith('.response'))
      .filter((k) => !used.has(k));
    expect(missing).toEqual([]);
  });
});
