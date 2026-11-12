/** Real application modules against a local SQLite implementation of D1. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export async function createHarness({ scheduler = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const synchronousRuns = new WeakMap();
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      const wrapped = {
        bind(...args) { values = args; return wrapped; },
        async first(column) { const row = statement.get(...values) ?? null; return column && row ? row[column] : row; },
        async all() { return { success: true, results: statement.all(...values), meta: {} }; },
        async run() { return synchronousRuns.get(wrapped)(); },
      };
      synchronousRuns.set(wrapped, () => {
        const result = statement.run(...values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      });
      return wrapped;
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(synchronousRuns.get(statement)());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const envKey = `__pipelineTestEnv_${crypto.randomUUID().replaceAll('-', '')}`;
  globalThis[envKey] = { DB: db };
  const root = fileURLToPath(new URL('..', import.meta.url));
  const entrypoints = ['engine', 'functions', 'store', 'validation', ...(scheduler ? ['scheduler'] : [])];
  const bundled = await build({
    absWorkingDir: root,
    stdin: { contents: entrypoints.map(name => `export * from './lib/server/${name}.ts';`).join('\n'), resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22',
    plugins: [{
      name: 'test-d1-binding',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-env', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export const env = globalThis[${JSON.stringify(envKey)}];`, loader: 'js' }));
      },
    }],
  });
  const engine = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  return {
    sqlite, db, engine,
    reset() {
      // Apply every migration to an empty database, including future scheduler
      // tables. Keeping a hard-coded tasks/runs list leaves new tables behind.
      for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        sqlite.exec(`DROP TABLE ${JSON.stringify(name)}`);
      }
      const migrations = new URL('../drizzle/', import.meta.url);
      for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
        sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
      }
    },
    close() { sqlite.close(); delete globalThis[envKey]; },
  };
}

export function functionSpec(overrides = {}) {
  return { id: crypto.randomUUID(), name: '计数', type: 'code', enabled: true, handler: 'counter.increment', config: { key: 'count', amount: 1 }, retries: 0, onError: 'stop', ...overrides };
}
