// Scale drivers + glove detection + statistics. No external dependencies.
const net = require('net');
const { EventEmitter } = require('events');

// Running statistics (Welford) + 1 g weight histogram
class Stats {
  constructor() { this.n = 0; this.sum = 0; this.mean = 0; this.m2 = 0; this.min = null; this.max = null; this.hist = {}; }
  add(w) {
    this.n++; this.sum += w;
    const d = w - this.mean; this.mean += d / this.n; this.m2 += d * (w - this.mean);
    this.min = this.min === null ? w : Math.min(this.min, w);
    this.max = this.max === null ? w : Math.max(this.max, w);
    const b = Math.floor(w); this.hist[b] = (this.hist[b] || 0) + 1;
  }
  get sd() { return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0; }
  static from(o) { const s = new Stats(); if (o) Object.assign(s, o); return s; }
}

// Turns a stream of weight readings into "glove added" events.
// A glove = the stable weight rises by an amount between min and max grams.
class Detector {
  constructor(g) { this.g = g; this.buf = []; this.base = 0; }
  push(w) {
    const g = this.g;
    this.buf.push(w);
    if (this.buf.length > g.window) this.buf.shift();
    if (this.buf.length < g.window) return null;
    if (Math.max(...this.buf) - Math.min(...this.buf) > g.tolerance) return null; // not stable yet
    const s = this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
    const d = s - this.base;
    this.base = s;
    if (Math.abs(d) < g.min) return null;                       // noise / drift
    if (d < 0) return { type: 'removed', weight: -d, empty: s < g.min }; // bin emptied
    if (d > g.max) return { type: 'warn', weight: d };          // too heavy: several gloves at once?
    return { type: 'glove', weight: Math.round(d * 10) / 10 };
  }
}

const gauss = (m, sd) => m + sd * (Math.random() + Math.random() + Math.random() - 1.5) * 2;

// Fake scale for testing without hardware
class SimScale extends EventEmitter {
  constructor({ speed = 1, rate = 1 }) { super(); this.speed = speed; this.rate = rate; this.cur = 0; this.target = 0; this.n = 0; }
  start() {
    this.emit('status', 'connected');
    this.tick = setInterval(() => {
      this.cur += (this.target - this.cur) * 0.6;
      this.emit('weight', +(Math.round((this.cur + (Math.random() - 0.5) * 0.3) / 0.2) * 0.2).toFixed(1));
    }, 200);
    this.next();
  }
  next() {
    const wait = (3000 + Math.random() * 5000) / (this.speed * this.rate);
    this.timer = setTimeout(() => {
      if (this.n >= 100) { this.target = 0; this.n = 0; this.timer = setTimeout(() => this.next(), 3000); return; } // operator empties bin
      this.target += gauss(43, 2.5); this.n++; this.next();
    }, wait);
  }
  stop() { clearInterval(this.tick); clearTimeout(this.timer); }
}

// Real scale over Ethernet (TCP). Expects the indicator to stream one reading per line.
// >>> Replace parse() once you have the indicator's protocol document. <<<
class TcpScale extends EventEmitter {
  constructor(host, port) { super(); this.host = host; this.port = port; this.stopped = false; }
  static parse(line) {
    const m = /(-?\d+(?:[.,]\d+)?)\s*(kg|g)?/i.exec(line);
    if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.'));
    return (m[2] || 'g').toLowerCase() === 'kg' ? v * 1000 : v;
  }
  start() { this.connect(); }
  connect() {
    this.emit('status', 'connecting');
    let buf = '';
    const sock = this.sock = net.connect(this.port, this.host);
    sock.setTimeout(5000);
    sock.on('connect', () => this.emit('status', 'connected'));
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const w = TcpScale.parse(buf.slice(0, i));
        buf = buf.slice(i).replace(/^\r?\n/, '');
        if (w !== null) this.emit('weight', w);
      }
    });
    sock.on('timeout', () => sock.destroy());
    sock.on('error', () => {});
    sock.on('close', () => { this.emit('status', 'disconnected'); if (!this.stopped) this.retry = setTimeout(() => this.connect(), 3000); });
  }
  stop() { this.stopped = true; clearTimeout(this.retry); if (this.sock) this.sock.destroy(); }
}

module.exports = { Stats, Detector, SimScale, TcpScale };
