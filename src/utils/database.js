/**
 * Database Abstraction Layer
 *
 * D1 API 호환 래퍼 — Hyperdrive(MySQL) 또는 D1을 동일한 인터페이스로 사용합니다.
 * Workers의 connect() TCP 소켓 + MySQL 프로토콜로 직접 통신합니다.
 * (mysql2 패키지는 Workers에서 new Function() 차단으로 사용 불가)
 *
 * 사용법:
 *   env.DB.prepare('SELECT * FROM t WHERE id = ?').bind(1).first()
 *   env.DB.prepare('INSERT INTO t (a) VALUES (?)').bind('x').run()
 *   env.DB.batch([stmt1, stmt2])
 */
import { connect } from 'cloudflare:sockets';

// ─── SQL 파라미터 이스케이프 ────────────────────

function escapeValue(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') {
    if (!isFinite(val)) return 'NULL';
    return String(val);
  }
  if (typeof val === 'boolean') return val ? '1' : '0';
  const str = String(val)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\x00/g, '\\0')
    .replace(/\x1a/g, '\\Z');
  return `'${str}'`;
}

function formatQuery(sql, params) {
  if (!params || params.length === 0) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    if (i >= params.length) return '?';
    return escapeValue(params[i++]);
  });
}

// ─── MySQL 프로토콜 헬퍼 ──────────────────────

function readLenEncInt(buf, offset) {
  const first = buf[offset];
  if (first < 0xfb) return { value: first, length: 1 };
  if (first === 0xfc) return { value: buf[offset + 1] | (buf[offset + 2] << 8), length: 3 };
  if (first === 0xfd) return { value: buf[offset + 1] | (buf[offset + 2] << 8) | (buf[offset + 3] << 16), length: 4 };
  if (first === 0xfe) {
    const low = buf[offset + 1] | (buf[offset + 2] << 8) | (buf[offset + 3] << 16) | (buf[offset + 4] << 24);
    return { value: low, length: 9 };
  }
  return { value: null, length: 1 }; // 0xfb = NULL
}

function readLenEncString(buf, offset) {
  if (buf[offset] === 0xfb) return { value: null, length: 1 };
  const { value: len, length: intLen } = readLenEncInt(buf, offset);
  const str = new TextDecoder().decode(buf.subarray(offset + intLen, offset + intLen + len));
  return { value: str, length: intLen + len };
}

function writeLenEncString(str) {
  const encoded = new TextEncoder().encode(str);
  const lenBytes = encoded.length < 0xfb ? 1 : encoded.length < 0x10000 ? 3 : 4;
  const buf = new Uint8Array(lenBytes + encoded.length);
  if (lenBytes === 1) {
    buf[0] = encoded.length;
  } else if (lenBytes === 3) {
    buf[0] = 0xfc;
    buf[1] = encoded.length & 0xff;
    buf[2] = (encoded.length >> 8) & 0xff;
  }
  buf.set(encoded, lenBytes);
  return buf;
}

function makePacket(seqId, payload) {
  const buf = new Uint8Array(4 + payload.length);
  buf[0] = payload.length & 0xff;
  buf[1] = (payload.length >> 8) & 0xff;
  buf[2] = (payload.length >> 16) & 0xff;
  buf[3] = seqId;
  buf.set(payload, 4);
  return buf;
}

// SHA1 for mysql_native_password
async function sha1(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', data));
}

async function scramble(password, seed) {
  const enc = new TextEncoder().encode(password);
  const hash1 = await sha1(enc);
  const hash2 = await sha1(hash1);
  const combined = new Uint8Array(seed.length + hash2.length);
  combined.set(seed);
  combined.set(hash2, seed.length);
  const hash3 = await sha1(combined);
  const result = new Uint8Array(20);
  for (let i = 0; i < 20; i++) result[i] = hash1[i] ^ hash3[i];
  return result;
}

// ─── MySQL 소켓 클라이언트 ─────────────────────

class MysqlConnection {
  constructor(socket, reader, writer) {
    this.socket = socket;
    this.reader = reader;
    this.writer = writer;
    this.buffer = new Uint8Array(0);
    this.seqId = 0;
    // 쿼리 직렬화 뮤텍스 (TCP 소켓은 동시 read 불가)
    this._lock = Promise.resolve();
  }

