const http = require('http'), fs = require('fs'), path = require('path');
const { Stats, Detector, SimScale, TcpScale } = require('./scales');

const DATA = path.join(__dirname, 'data'); fs.mkdirSync(DATA, { recursive: true });
const CFG_FILE = path.join(__dirname, 'config.json');
const STATE_FILE = path.join(DATA, 'state.json');
const LOG_FILE = path.join(DATA, 'gloves.csv');
let cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const saved = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, 'time,scale,weight_g\n');

const scales = {};

function startScales() {
  for (const s of Object.values(scales)) s.driver.stop();
  for (const [id, sc] of Object.entries(cfg.scales)) {
    const prev = scales[id];
    const o = scales[id] = {
      id, ...sc, stats: prev ? prev.stats : Stats.from(saved[id] && saved[id].stats),
      emptied: prev ? prev.emptied : (saved[id] && saved[id].emptied) || 0,
      status: 'connecting', live: null, last: null, note: null, noteUntil: 0,
    };
    o.detector = new Detector(cfg.glove);
    o.driver = cfg.mode === 'tcp' ? new TcpScale(sc.host, sc.port)
      : new SimScale({ speed: cfg.simSpeed, rate: sc.kind === 'good' ? 1 : 0.25 });
    o.driver.on('status', (s) => { o.status = s; if (s !== 'connected') o.live = null; });
    o.driver.on('weight', (w) => {
      o.live = w;
      const ev = o.detector.push(w);
      if (!ev) return;
      if (ev.type === 'glove') {
        o.stats.add(ev.weight); o.last = ev.weight;
        fs.appendFile(LOG_FILE, `${new Date().toISOString()},${id},${ev.weight}\n`, () => {});
      } else if (ev.type === 'removed' && ev.empty) { o.emptied++; }
      else if (ev.type === 'warn') { o.note = `Heavy item (${ev.weight.toFixed(1)} g) not counted. Add gloves one at a time.`; o.noteUntil = Date.now() + 8000; }
    });
    o.driver.start();
  }
}

function snapshot() {
  const out = {};
  for (const o of Object.values(scales)) {
    out[o.id] = {
      id: o.id, label: o.label, kind: o.kind, hand: o.hand, status: o.status, live: o.live, last: o.last,
      fill: o.detector.base, emptied: o.emptied, note: Date.now() < o.noteUntil ? o.note : null,
      n: o.stats.n, sum: o.stats.sum, mean: o.stats.mean, min: o.stats.min, max: o.stats.max, sd: o.stats.sd, hist: o.stats.hist,
    };
  }
  return { mode: cfg.mode, capacity: cfg.glove.capacity, scales: out };
}

function save() {
  const s = {};
  for (const o of Object.values(scales)) s[o.id] = { stats: o.stats, emptied: o.emptied };
  fs.writeFile(STATE_FILE, JSON.stringify(s), () => {});
}
setInterval(save, 5000);

const clients = new Set();
setInterval(() => { const m = `data: ${JSON.stringify(snapshot())}\n\n`; for (const c of clients) c.write(m); }, 400);

const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => b += d); req.on('end', () => r(b ? JSON.parse(b) : {})); });
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (url === '/api/config' && req.method === 'GET') return json(res, cfg);
  if (url === '/api/config' && req.method === 'POST') {
    const b = await body(req);
    cfg = { ...cfg, mode: b.mode === 'tcp' ? 'tcp' : 'simulator', simSpeed: +b.simSpeed || 1,
      glove: { ...cfg.glove, ...b.glove }, scales: Object.fromEntries(Object.entries(cfg.scales).map(([id, s]) => [id, { ...s, ...(b.scales && b.scales[id]) }])) };
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); startScales(); return json(res, cfg);
  }
  if (url === '/api/reset' && req.method === 'POST') {
    const { id } = await body(req);
    for (const o of Object.values(scales)) if (!id || o.id === id) { o.stats = new Stats(); o.emptied = 0; o.last = null; }
    save(); return json(res, { ok: true });
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  res.writeHead(404); res.end('Not found');
}).listen(cfg.port, () => { console.log(`Glove counter running: http://localhost:${cfg.port}  (mode: ${cfg.mode})`); });

startScales();
process.on('SIGINT', () => { save(); setTimeout(() => process.exit(0), 200); });
