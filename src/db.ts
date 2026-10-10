import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Tiny query interface shared by both backends:
 *  - DATABASE_URL set  -> real Postgres via `pg` (e.g. the docker-compose service)
 *  - otherwise         -> embedded PGlite (Postgres compiled to WASM), persisted to PGLITE_DIR
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: "postgres" | "pglite";
}

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sql");

async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    // Return NUMERIC and BIGINT (e.g. count(*)) as JS numbers.
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
    pg.types.setTypeParser(pg.types.builtins.INT8, Number);
    const pool = new pg.Pool({ connectionString: url });
    return {
      kind: "postgres",
      async query(sql, params) {
        return (await pool.query(sql, params)).rows;
      },
      async exec(sql) {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  }

  const { PGlite, types } = await import("@electric-sql/pglite");
  const dataDir = process.env.PGLITE_DIR ?? path.resolve(SQL_DIR, "..", ".pglite");
  const lite = await PGlite.create(dataDir, {
    parsers: { [types.NUMERIC]: Number, [types.INT8]: Number },
  });
  return {
    kind: "pglite",
    async query(sql, params) {
      return (await lite.query(sql, params)).rows as never[];
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    close: () => lite.close(),
  };
}

let dbPromise: Promise<Db> | undefined;

/** Shared connection; creates schema + seed data on first use if the DB is empty. */
export function getDb(): Promise<Db> {
  dbPromise ??= (async () => {
    const db = await createDb();
    const [{ exists }] = await db.query<{ exists: boolean }>(
      "SELECT to_regclass('public.products') IS NOT NULL AS exists",
    );
    if (!exists) await resetDb(db);
    return db;
  })();
  return dbPromise;
}

/** Drop and recreate all tables, then load the sample data. */
export async function resetDb(db: Db): Promise<void> {
  await db.exec(await readFile(path.join(SQL_DIR, "schema.sql"), "utf8"));
  await db.exec(await readFile(path.join(SQL_DIR, "seed.sql"), "utf8"));
}
