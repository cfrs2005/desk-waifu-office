// Front end. One file, no framework. Maintains an in-memory seat map keyed
// by `${user}::${agent}::${instance}`, applies snapshot + SSE deltas onto
// the same map, and re-renders user groups when membership changes.

const KNOWN_AGENTS = new Set(['claude-code', 'hermes', 'codex']);
const SLEEP_DIM_MS = 5 * 60 * 1000;

const room = document.getElementById('room');
const onlineEl = document.getElementById('online');
const todayEl = document.getElementById('today');
const tpl = document.getElementById('seat-tpl');

todayEl.textContent = new Date().toISOString().slice(0, 10);

const seats = new Map();   // seatId -> { user, agent, instance, state, bubble, bubbleTs, lastSeen, el }
const userGroups = new Map(); // user -> { el, seatsEl }

function seatId(s) { return `${s.user}::${s.agent}::${s.instance}`; }

function ensureUserGroup(user) {
  let g = userGroups.get(user);
  if (g) return g;
  const el = document.createElement('section');
  el.className = 'user-group';
  el.innerHTML = `<h2>@${user}</h2><div class="seats"></div>`;
  room.appendChild(el);
  g = { el, seatsEl: el.querySelector('.seats') };
  userGroups.set(user, g);
  return g;
}

function makeSeatEl(seat) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.username').textContent = '@' + seat.user;
  const agentEl = node.querySelector('.agent');
  agentEl.textContent = seat.agent;
  agentEl.classList.add(KNOWN_AGENTS.has(seat.agent) ? seat.agent : 'generic');
  return node;
}

function applyState(seat) {
  const stateName = seat.state || 'idle_blink';
  const img = seat.el.querySelector('.gif');
  // Per-user gif path; <img> falls back to a transparent 1x1 if missing.
  img.src = `/u/${seat.user}/gifs/${stateName}.gif`;
  img.onerror = () => { img.style.opacity = '0.25'; };
  img.onload  = () => { img.style.opacity = '1'; };
  seat.el.querySelector('.statename').textContent = stateName;
  const dot = seat.el.querySelector('.statedot');
  dot.className = 'statedot ' + stateName;

  const avatar = seat.el.querySelector('.avatar');
  avatar.classList.remove('pulse');
  // Force reflow so the animation restarts on every state change.
  void avatar.offsetWidth;
  avatar.classList.add('pulse');

  updateDim(seat);
}

function showBubble(seat, text) {
  const el = seat.el.querySelector('.bubble');
  el.textContent = text;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  if (seat._bubbleTimer) clearTimeout(seat._bubbleTimer);
  seat._bubbleTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 500);
  }, 6000);
}

function showNarration(seat, text) {
  const el = seat.el.querySelector('.narration');
  el.textContent = text;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  if (seat._narrTimer) clearTimeout(seat._narrTimer);
  // Keep the last narration visible 60s. New HUD events reset the timer
  // (see clearTimeout above), so a busy session keeps the strip alive
  // indefinitely and only fades after she actually stops.
  seat._narrTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 500);
  }, 60000);
}

function updateDim(seat) {
  const stale = seat.state === 'sleep' && (Date.now() - (seat.lastSeen || 0) > SLEEP_DIM_MS);
  seat.el.classList.toggle('dim', !!stale);
}

function upsertSeat(s) {
  const id = seatId(s);
  let seat = seats.get(id);
  if (!seat) {
    seat = { ...s };
    const g = ensureUserGroup(seat.user);
    seat.el = makeSeatEl(seat);
    g.seatsEl.appendChild(seat.el);
    seats.set(id, seat);
  }
  return seat;
}

async function loadSnapshot() {
  const r = await fetch('/api/room');
  const data = await r.json();
  onlineEl.textContent = `${data.spectators} online`;
  for (const row of data.seats) {
    const seat = upsertSeat({
      user: row.user, agent: row.agent_name, instance: row.instance_id,
    });
    seat.state = row.state || 'idle_blink';
    seat.lastSeen = row.last_seen;
    applyState(seat);
    // Initial load: show any bubble received in the last 30s so a freshly
    // opened page can still see the most recent activity. The 6s fade-out
    // animation still runs from showBubble() once shown.
    if (row.bubble && row.bubble_ts && Date.now() - row.bubble_ts < 30000) {
      showBubble(seat, row.bubble);
    }
    // Show narration on initial load if it's reasonably recent.
    if (row.hud && row.hud_ts && Date.now() - row.hud_ts < 5 * 60 * 1000) {
      showNarration(seat, row.hud);
    }
  }
}

