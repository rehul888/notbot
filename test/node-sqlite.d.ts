// Node's built-in SQLite (used by test/refund.test.ts); the project has no @types/node
declare module "node:sqlite" {
  interface StatementSync {
    all(...params: never[]): unknown[];
    get(...params: never[]): unknown;
    run(...params: never[]): { changes: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
