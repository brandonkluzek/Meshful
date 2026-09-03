// Provider-free D1-shaped test adapter only; never import this into a Worker.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export const learnerDataMigration = new URL("../migrations/0001_learner_data.sql", import.meta.url);

/** Runs the supplied SQL migration against this local test database. */
export function applyMigration(db, path = learnerDataMigration) {
  db.exec(readFileSync(path, "utf8"));
  return db;
}

/**
 * Uses a real SQLite transaction to model D1 batch rollback and file reload.
 * It is local persistence evidence, not a Cloudflare or Sites acceptance test.
 * beforeStatement({index, sql, values}) may throw to inject a mid-batch failure.
 */
export class SqliteD1 {
  constructor(path = ":memory:", { beforeStatement } = {}) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.beforeStatement = beforeStatement;
  }

  prepare(sql) {
    return new SqliteD1Statement(this, sql, []);
  }

  exec(sql) {
    this.database.exec(sql);
    return this;
  }

  applyMigration(path = learnerDataMigration) {
    return applyMigration(this, path);
  }

  async batch(statements) {
    // No await while SQLite owns the transaction: another test cannot interleave
    // on this connection. Separate file connections still obey SQLite locks.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement, index) => {
        if (!(statement instanceof SqliteD1Statement) || statement.owner !== this) {
          throw new TypeError("Batch statements must belong to this database");
        }
        this.beforeStatement?.({ index, sql: statement.sql, values: [...statement.values] });
        return statement.execute();
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

class SqliteD1Statement {
  constructor(owner, sql, values) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new SqliteD1Statement(this.owner, this.sql, values);
  }

  execute() {
    const prepared = this.owner.database.prepare(this.sql);
    const before = this.owner.database.prepare("SELECT total_changes() AS total").get().total;
    const results = prepared.all(...this.values).map((row) => ({ ...row }));
    const after = this.owner.database.prepare("SELECT total_changes() AS total").get().total;
    return {
      success: true,
      results,
      meta: { changes: after - before },
    };
  }

  async first(column) {
    const row = this.execute().results[0];
    return row ? (column === undefined ? row : row[column]) : null;
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }
}