  static async connect(host, port, user, password, database) {
    const socket = connect({ hostname: host, port });
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    const conn = new MysqlConnection(socket, reader, writer);

    // 1. Read server greeting
    const greeting = await conn.readPacket();
    const authPlugin = conn.parseGreeting(greeting);

    // 2. Send handshake response
    await conn.sendHandshake(user, password, database, authPlugin);

    // 3. Read auth response
    const authResp = await conn.readPacket();
    if (authResp.payload[0] === 0xff) {
      const msg = new TextDecoder().decode(authResp.payload.subarray(9));
      throw new Error(`MySQL auth failed: ${msg}`);
    }

    // Handle auth switch (0xfe)
    if (authResp.payload[0] === 0xfe) {
      const pluginEnd = authResp.payload.indexOf(0, 1);
      const plugin = new TextDecoder().decode(authResp.payload.subarray(1, pluginEnd));
      const seed = authResp.payload.subarray(pluginEnd + 1, authResp.payload.length - 1);

      if (plugin === 'mysql_native_password') {
        const auth = await scramble(password, seed);
        await conn.writePacket(auth);
      } else if (plugin === 'caching_sha2_password') {
        // Send password scrambled with sha256
        const auth = await conn.cachingSha2Scramble(password, seed);
        await conn.writePacket(auth);
      }

      const switchResp = await conn.readPacket();
      if (switchResp.payload[0] === 0xff) {
        const msg = new TextDecoder().decode(switchResp.payload.subarray(9));
        throw new Error(`MySQL auth switch failed: ${msg}`);
      }
      // Handle caching_sha2_password fast auth (0x01 0x03 = success, 0x01 0x04 = full auth needed)
      if (switchResp.payload[0] === 0x01 && switchResp.payload[1] === 0x04) {
        // Full auth required - send password in clear (over TLS)
        const clearPwd = new TextEncoder().encode(password + '\0');
        await conn.writePacket(clearPwd);
        const finalResp = await conn.readPacket();
        if (finalResp.payload[0] === 0xff) {
          const msg = new TextDecoder().decode(finalResp.payload.subarray(9));
          throw new Error(`MySQL full auth failed: ${msg}`);
        }
      }
    }

    return conn;
  }

  async cachingSha2Scramble(password, seed) {
    const enc = new TextEncoder().encode(password);
    const hash1 = new Uint8Array(await crypto.subtle.digest('SHA-256', enc));
    const hash2 = new Uint8Array(await crypto.subtle.digest('SHA-256', hash1));
    const combined = new Uint8Array(hash2.length + seed.length);
    combined.set(hash2);
    combined.set(seed, hash2.length);
    const hash3 = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
    const result = new Uint8Array(32);
    for (let i = 0; i < 32; i++) result[i] = hash1[i] ^ hash3[i];
    return result;
  }

  parseGreeting(packet) {
    const data = packet.payload;
    // Skip protocol version (1) + server version (null-terminated)
    let offset = 1;
    while (data[offset] !== 0) offset++;
    offset++; // skip null
    // connection id (4 bytes)
    offset += 4;
    // auth-plugin-data-part-1 (8 bytes)
    this.seed1 = data.subarray(offset, offset + 8);
    offset += 8;
    offset++; // filler
    // capability flags lower (2)
    offset += 2;
    // character set (1), status flags (2), capability flags upper (2)
    offset += 5;
    // length of auth-plugin-data (1)
    const authLen = data[offset];
    offset++;
    // reserved (10)
    offset += 10;
    // auth-plugin-data-part-2
    const seed2Len = Math.max(13, authLen - 8);
    this.seed2 = data.subarray(offset, offset + seed2Len - 1); // exclude trailing null
    offset += seed2Len;
    // auth-plugin name (null-terminated)
    const pluginEnd = data.indexOf(0, offset);
    this.authPlugin = new TextDecoder().decode(data.subarray(offset, pluginEnd > 0 ? pluginEnd : data.length));

    // Combine seeds
    this.seed = new Uint8Array(this.seed1.length + this.seed2.length);
    this.seed.set(this.seed1);
    this.seed.set(this.seed2, this.seed1.length);

    return this.authPlugin;
  }