// Poll spectator count + room health every 5s. /api/room is cheap (small
// SQL + small JSON) and saves us from having to broadcast online deltas.
async function pollOnline() {
  try {
    const r = await fetch('/api/room');
    const data = await r.json();
    // +1: the client itself is connected via SSE but /api/room is called
    // over a separate HTTP request so spectators may not include us yet.
    const n = Math.max(data.spectators, 1);
    onlineEl.textContent = `${n} online`;
  } catch {}
}
setInterval(pollOnline, 5000);

function connectStream() {
  const es = new EventSource('/stream');
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const seat = upsertSeat({ user: msg.user, agent: msg.agent, instance: msg.instance });
    seat.lastSeen = msg.ts;
    if (msg.type === 'state') {
      seat.state = msg.value;
      applyState(seat);
    } else if (msg.type === 'bubble') {
      showBubble(seat, msg.value);
    }
  };
  // EventSource auto-reconnects on error; nothing to do here.
}

// Tick to refresh dim state for seats that drifted past the sleep threshold
// without receiving a new event.
setInterval(() => { for (const s of seats.values()) updateDim(s); }, 30000);

// ── Timeline drawer ─────────────────────────────────────────────────────
const TL_MAX = 30;
const tlListEl = document.getElementById('timeline-list');
const tlItemTpl = document.getElementById('timeline-item-tpl');
const tlPanel = document.getElementById('timeline');
tlPanel.querySelector('.timeline-toggle').addEventListener('click', () => {
  tlPanel.dataset.open = tlPanel.dataset.open === '1' ? '0' : '1';
});

function fmtTime(ts) {
  // ts is ms. Render HH:MM:SS local.
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function tlAgentClass(a) { return KNOWN_AGENTS.has(a) ? a : 'generic'; }

function tlPrepend({ user, agent, type, value, ts }) {
  const li = tlItemTpl.content.firstElementChild.cloneNode(true);
  li.querySelector('.tl-time').textContent = fmtTime(ts);
  const who = li.querySelector('.tl-who');
  who.textContent = `@${user}·${agent}`;
  who.classList.add(tlAgentClass(agent));
  const arrow = li.querySelector('.tl-arrow');
  arrow.textContent = type === 'bubble' ? '“' : (type === 'hud' ? '·' : '→');
  const payload = li.querySelector('.tl-payload');
  payload.textContent = type === 'bubble' ? `${value}”` : value;
  payload.classList.add(`type-${type}`);
  if (type === 'state') payload.classList.add(`state-${value}`);
  tlListEl.prepend(li);
  // Trim
  while (tlListEl.children.length > TL_MAX) tlListEl.removeChild(tlListEl.lastChild);
  // Briefly highlight the new item
  requestAnimationFrame(() => li.classList.add('fresh'));
  setTimeout(() => li.classList.remove('fresh'), 1200);
}

async function loadTimeline() {
  const r = await fetch('/api/timeline?limit=20');
  const data = await r.json();
  // API returns newest first; render in reverse so prepend keeps order.
  for (const row of [...data.events].reverse()) {
    tlPrepend({
      user: row.user, agent: row.agent_name,
      type: row.type, value: row.value, ts: row.ts,
    });
  }
}

// Hook timeline into the SSE flow too.
const _origConnect = connectStream;
function connectStreamWithTimeline() {
  const es = new EventSource('/stream');
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const seat = upsertSeat({ user: msg.user, agent: msg.agent, instance: msg.instance });
    seat.lastSeen = msg.ts;
    if (msg.type === 'state') {
      seat.state = msg.value;
      applyState(seat);
    } else if (msg.type === 'bubble') {
      showBubble(seat, msg.value);
    } else if (msg.type === 'hud') {
      showNarration(seat, msg.value);
    }
    tlPrepend(msg);
  };
}

loadSnapshot().then(loadTimeline).then(connectStreamWithTimeline);
