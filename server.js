#!/usr/bin/env node
// Entry point. Parses --port / --data flags, boots Fastify, wires routes,
// and kicks off the demo simulator. Lean CLI on purpose: a hub running on a
// VPS should be one `npx desk-waifu-office` away — no config file required.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

import { openDb } from './lib/db.js';
import { registerRoutes } from './lib/routes.js';
import { startDemo } from './lib/demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { port: 7878, host: '0.0.0.0', data: path.join(__dirname, 'data') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--data') out.data = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: desk-waifu-office [--port 7878] [--host 0.0.0.0] [--data ./data]');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  fs.mkdirSync(opts.data, { recursive: true });
  fs.mkdirSync(path.join(opts.data, 'assets'), { recursive: true });

  const db = openDb(path.join(opts.data, 'hub.db'));

  const app = Fastify({ logger: { level: 'info' }, bodyLimit: 6 * 1024 * 1024 });

  await app.register(fastifyMultipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });

  // Serve uploaded user gifs at /u/:user/gifs/:state.gif via a thin route in
  // routes.js (we need DB lookup + content-disposition), and the SPA shell
  // from /public.
  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
    decorateReply: false,
  });

  registerRoutes(app, { db, dataDir: opts.data });

  // Demo simulator: gives a fresh deployment something to look at without
  // requiring a client to connect first. Disabled if hub.db already has real
  // users to avoid polluting a production room.
  startDemo({ db, broadcast: app.broadcast });

  try {
    await app.listen({ port: opts.port, host: opts.host });
    app.log.info(`desk-waifu-office listening on http://${opts.host}:${opts.port}`);
    app.log.info(`data dir: ${opts.data}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
