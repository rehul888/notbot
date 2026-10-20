// Database setup that runs by itself: on the first request or cron run of each isolate, the Worker applies every
// migrations/*.sql it hasn't applied yet. It records them in the same d1_migrations table `wrangler d1 migrations
// apply` uses, so both ways stay in step. A deploy (button, imported git repo or CLI) needs no separate database step.
import type { Env } from "./env";

const FILES = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** The migrations in order: [file name, SQL] */
export const MIGRATIONS: [string, string][] = Object.entries(FILES)
  .map(([path, sql]): [string, string] => [path.split("/").pop()!, sql])
  .sort(([a], [b]) => a.localeCompare(b));

/** SQL file → statements. Our migrations only use ";" to end statements; whole-line "--" comments are dropped first. */
export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

async function applied(env: Env): Promise<Set<string>> {
  try {
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    return new Set(results.map((r) => r.name));
  } catch {
    // A brand-new database: no migrations table yet
    await env.DB.prepare(TABLE).run();
    return new Set();
  }
}

async function migrate(env: Env): Promise<void> {
  const done = await applied(env);
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    try {
      // One transaction per file: the unique name row goes first, so if two requests race, only one applies it
      await env.DB.batch([env.DB.prepare("INSERT INTO d1_migrations (name) VALUES (?1)").bind(name), ...splitSql(sql).map((q) => env.DB.prepare(q))]);
      console.log("database migration applied", name);
    } catch (e) {
      const raced = await env.DB.prepare("SELECT 1 FROM d1_migrations WHERE name = ?1").bind(name).first();
      if (!raced) throw e;
    }
  }
}

let ready: Promise<void> | null = null;

/** Resolves once the database schema is current (checked once per isolate; retried after a failure) */
export function ensureSchema(env: Env): Promise<void> {
  ready ??= migrate(env).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}
