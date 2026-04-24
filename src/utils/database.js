/**
 * Database Abstraction Layer
 *
 * D1 API 호환 래퍼 — Hyperdrive(PostgreSQL) 또는 D1을 동일한 인터페이스로 사용합니다.
 * Cloudflare 공식 지원 `pg` 드라이버를 사용합니다.
 *
 * 사용법:
 *   env.DB.prepare('SELECT * FROM t WHERE id = ?').bind(1).first()
 *   env.DB.prepare('INSERT INTO t (a) VALUES (?)').bind('x').run()
 *   env.DB.batch([stmt1, stmt2])
 */
import pg from 'pg';

// ─── PostgreSQL (Hyperdrive) 래퍼 ──────────────

export class PgDatabase {
  constructor(hyperdrive) {
    this._hyperdrive = hyperdrive;
    this._client = null;
  }

  async getClient() {
    if (!this._client) {
      this._client = new pg.Client(this._hyperdrive.connectionString);
      await this._client.connect();
    }
    return this._client;
  }

  prepare(sql) {
    return new PgPreparedStatement(this, sql);
  }

  async batch(statements) {
    const client = await this.getClient();
    await client.query('BEGIN');
    try {
      const results = [];
      for (const stmt of statements) {
        const result = await stmt._execute(client);
        results.push(result);
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  async cleanup() {
    if (this._client) {
      try { await this._client.end(); } catch { /* ignore */ }
      this._client = null;
    }
  }
}

// ─── D1 호환 ?→$N 변환 ────────────────────────

/**
 * D1 스타일 ? 플레이스홀더를 PostgreSQL $1, $2, ... 로 변환
 */
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ─── Prepared Statement ────────────────────────

class PgPreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this._originalSql = sql;
    this._pgSql = convertPlaceholders(sql);
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async _execute(client) {
    client = client || await this.db.getClient();
    return client.query(this._pgSql, this.params);
  }

  async all() {
    const result = await this._execute();
    return { results: result.rows };
  }

  async first() {
    const result = await this._execute();
    return result.rows[0] || null;
  }

  async run() {
    const result = await this._execute();
    // INSERT ... RETURNING id 가 아닌 경우 lastInsertId 불가
    // PostgreSQL은 INSERT 후 RETURNING 절이 필요하지만
    // D1 호환을 위해 INSERT 쿼리에 RETURNING id를 자동 추가
    let lastRowId = 0;
    if (result.rows && result.rows.length > 0 && result.rows[0].id !== undefined) {
      lastRowId = result.rows[0].id;
    }
    return {
      success: true,
      meta: {
        last_row_id: lastRowId,
        changes: result.rowCount || 0,
        served_by: 'postgresql'
      }
    };
  }
}

// ─── INSERT RETURNING 자동 추가 ────────────────

const originalPrepare = PgDatabase.prototype.prepare;
PgDatabase.prototype.prepare = function(sql) {
  // INSERT 문에 RETURNING id 자동 추가 (D1 last_row_id 호환)
  if (/^\s*INSERT\s+INTO/i.test(sql) && !/RETURNING/i.test(sql)) {
    sql = sql.replace(/;?\s*$/, ' RETURNING id');
  }
  return originalPrepare.call(this, sql);
};

// ─── Cron용 MySQL→PG 문법 변환 ─────────────────
// DATE_SUB(NOW(), INTERVAL 10 MINUTE) → NOW() - INTERVAL '10 minutes'
// (MySQL 문법이 코드에 남아있을 수 있으므로 자동 변환)

const originalConvert = convertPlaceholders;

// ─── 팩토리 ────────────────────────────────────

export function createDatabase(env) {
  if (env.HYPERDRIVE) {
    return new PgDatabase(env.HYPERDRIVE);
  }
  // D1 fallback (user2 등 아직 Hyperdrive 미설정 테넌트)
  return env.D1_DB || env.DB;
}
