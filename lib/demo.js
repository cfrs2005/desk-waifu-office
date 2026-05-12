// Demo simulator. Two reasons this exists:
//   1) A fresh deployment with no real clients is an empty room — nobody
//      can tell if the server is healthy by looking at the UI. The demo
//      seats are a built-in liveness signal.
//   2) Single-user evaluation: you spin it up, open the browser, and you
//      already have something animated to compare your real client against.
// Skipped automatically once any real user has registered, so a production
// hub doesn't end up with @demo-alice gossiping forever in the corner.

const DEMO_SEATS = [
  { user: 'demo-alice', agent: 'claude-code', instance: 'demo', startState: 'coding' },
  { user: 'demo-bob', agent: 'hermes', instance: 'demo', startState: 'supervise' },
];

const STATE_POOL = [
  'coding', 'peek', 'loading', 'fix_bug', 'celebrate',
  'supervise', 'idle_blink', 'error_shrug',
];

const BUBBLES = [
  '在写代码', '修一下 bug', '编译中…', '好像通了', '再看看',
  '稍等一下', '搞定！', '哎呀错了', '继续盯着', '喝口水',
];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

export function startDemo({ db, broadcast }) {
  // Bail if real users exist — we only seed the demo for empty hubs.
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const realUsers = db.prepare("SELECT COUNT(*) AS n FROM users WHERE username NOT LIKE 'demo-%'").get().n;
  if (userCount > 0 && realUsers > 0) return;

  // Seed the demo users + their initial state event so /api/room shows them
  // on first paint even before the simulator timer fires.
  const upsertUser = db.prepare(
    `INSERT INTO users(username, api_key_hash, created_at) VALUES (?,?,?)
     ON CONFLICT(username) DO NOTHING`
  );
  const touchAgent = db.prepare(
    `INSERT INTO agents(user, agent_name, instance_id, last_seen) VALUES (?,?,?,?)
     ON CONFLICT(user, agent_name, instance_id) DO UPDATE SET last_seen=excluded.last_seen`
  );
  const insertEvent = db.prepare(
    'INSERT INTO events(user, agent_name, instance_id, type, value, ts) VALUES (?,?,?,?,?,?)'
  );
  const now = Date.now();
  for (const s of DEMO_SEATS) {
    upsertUser.run(s.user, 'demo-no-key', now);
    touchAgent.run(s.user, s.agent, s.instance, now);
    insertEvent.run(s.user, s.agent, s.instance, 'state', s.startState, now);
  }

  const realUserStmt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE username NOT LIKE 'demo-%'");

  // Tick: every 15–30s pick one seat, change its state, occasionally bubble.
  // Bails permanently the moment a real user registers — demo seats are only
  // a liveness signal for empty hubs, not a permanent fixture.
  function tick() {
    if (realUserStmt.get().n > 0) return;
    const seat = pick(DEMO_SEATS);
    const state = pick(STATE_POOL);
    const ts = Date.now();
    insertEvent.run(seat.user, seat.agent, seat.instance, 'state', state, ts);
    touchAgent.run(seat.user, seat.agent, seat.instance, ts);
    broadcast({
      user: seat.user, agent: seat.agent, instance: seat.instance,
      type: 'state', value: state, ts,
    });
    if (Math.random() < 0.5) {
      const value = pick(BUBBLES);
      const ts2 = Date.now();
      insertEvent.run(seat.user, seat.agent, seat.instance, 'bubble', value, ts2);
      broadcast({
        user: seat.user, agent: seat.agent, instance: seat.instance,
        type: 'bubble', value, ts: ts2,
      });
    }
    setTimeout(tick, 15000 + Math.random() * 15000);
  }
  setTimeout(tick, 4000);
}
