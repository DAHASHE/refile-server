// server.js
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// ── قاعدة بيانات بسيطة في الذاكرة ──────────────────────
// في الإنتاج: استخدم Supabase أو MongoDB
const licenses = new Map();    // licenseKey → userData
const sessions = new Map();    // sessionId  → sessionData
const rateLimits = new Map();  // ip → requestCount

// ── إضافة license تجريبية للاختبار ─────────────────────
licenses.set('TEST-1234-5678-9012', {
  email: 'test@example.com',
  plan: 'pro',
  expiresAt: Date.now() + 30 * 24 * 3600000,
  maxFileSize: 50 * 1024 * 1024
});

// ═══════════════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── التحقق من الـ License ─────────────────────────────
  if (url.pathname === '/api/verify-license' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { licenseKey } = JSON.parse(body);
        const license = licenses.get(licenseKey?.trim());

        if (!license) {
          res.writeHead(404, headers);
          res.end(JSON.stringify({
            valid: false,
            error: 'License not found'
          }));
          return;
        }

        if (Date.now() > license.expiresAt) {
          res.writeHead(403, headers);
          res.end(JSON.stringify({
            valid: false,
            error: 'License expired'
          }));
          return;
        }

        res.writeHead(200, headers);
        res.end(JSON.stringify({
          valid: true,
          plan: license.plan,
          email: license.email,
          expiresAt: license.expiresAt,
          maxFileSize: license.maxFileSize
        }));
      } catch (e) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ valid: false, error: 'Invalid request' }));
      }
    });
    return;
  }

  // ── معلومات الخادم ────────────────────────────────────
  if (url.pathname === '/api/status') {
    res.writeHead(200, headers);
    res.end(JSON.stringify({
      status: 'ok',
      sessions: sessions.size,
      timestamp: Date.now()
    }));
    return;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ═══════════════════════════════════════════════════════
// WebSocket Server
// ═══════════════════════════════════════════════════════

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  ws._ip = ip;
  ws._licenseKey = null;
  ws._sessionId = null;
  ws._role = null;
  ws._verified = false;

  console.log('🟢 Client connected:', ip);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, msg, ip);
    } catch (e) {
      sendTo(ws, { type: 'error', error: 'Invalid message' });
    }
  });

  ws.on('close', () => {
    console.log('📴 Client disconnected:', ip);
    if (ws._sessionId) cleanupClient(ws);
  });

  ws.on('error', console.error);

  // ── timeout إذا لم يتحقق خلال 10 ثواني ───────────────
  setTimeout(() => {
    if (!ws._verified && ws.readyState === WebSocket.OPEN) {
      sendTo(ws, { type: 'error', error: 'Verification timeout' });
      ws.close();
    }
  }, 10000);
});

function handleMessage(ws, msg, ip) {
  switch (msg.type) {

    // ── التحقق من الـ License ─────────────────────────────
    case 'verify': {
      const license = licenses.get(msg.licenseKey?.trim());

      if (!license || Date.now() > license.expiresAt) {
        sendTo(ws, {
          type: 'verify_result',
          valid: false,
          error: !license ? 'License not found' : 'License expired'
        });
        ws.close();
        return;
      }

      ws._licenseKey = msg.licenseKey;
      ws._verified = true;
      ws._maxFileSize = license.maxFileSize;

      sendTo(ws, {
        type: 'verify_result',
        valid: true,
        plan: license.plan,
        email: license.email,
        expiresAt: license.expiresAt
      });
      break;
    }

    // ── إنشاء جلسة ───────────────────────────────────────
    case 'create': {
      if (!ws._verified) {
        sendTo(ws, { type: 'error', error: 'Not verified' });
        return;
      }

      const sessionId = generateId();
      ws._sessionId = sessionId;
      ws._role = 'host';

      sessions.set(sessionId, {
        host: ws,
        guest: null,
        created: Date.now(),
        transferCount: 0
      });

      sendTo(ws, {
        type: 'created',
        sessionId,
        code: formatCode(sessionId)
      });

      console.log('✅ Session created:', sessionId);
      break;
    }

    // ── الانضمام لجلسة ────────────────────────────────────
    case 'join': {
      if (!ws._verified) {
        sendTo(ws, { type: 'error', error: 'Not verified' });
        return;
      }

      const sessionId = msg.sessionId?.replace(/-/g, '').toUpperCase();
      const session = sessions.get(sessionId);

      if (!session) {
        sendTo(ws, { type: 'error', error: 'Session not found' });
        return;
      }

      if (session.guest) {
        sendTo(ws, { type: 'error', error: 'Session full' });
        return;
      }

      ws._sessionId = sessionId;
      ws._role = 'guest';
      session.guest = ws;

      sendTo(ws, { type: 'joined', sessionId });
      sendTo(session.host, { type: 'guest_joined' });

      console.log('✅ Guest joined:', sessionId);
      break;
    }

    // ── إرسال ملف ─────────────────────────────────────────
    case 'file': {
      if (!ws._verified || !ws._sessionId) return;

      const session = sessions.get(ws._sessionId);
      if (!session) return;

      // ── التحقق من حجم الملف ──────────────────────────────
      const fileSize = msg.content?.length || 0;
      if (fileSize > ws._maxFileSize) {
        sendTo(ws, {
          type: 'error',
          error: `File too large. Max: ${ws._maxFileSize / 1024 / 1024}MB`
        });
        return;
      }

      const target = ws._role === 'host' ? session.guest : session.host;

      if (target?.readyState === WebSocket.OPEN) {
        sendTo(target, {
          type: 'file',
          id: msg.id,
          path: msg.path,
          content: msg.content,
          size: fileSize,
          timestamp: Date.now()
        });
        session.transferCount++;
      }
      break;
    }

    case 'ping':
      sendTo(ws, { type: 'pong' });
      break;
  }
}

function cleanupClient(ws) {
  const session = sessions.get(ws._sessionId);
  if (!session) return;

  const other = session.host === ws ? session.guest : session.host;
  if (other?.readyState === WebSocket.OPEN) {
    sendTo(other, { type: 'partner_left' });
  }

  sessions.delete(ws._sessionId);
  console.log('🗑️ Session cleaned:', ws._sessionId);
}

function sendTo(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function generateId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function formatCode(code) {
  return code.match(/.{1,4}/g)?.join('-') || code;
}

// ── تنظيف الجلسات القديمة ─────────────────────────────
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions.entries()) {
    if (now - session.created > 60 * 60 * 1000) {
      sessions.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`🗑️ Cleaned ${cleaned} expired sessions`);
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 ReFile Server on port ${PORT}`);
  console.log(`📊 Active sessions: ${sessions.size}`);
});
