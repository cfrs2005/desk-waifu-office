// SSE fan-out. We chose SSE over WebSocket because: (1) the room is a
// strictly server→browser stream, no client messages on this channel;
// (2) SSE rides plain HTTP/1.1 — easy to reverse-proxy behind nginx with no
// Upgrade dance; (3) auto-reconnect is built into EventSource so the front
// end stays a single file with no reconnection library.

const clients = new Set();

export function attachSseHelpers(app) {
  app.decorate('broadcast', function broadcast(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) {
      try { c.raw.write(line); } catch { /* client gone; cleaned up on close */ }
    }
  });

  app.decorate('sseSubscribe', function sseSubscribe(reply) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
    });
    reply.raw.write(': hello\n\n');
    const sub = { raw: reply.raw };
    clients.add(sub);

    // Heartbeat every 25s — keeps idle proxies (nginx default 60s) from
    // killing the connection and lets the client notice a dead server.
    const hb = setInterval(() => {
      try { reply.raw.write(': hb\n\n'); } catch { /* */ }
    }, 25000);

    reply.raw.on('close', () => {
      clearInterval(hb);
      clients.delete(sub);
    });
  });
}

export function clientCount() {
  return clients.size;
}
