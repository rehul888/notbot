// A real SQLite database (node:sqlite) with the project's migrations behind a minimal D1 interface, for tests that need
// real SQL: batch() runs as one transaction, like D1.
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../worker/env";

const MIGRATIONS = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** A real SQLite database with the project's migrations behind a minimal D1 interface (batch = one transaction). */
export function d1() {
  const db = new DatabaseSync(":memory:");
  for (const f of Object.keys(MIGRATIONS).sort()) db.exec(MIGRATIONS[f]);
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    exec() {
      const s = db.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql)) return { results: s.all(...(args as never[])), meta: { changes: 0 } };
      const r = s.run(...(args as never[]));
      return { results: [], meta: { changes: Number(r.changes) } };
    },
    first: async () => stmt(sql, args).exec().results[0] ?? null,
    all: async () => stmt(sql, args).exec(),
    run: async () => stmt(sql, args).exec(),
  });
  const DB = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: ReturnType<typeof stmt>[]) => {
      db.exec("BEGIN");
      try {
        const out = list.map((s) => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { env: { DB, BOT_TOKEN: "t" } as unknown as Env, db };
}

