// server.js
const http = require('http');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ReFile Server OK');
});

const wss = new WebSocket.Server({ server });
const sessions = new Map();

wss.on('connection', (ws) => {
  ws._id = null;
  ws._role = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'create') {
        const id = Math.random().toString(36).substr(2,9).toUpperCase();
        ws._id = id;
        ws._role = 'host';
        sessions.set(id, { host: ws, guest: null });
        ws.send(JSON.stringify({ type: 'created', code: id }));
      }

      else if (msg.type === 'join') {
        const session = sessions.get(msg.code);
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', msg: 'not found' }));
          return;
        }
        ws._id = msg.code;
        ws._role = 'guest';
        session.guest = ws;
        ws.send(JSON.stringify({ type: 'joined' }));
        session.host.send(JSON.stringify({ type: 'guest_joined' }));
      }

      else if (msg.type === 'file') {
        const session = sessions.get(ws._id);
        if (!session) return;
        const target = ws._role === 'host' ? session.guest : session.host;
        if (target) target.send(JSON.stringify(msg));
      }

      else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }

    } catch(e) {}
  });

  ws.on('close', () => {
    if (!ws._id) return;
    const session = sessions.get(ws._id);
    if (!session) return;
    const other = ws._role === 'host' ? session.guest : session.host;
    if (other) other.send(JSON.stringify({ type: 'partner_left' }));
    sessions.delete(ws._id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port', PORT));
