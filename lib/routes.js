// HTTP surface. Kept flat on purpose — one file, top-to-bottom — so the
// auth + validation flow is auditable at a glance.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import {
  generateApiKey, hashKey, authBearer, validUsername, validState,
} from './auth.js';
import { attachSseHelpers, clientCount } from './sse.js';

const VALID_STATES = new Set([
  'sleep', 'coding', 'peek', 'loading', 'fix_bug',
  'error_shrug', 'celebrate', 'supervise', 'idle_blink',
]);
const VALID_EVENT_TYPES = new Set(['state', 'bubble', 'hud']);
const BUBBLE_MAX = 28; // 14 CJK chars worst-case in UTF-16 units
const HUD_MAX    = 120; // hud lines are longer narration / filenames

export function registerRoutes(app, { db, dataDir }) {
  attachSseHelpers(app);

  // POST /register — one-time username claim, returns plaintext api_key
  // exactly once. Hash-only persistence means we cannot recover it later;
  // that's by design.
  app.post('/register', async (request, reply) => {
    const body = request.body || {};
    if (!validUsername(body.username)) {
      return reply.code(400).send({ error: 'invalid_username' });
    }
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.username);
    if (exists) return reply.code(409).send({ error: 'username_taken' });

    const key = generateApiKey();
    db.prepare('INSERT INTO users(username, api_key_hash, created_at) VALUES (?,?,?)')
      .run(body.username, hashKey(key), Date.now());
    fs.mkdirSync(path.join(dataDir, 'assets', body.username), { recursive: true });
    return { username: body.username, api_key: key };
  });

  // PUT /assets/:state — upload a GIF for a state. We dedupe on
  // X-Content-Sha256: same hash on file → 304, saves disk churn and CDN
  // invalidation when a client re-uploads identical assets on boot.
  app.put('/assets/:state', async (request, reply) => {
    const user = authBearer(db, request);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });

    const state = request.params.state;
    if (!validState(state) || !VALID_STATES.has(state)) {
      return reply.code(400).send({ error: 'invalid_state' });
    }
    const claimedHash = request.headers['x-content-sha256'];
    if (claimedHash) {
      const cur = db.prepare('SELECT sha256 FROM assets WHERE user=? AND state=?').get(user, state);
      if (cur && cur.sha256 === claimedHash) return reply.code(304).send();
    }

    const part = await request.file();
    if (!part || part.fieldname !== 'gif') {
      return reply.code(400).send({ error: 'missing_gif_field' });
    }
    const userDir = path.join(dataDir, 'assets', user);
    fs.mkdirSync(userDir, { recursive: true });
    const tmp = path.join(userDir, `.${state}.${process.pid}.tmp`);
    const dst = path.join(userDir, `${state}.gif`);

    const hasher = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp);
    part.file.on('data', (c) => hasher.update(c));
    await pipeline(part.file, out);
    if (part.file.truncated) {
      fs.unlinkSync(tmp);
      return reply.code(413).send({ error: 'file_too_large' });
    }
    const sha = hasher.digest('hex');
    fs.renameSync(tmp, dst);
    db.prepare(`INSERT INTO assets(user,state,sha256,path) VALUES (?,?,?,?)
                ON CONFLICT(user,state) DO UPDATE SET sha256=excluded.sha256, path=excluded.path`)
      .run(user, state, sha, dst);
    return { ok: true, sha256: sha };
  });

  // GET /u/:user/gifs/:state.gif — public static serve. We don't expose
  // the bare /data dir to fastify-static because we want path traversal
  // protection + a sane 404 when the user never uploaded that state.
  app.get('/u/:user/gifs/:state.gif', async (request, reply) => {
    const { user, state } = request.params;
    if (!validUsername(user) || !validState(state)) return reply.code(400).send();
    const row = db.prepare('SELECT path FROM assets WHERE user=? AND state=?').get(user, state);
    if (!row || !fs.existsSync(row.path)) return reply.code(404).send();
    reply.header('Cache-Control', 'public, max-age=60');
    reply.type('image/gif');
    return fs.createReadStream(row.path);
  });

  // POST /events — the hot path. Validates, persists, dedupes on
  // X-Client-Id (5min window), then broadcasts to every SSE subscriber.
  const insertEvent = db.prepare(
    'INSERT INTO events(user, agent_name, instance_id, type, value, ts) VALUES (?,?,?,?,?,?)'
  );
  const touchAgent = db.prepare(
    `INSERT INTO agents(user, agent_name, instance_id, last_seen) VALUES (?,?,?,?)
     ON CONFLICT(user, agent_name, instance_id) DO UPDATE SET last_seen=excluded.last_seen`
  );
  const checkIdem = db.prepare('SELECT ts FROM idempotency WHERE client_id=?');
  const putIdem = db.prepare('INSERT OR REPLACE INTO idempotency(client_id, ts) VALUES (?,?)');

  app.post('/events', async (request, reply) => {
    const user = authBearer(db, request);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const b = request.body || {};
    if (!b.agent || typeof b.agent !== 'string' || b.agent.length > 64) {
      return reply.code(400).send({ error: 'bad_agent' });
    }
    if (!b.instance || typeof b.instance !== 'string' || b.instance.length > 64) {
      return reply.code(400).send({ error: 'bad_instance' });
    }
    if (!VALID_EVENT_TYPES.has(b.type)) return reply.code(400).send({ error: 'bad_type' });
    if (typeof b.value !== 'string') return reply.code(400).send({ error: 'bad_value' });
    if (b.type === 'state' && !VALID_STATES.has(b.value)) {
      return reply.code(400).send({ error: 'unknown_state' });
    }
    if (b.type === 'bubble' && b.value.length > BUBBLE_MAX) {
      return reply.code(400).send({ error: 'bubble_too_long' });
    }
    if (b.type === 'hud' && b.value.length > HUD_MAX) {
      // truncate instead of reject — hud is best-effort narration
      b.value = b.value.slice(0, HUD_MAX);
    }
    // Normalize ts to milliseconds. Bash clients send `date +%s` (seconds);
    // JS clients send Date.now() (ms). Anything below year ~2286 in seconds
    // is < 1e10, so we treat values under that threshold as seconds.
    let ts = Number.isFinite(b.ts) ? b.ts : Date.now();
    if (ts > 0 && ts < 1e12) ts = ts * 1000;

    const clientId = request.headers['x-client-id'];
    if (clientId && typeof clientId === 'string') {
      const prev = checkIdem.get(clientId);
      if (prev && Date.now() - prev.ts < 5 * 60 * 1000) {
        return { ok: true, dedup: true };
      }
      putIdem.run(clientId, Date.now());
    }

    insertEvent.run(user, b.agent, b.instance, b.type, b.value, ts);
    touchAgent.run(user, b.agent, b.instance, ts);

    app.broadcast({ user, agent: b.agent, instance: b.instance, type: b.type, value: b.value, ts });
    return { ok: true };
  });

  // GET /stream — SSE channel. No auth: this is a public spectator stream.
  app.get('/stream', async (request, reply) => {
    app.sseSubscribe(reply);
  });

  // GET /api/room — snapshot for first paint. We only return the most
  // recent instance per (user, agent_name) so stale sessions don't litter
  // the room. SSE stream is delta-only; this is the initial render source.
  app.get('/api/room', async () => {
    const seats = db.prepare(`
      SELECT a.user, a.agent_name, a.instance_id, a.last_seen,
        (SELECT value FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
           AND e.instance_id=a.instance_id AND e.type='state'
           ORDER BY ts DESC LIMIT 1) AS state,
        (SELECT value FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
           AND e.instance_id=a.instance_id AND e.type='bubble'
           ORDER BY ts DESC LIMIT 1) AS bubble,
        (SELECT ts FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
           AND e.instance_id=a.instance_id AND e.type='bubble'
           ORDER BY ts DESC LIMIT 1) AS bubble_ts,
        (SELECT value FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
           AND e.instance_id=a.instance_id AND e.type='hud'
           ORDER BY ts DESC LIMIT 1) AS hud,
        (SELECT ts FROM events e WHERE e.user=a.user AND e.agent_name=a.agent_name
           AND e.instance_id=a.instance_id AND e.type='hud'
           ORDER BY ts DESC LIMIT 1) AS hud_ts
      FROM agents a
      INNER JOIN (
        SELECT user, agent_name, MAX(last_seen) AS max_seen
        FROM agents GROUP BY user, agent_name
      ) latest
        ON a.user=latest.user
       AND a.agent_name=latest.agent_name
       AND a.last_seen=latest.max_seen
      ORDER BY a.user, a.agent_name
    `).all();
    return { now: Date.now(), spectators: clientCount(), seats };
  });

  // GET /api/timeline — last N events for the activity drawer.
  app.get('/api/timeline', async (request) => {
    const limit = Math.min(50, parseInt(request.query?.limit || '20', 10) || 20);
    const rows = db.prepare(`
      SELECT user, agent_name, type, value, ts
      FROM events ORDER BY id DESC LIMIT ?
    `).all(limit);
    return { events: rows };
  });

  app.get('/healthz', async () => ({ ok: true }));
}
