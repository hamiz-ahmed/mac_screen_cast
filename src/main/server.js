const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

// Local HTTP + WebSocket server.
//   GET /            -> viewer page (any browser on the LAN watches here)
//   GET /player      -> movie player page (plays the picked file at /media)
//   WS  /stream      -> broadcast relay: the app (sender) pushes fMP4 chunks
//                       (binary) plus JSON control messages; both are fanned
//                       out to every connected viewer.
function startServer({ preferredPort = 8080, viewerDir, onConsumers }) {
  const app = express();
  // Stale cached viewer pages silently break streaming (Silk caches hard)
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/', (_req, res) => res.sendFile(path.join(viewerDir, 'view.html')));
  app.get('/view', (_req, res) => res.sendFile(path.join(viewerDir, 'view.html')));

  // Movie mode: stream a local video file to the player page's <video>.
  // sendFile handles Range requests, so seeking works.
  let mediaPath = null;
  app.get('/player', (_req, res) => res.sendFile(path.join(viewerDir, 'player.html')));
  app.get('/media', (_req, res) => {
    if (!mediaPath) return res.status(404).send('No video selected on the Mac');
    res.sendFile(mediaPath);
  });
  app.get('/media-info', (_req, res) =>
    res.json({ name: mediaPath ? path.basename(mediaPath) : null })
  );

  // Progressive fallback: the live broadcast as a never-ending MP4 download —
  // zero MediaSource involvement, plays in any browser. Joiners are attached
  // mid-generation using the cached init segment (see below).
  const liveResponses = new Set(); // entries: { res, active }
  app.get('/live.mp4', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
    });
    const entry = { res, active: false };
    liveResponses.add(entry);
    tellSenderViewerCount();
    req.on('close', () => {
      liveResponses.delete(entry);
      tellSenderViewerCount();
    });
    requestGenerationIfNeeded();
  });

  app.use(express.static(viewerDir));

  const server = http.createServer(app);
  const streamWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/stream') return socket.destroy();
    streamWss.handleUpgrade(req, socket, head, (ws) =>
      streamWss.emit('connection', ws, req)
    );
  });

  let sender = null;
  const viewers = new Set(); // ws viewers; ws.aligned = receiving current generation
  const players = new Set(); // movie pages, connected for presence only

  const safeSend = (ws, obj) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  // Also the choke point for "does anyone need the Mac awake?" — a movie page
  // counts (even paused) though it isn't a broadcast viewer.
  const tellSenderViewerCount = () => {
    safeSend(sender, { type: 'viewers', n: viewers.size + liveResponses.size });
    if (onConsumers) onConsumers(viewers.size + liveResponses.size + players.size);
  };

  // --- Generation store ----------------------------------------------------
  // A "generation" is one fMP4 timeline: init segment (ftyp+moov) followed by
  // moof/mdat fragments, each arriving as one aligned write. Caching the init
  // lets ANY late joiner attach mid-stream — no segment cuts, so joining
  // never resets the viewers that are already watching.
  let genMime = null;
  let genInit = null; // Buffer with ftyp+moov
  let genPending = Buffer.alloc(0);
  let lastCutRequest = 0;

  function initSegmentLength(buf) {
    let off = 0;
    let sawFtyp = false;
    while (off + 8 <= buf.length) {
      const size = buf.readUInt32BE(off);
      if (size < 8) return -1;
      if (off + size > buf.length) return 0; // box incomplete — wait for more
      const type = buf.toString('latin1', off + 4, off + 8);
      if (type === 'ftyp') sawFtyp = true;
      if (type === 'moov') return sawFtyp ? off + size : -1;
      off += size;
    }
    return 0;
  }

  function requestGenerationIfNeeded() {
    if (genInit) return; // a generation is flowing; joiners attach to it
    if (Date.now() - lastCutRequest < 2500) return;
    lastCutRequest = Date.now();
    safeSend(sender, { type: 'viewer-joined' });
  }

  function attachWaitingConsumers(followOnData) {
    for (const v of viewers) {
      if (v.aligned || v.readyState !== v.OPEN) continue;
      safeSend(v, { type: 'mse-init', mime: genMime });
      v.send(genInit, { binary: true });
      if (followOnData) v.send(followOnData, { binary: true });
      v.aligned = true;
    }
    for (const entry of liveResponses) {
      if (entry.active) continue;
      entry.res.write(genInit);
      if (followOnData) entry.res.write(followOnData);
      entry.active = true;
    }
  }

  function handleSenderText(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type !== 'mse-init') return;
    // New generation begins: reset the store; ws viewers realign once the new
    // init bytes are extracted; progressive responses can't re-init mid-file,
    // so end them — their pages reopen and attach to the new generation.
    genMime = msg.mime;
    genInit = null;
    genPending = Buffer.alloc(0);
    for (const v of viewers) v.aligned = false;
    for (const entry of liveResponses) {
      if (entry.active) {
        try {
          entry.res.end();
        } catch {}
        liveResponses.delete(entry);
      }
    }
  }

  function handleSenderBinary(data) {
    if (!genInit) {
      genPending = Buffer.concat([genPending, data]);
      const len = initSegmentLength(genPending);
      if (len === -1) {
        genPending = Buffer.alloc(0); // malformed — wait for next generation
        return;
      }
      if (len === 0) return; // init not complete yet
      genInit = genPending.subarray(0, len);
      const rest = genPending.subarray(len);
      genPending = Buffer.alloc(0);
      attachWaitingConsumers(rest.length ? rest : null);
      return;
    }
    // Mid-generation: every write starts at a fragment boundary, so waiting
    // consumers can hop on right here.
    attachWaitingConsumers(null);
    for (const v of viewers) {
      if (v.aligned && v.readyState === v.OPEN && v.bufferedAmount < 32 * 1024 * 1024) {
        v.send(data, { binary: true });
      }
    }
    for (const entry of liveResponses) {
      if (!entry.active) continue;
      if (entry.res.writableLength > 32 * 1024 * 1024) {
        try {
          entry.res.destroy();
        } catch {}
        liveResponses.delete(entry);
        continue;
      }
      entry.res.write(data);
    }
  }

  streamWss.on('connection', (ws, req) => {
    const role = new URL(req.url, 'http://localhost').searchParams.get('role');
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    if (role === 'sender') {
      if (sender) sender.terminate();
      sender = ws;
      genMime = null;
      genInit = null;
      genPending = Buffer.alloc(0);
      lastCutRequest = 0;
      tellSenderViewerCount();
      if (viewers.size || liveResponses.size) requestGenerationIfNeeded();
      ws.on('message', (data, isBinary) => {
        if (isBinary) handleSenderBinary(data);
        else handleSenderText(data);
      });
      ws.on('close', () => {
        if (sender === ws) sender = null;
        genInit = null;
        genMime = null;
        for (const v of viewers) {
          v.aligned = false;
          safeSend(v, { type: 'stream-ended' });
        }
        for (const entry of liveResponses) {
          try {
            entry.res.end();
          } catch {}
        }
        liveResponses.clear();
      });
      return;
    }

    if (role === 'player') {
      players.add(ws);
      tellSenderViewerCount();
      ws.on('close', () => {
        players.delete(ws);
        tellSenderViewerCount();
      });
      return;
    }

    ws.aligned = false;
    viewers.add(ws);
    tellSenderViewerCount();
    requestGenerationIfNeeded();
    ws.on('close', () => {
      viewers.delete(ws);
      tellSenderViewerCount();
    });
  });

  // Keep connections alive (TV browsers drop idle sockets) and reap dead ones
  const heartbeat = setInterval(() => {
    for (const ws of streamWss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    // safety: viewers waiting but no generation flowing — ask again
    if ((viewers.size || liveResponses.size) && !genInit) requestGenerationIfNeeded();
  }, 15000);
  streamWss.on('close', () => clearInterval(heartbeat));

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < 10) {
          attempt += 1;
          tryListen(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, () => {
        server.removeAllListeners('error');
        resolve({
          port,
          close: () => server.close(),
          setMedia: (p) => {
            mediaPath = p;
          },
        });
      });
    };
    tryListen(preferredPort);
  });
}

module.exports = { startServer };
