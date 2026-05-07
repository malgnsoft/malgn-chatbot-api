/**
 * Database Abstraction Layer
 *
 * D1 API 호환 래퍼 — Hyperdrive(MySQL) 또는 D1을 동일한 인터페이스로 사용합니다.
 * Cloudflare 공식 지원 `mysql2/promise` 드라이버를 사용합니다.
 *
 * 사용법:
 *   env.DB.prepare('SELECT * FROM t WHERE id = ?').bind(1).first()
 *   env.DB.prepare('INSERT INTO t (a) VALUES (?)').bind('x').run()
 *   env.DB.batch([stmt1, stmt2])
 *
 * 동시성 처리:
 *   mysql2의 single connection은 동시 query를 처리할 수 없습니다.
 *   따라서 isolate 단위로 connection pool을 캐시하여 동시 요청을 안전하게 분산합니다.
 *   pool.query()는 풀에서 자동으로 connection을 꺼내 사용 후 반납합니다.
 */
import mysql from 'mysql2/promise';

// ─── isolate-scoped connection pool ─────────────
let _pool = null;
let _poolKey = null;

async function getPool(hyperdrive) {
  const key = `${hyperdrive.host}:${hyperdrive.port}/${hyperdrive.database}`;

  // 다른 환경의 풀이면 폐기 후 재생성
  if (_pool && _poolKey !== key) {
    const old = _pool;
    _pool = null;
    _poolKey = null;
    try { await old.end(); } catch { /* ignore */ }
  }

  if (!_pool) {
    _pool = mysql.createPool({
      host: hyperdrive.host,
      port: hyperdrive.port,
      user: hyperdrive.user,
      password: hyperdrive.password,
      database: hyperdrive.database,
      // Cloudflare Workers 환경 필수
      disableEval: true,
      // 풀 설정
      waitForConnections: true,
      connectionLimit: 6,
      queueLimit: 0,
    });
    _poolKey = key;
  }
  return _pool;
}

function isFatalConnectionError(err) {
  if (!err) return false;
  const code = err.code || '';
  return (
    err.fatal === true ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ER_SERVER_SHUTDOWN'
  );
}

// ─── MySQL (Hyperdrive) 래퍼 ───────────────────

export class MySqlDatabase {
  constructor(hyperdrive) {
    this._hyperdrive = hyperdrive;
  }

  // 호환용: pool 반환 (직접 사용은 권장하지 않음, batch 트랜잭션 등에서만 사용)
  async getConn() {
    return getPool(this._hyperdrive);
  }

  prepare(sql) {
    return new MySqlPreparedStatement(this, sql);
  }

  async batch(statements) {
    const pool = await getPool(this._hyperdrive);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const results = [];
      for (const stmt of statements) {
        const result = await stmt._execute(conn);
        results.push(result);
      }
      await conn.commit();
      return results;
    } catch (error) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw error;
    } finally {
      conn.release();
    }
  }

  // No-op: pool은 isolate-scoped로 재사용. isolate 종료 시 자동 정리.
  async cleanup() { /* no-op */ }
}

// ─── Prepared Statement ────────────────────────

class MySqlPreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this._sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  /**
   * @param {*} conn — 명시적 connection (트랜잭션 등). 없으면 pool에서 자동 처리.
   */
  async _execute(conn) {
    if (conn) {
      // batch 트랜잭션 등에서 명시적 connection
      return conn.query(this._sql, this.params);
    }
    const pool = await this.db.getConn();
    try {
      return await pool.query(this._sql, this.params);
    } catch (e) {
      // pool은 stale connection을 자체 처리하지만 fatal 에러 시 1회 재시도
      if (isFatalConnectionError(e)) {
        return pool.query(this._sql, this.params);
      }
      throw e;
    }
  }

  async all() {
    const [rows] = await this._execute();
    return { results: rows };
  }

  async first() {
    const [rows] = await this._execute();
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  async run() {
    const [result] = await this._execute();
    return {
      success: true,
      meta: {
        last_row_id: result?.insertId || 0,
        changes: result?.affectedRows || 0,
        served_by: 'mysql'
      }
    };
  }
}

// ─── 팩토리 ────────────────────────────────────

export function createDatabase(env) {
  if (env.HYPERDRIVE) {
    return new MySqlDatabase(env.HYPERDRIVE);
  }
  // D1 fallback (Hyperdrive 미설정 테넌트)
  return env.D1_DB || env.DB;
}