  async sendHandshake(user, password, database, authPlugin) {
    const userBytes = new TextEncoder().encode(user);
    const dbBytes = new TextEncoder().encode(database);

    let authData;
    if (authPlugin === 'caching_sha2_password') {
      authData = await this.cachingSha2Scramble(password, this.seed);
    } else {
      authData = password ? await scramble(password, this.seed) : new Uint8Array(0);
    }

    const pluginBytes = new TextEncoder().encode(authPlugin);

    // Client capabilities (CLIENT_PROTOCOL_41, CLIENT_SECURE_CONNECTION, CLIENT_PLUGIN_AUTH, CLIENT_CONNECT_WITH_DB)
    const caps = 0x00000200 | 0x00008000 | 0x00080000 | 0x00000008 | 0x00200000 | 0x01;
    const maxPacketSize = 0x01000000;
    const charset = 45; // utf8mb4

    const payloadSize = 4 + 4 + 1 + 23 + userBytes.length + 1 + 1 + authData.length + dbBytes.length + 1 + pluginBytes.length + 1;
    const payload = new Uint8Array(payloadSize);
    let off = 0;

    // Capability flags (4 bytes LE)
    payload[off++] = caps & 0xff;
    payload[off++] = (caps >> 8) & 0xff;
    payload[off++] = (caps >> 16) & 0xff;
    payload[off++] = (caps >> 24) & 0xff;
    // Max packet size (4 bytes)
    payload[off++] = maxPacketSize & 0xff;
    payload[off++] = (maxPacketSize >> 8) & 0xff;
    payload[off++] = (maxPacketSize >> 16) & 0xff;
    payload[off++] = (maxPacketSize >> 24) & 0xff;
    // Character set
    payload[off++] = charset;
    // Reserved (23 zeros)
    off += 23;
    // Username (null-terminated)
    payload.set(userBytes, off); off += userBytes.length;
    payload[off++] = 0;
    // Auth data (length-prefixed)
    payload[off++] = authData.length;
    payload.set(authData, off); off += authData.length;
    // Database (null-terminated)
    payload.set(dbBytes, off); off += dbBytes.length;
    payload[off++] = 0;
    // Auth plugin (null-terminated)
    payload.set(pluginBytes, off); off += pluginBytes.length;
    payload[off++] = 0;

    await this.writePacket(payload.subarray(0, off));
  }

  async readPacket() {
    // Read until we have at least 4 bytes (header)
    while (this.buffer.length < 4) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('Connection closed');
      const newBuf = new Uint8Array(this.buffer.length + value.length);
      newBuf.set(this.buffer);
      newBuf.set(value, this.buffer.length);
      this.buffer = newBuf;
    }

    const payloadLen = this.buffer[0] | (this.buffer[1] << 8) | (this.buffer[2] << 16);
    const seqId = this.buffer[3];
    const totalLen = 4 + payloadLen;

    // Read until we have the full packet
    while (this.buffer.length < totalLen) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('Connection closed');
      const newBuf = new Uint8Array(this.buffer.length + value.length);
      newBuf.set(this.buffer);
      newBuf.set(value, this.buffer.length);
      this.buffer = newBuf;
    }

    const payload = this.buffer.subarray(4, totalLen);
    this.buffer = this.buffer.subarray(totalLen);
    this.seqId = seqId + 1;

    return { seqId, payload: new Uint8Array(payload) };
  }

  async writePacket(payload) {
    const packet = makePacket(this.seqId++, payload);
    await this.writer.write(packet);
  }

  async query(sql) {
    // 뮤텍스: 이전 쿼리 완료까지 대기 (TCP 소켓은 동시 read 불가)
    let unlock;
    const prev = this._lock;
    this._lock = new Promise(resolve => { unlock = resolve; });
    await prev;

    try {
      return await this._queryInternal(sql);
    } finally {
      unlock();
    }
  }

  async _queryInternal(sql) {
    this.seqId = 0;

    // COM_QUERY
    const sqlBytes = new TextEncoder().encode(sql);
    const payload = new Uint8Array(1 + sqlBytes.length);
    payload[0] = 0x03; // COM_QUERY
    payload.set(sqlBytes, 1);
    await this.writePacket(payload);

    // Read response
    const firstPacket = await this.readPacket();

    // Error packet
    if (firstPacket.payload[0] === 0xff) {
      const errno = firstPacket.payload[1] | (firstPacket.payload[2] << 8);
      const msg = new TextDecoder().decode(firstPacket.payload.subarray(9));
      throw new Error(`MySQL error ${errno}: ${msg}`);
    }

    // OK packet (INSERT, UPDATE, DELETE)
    if (firstPacket.payload[0] === 0x00) {
      let off = 1;
      const { value: affectedRows, length: l1 } = readLenEncInt(firstPacket.payload, off);
      off += l1;
      const { value: insertId } = readLenEncInt(firstPacket.payload, off);
      return { rows: [], affectedRows, insertId };
    }

    // Result set: column count
    const { value: columnCount } = readLenEncInt(firstPacket.payload, 0);

    // Read column definitions
    const columns = [];
    for (let i = 0; i < columnCount; i++) {
      const pkt = await this.readPacket();
      const data = pkt.payload;
      let off = 0;
      // catalog
      const { length: l1 } = readLenEncString(data, off); off += l1;
      // schema
      const { length: l2 } = readLenEncString(data, off); off += l2;
      // table
      const { length: l3 } = readLenEncString(data, off); off += l3;
      // org_table
      const { length: l4 } = readLenEncString(data, off); off += l4;
      // name
      const { value: name, length: l5 } = readLenEncString(data, off); off += l5;
      columns.push(name);
    }

    // EOF packet after columns
    await this.readPacket();

    // Read rows until EOF
    const rows = [];
    while (true) {
      const pkt = await this.readPacket();
      // EOF packet
      if (pkt.payload[0] === 0xfe && pkt.payload.length < 9) break;
      // Error packet
      if (pkt.payload[0] === 0xff) break;

      const row = {};
      let off = 0;
      for (let i = 0; i < columnCount; i++) {
        const { value, length } = readLenEncString(pkt.payload, off);
        off += length;
        // Try to convert numeric strings
        if (value !== null && /^-?\d+$/.test(value)) {
          row[columns[i]] = parseInt(value, 10);
        } else if (value !== null && /^-?\d+\.\d+$/.test(value)) {
          row[columns[i]] = parseFloat(value);
        } else {
          row[columns[i]] = value;
        }
      }
      rows.push(row);
    }

    return { rows, affectedRows: 0, insertId: 0 };
  }

  async close() {
    try {
      // COM_QUIT
      this.seqId = 0;
      const payload = new Uint8Array([0x01]); // COM_QUIT
      await this.writePacket(payload);
    } catch { /* ignore */ }
    try { this.writer.close(); } catch { /* ignore */ }
    try { this.socket.close(); } catch { /* ignore */ }
  }
}

// ─── D1 호환 래퍼 ─────────────────────────────

export class MysqlDatabase {
  constructor(hyperdrive) {
    this._hyperdrive = hyperdrive;
    this._connection = null;
  }

  async getConnection() {
    if (!this._connection) {
      this._connection = await MysqlConnection.connect(
        this._hyperdrive.host,
        this._hyperdrive.port,
        this._hyperdrive.user,
        this._hyperdrive.password,
        this._hyperdrive.database
      );
    }
    return this._connection;
  }

  prepare(sql) {
    return new MysqlPreparedStatement(this, sql);
  }

  async batch(statements) {
    const conn = await this.getConnection();
    await conn.query('START TRANSACTION');
    try {
      const results = [];
      for (const stmt of statements) {
        const result = await stmt._execute(conn);
        results.push(result);
      }
      await conn.query('COMMIT');
      return results;
    } catch (error) {
      try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }

  async cleanup() {
    if (this._connection) {
      try { await this._connection.close(); } catch { /* ignore */ }
      this._connection = null;
    }
  }
}

class MysqlPreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async _execute(conn) {
    conn = conn || await this.db.getConnection();
    const formattedSql = formatQuery(this.sql, this.params);
    return conn.query(formattedSql);
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
    return {
      success: true,
      meta: {
        last_row_id: result.insertId || 0,
        changes: result.affectedRows || 0,
        served_by: 'mysql'
      }
    };
  }
}

// ─── 팩토리 ────────────────────────────────────

export function createDatabase(env) {
  if (env.HYPERDRIVE) {
    return new MysqlDatabase(env.HYPERDRIVE);
  }
  return env.D1_DB || env.DB;
}
