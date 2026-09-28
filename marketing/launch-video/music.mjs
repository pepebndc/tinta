// Score and sound design for the launch film. 120 BPM, events from timeline.js.
// Usage: node music.mjs  ->  music.wav (48 kHz, stereo)
import { writeFileSync } from "node:fs";
import TL from "./timeline.js";

const SR = 48000, DUR = TL.DUR + 0.2, N = Math.floor(SR * DUR), B = 0.5;
// Buses: dry, reverb send, delay send.
const dry = [new Float32Array(N), new Float32Array(N)];
const rev = new Float32Array(N), dly = new Float32Array(N);
let seed = 11;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const rnd = (i) => { const x = Math.sin(i * 91.7 + 13.3) * 43758.5453; return x - Math.floor(x); };
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));
const TAU = Math.PI * 2;
const kicks = [];

// Write one sample to the buses. pan: -1 left, 1 right.
function out(i, v, pan = 0, sRev = 0, sDly = 0) {
  if (i < 0 || i >= N) return;
  const l = Math.cos((pan + 1) * Math.PI / 4), r = Math.sin((pan + 1) * Math.PI / 4);
  dry[0][i] += v * l * 1.414; dry[1][i] += v * r * 1.414;
  rev[i] += v * sRev; dly[i] += v * sDly;
}
// State-variable filter, returns a stepping function.
function svf() {
  let lp = 0, bp = 0;
  return (x, fc, q = 0.7) => {
    const f = 2 * Math.sin(Math.PI * Math.min(fc, SR / 6) / SR);
    const hp = x - lp - q * bp; bp += f * hp; lp += f * bp;
    return { lp, bp, hp };
  };
}

// ---------- Instruments ----------
function kick(t, g = 1) {
  kicks.push(t);
  const s0 = Math.floor(t * SR); let ph = 0;
  for (let i = 0; i < SR * 0.5; i++) {
    const x = i / SR, f = 48 + 150 * Math.exp(-x * 38);
    ph += TAU * f / SR;
    const body = Math.tanh(Math.sin(ph) * 1.6) * Math.exp(-x * 6.5);
    const click = i < 90 ? noise() * 0.25 * (1 - i / 90) : 0;
    out(s0 + i, (body + click) * 0.85 * g, 0, 0.02);
  }
}
function clap(t, g = 1) {
  const s0 = Math.floor(t * SR), f = svf();
  for (let i = 0; i < SR * 0.35; i++) {
    const x = i / SR;
    const env = (x < 0.03 ? [1, 0.2, 0.9, 0.2, 0.8][Math.floor(x / 0.006)] ?? 0.6 : 0.6) * Math.exp(-x * 16);
    const v = f(noise(), 1400, 0.9).bp * env * 0.9 * g;
    out(s0 + i, v, 0, 0.35);
  }
}
function hat(t, g = 1, len = 0.04, pan = 0.2) {
  const s0 = Math.floor(t * SR), f = svf();
  for (let i = 0; i < SR * len * 4; i++) {
    const v = f(noise(), 9000, 0.5).hp * Math.exp(-(i / SR) / len * 3) * 0.16 * g;
    out(s0 + i, v, pan, 0.08);
  }
}
function shaker(t, g = 1) {
  const s0 = Math.floor(t * SR), f = svf();
  for (let i = 0; i < SR * 0.07; i++) {
    const x = i / SR, e = Math.min(1, x / 0.012) * Math.exp(-x * 55);
    out(s0 + i, f(noise(), 7000, 0.6).bp * e * 0.12 * g, -0.35, 0.05);
  }
}
function sub(t, dur, m, g = 1) {
  const s0 = Math.floor(t * SR), f0 = hz(m), f = svf();
  for (let i = 0; i < SR * dur; i++) {
    const x = i / SR;
    const env = Math.min(1, x / 0.006) * Math.min(1, (dur - x) / 0.03);
    const raw = Math.sin(TAU * f0 * x) + 0.35 * saw(f0 * x * 2.0006);
    const v = f(raw, 380 + 900 * Math.exp(-x * 18), 0.8).lp;
    out(s0 + i, Math.tanh(v * 1.4) * env * 0.36 * g);
  }
}
function pad(t, dur, notes, g = 1, cut = 1200, cutEnd = cut, pan = 0.3) {
  const s0 = Math.floor(t * SR), fl = svf(), fr = svf();
  const det = [-0.11, 0, 0.12];
  for (let i = 0; i < SR * dur; i++) {
    const x = i / SR; let l = 0, r = 0;
    for (const m of notes) {
      const f = hz(m);
      for (let d = 0; d < 3; d++) { const v = saw(f * x * (1 + det[d] / 100) + d * 0.31 + m * 0.07); if (d !== 2) l += v; if (d !== 0) r += v; }
    }
    const fc = cut + (cutEnd - cut) * (x / dur);
    const env = Math.min(1, x / 0.35) * Math.min(1, (dur - x) / 0.4);
    const vl = fl(l, fc, 0.6).lp * env * 0.022 * g, vr = fr(r, fc, 0.6).lp * env * 0.022 * g;
    if (s0 + i < N && s0 + i >= 0) { dry[0][s0 + i] += vl * (1 - pan * 0.5); dry[1][s0 + i] += vr * (1 - pan * 0.5); rev[s0 + i] += (vl + vr) * 0.35; }
  }
}
function pluck(t, m, g = 1, pan = 0) {
  const s0 = Math.floor(t * SR), f0 = hz(m), f = svf();
  for (let i = 0; i < SR * 0.45; i++) {
    const x = i / SR;
    const raw = saw(f0 * x) * 0.7 + saw(f0 * x * 1.004) * 0.5;
    const v = f(raw, 600 + 5200 * Math.exp(-x * 22), 0.8).lp * Math.exp(-x * 9) * 0.1 * g;
    out(s0 + i, v, pan, 0.22, 0.28);
  }
}
// FM bell for accents.
function bell(t, m, g = 1, pan = 0, decay = 2.2) {
  const s0 = Math.floor(t * SR), f0 = hz(m);
  for (let i = 0; i < SR * decay * 1.5; i++) {
    const x = i / SR, idx = 2.2 * Math.exp(-x * 5);
    const v = Math.sin(TAU * f0 * x + idx * Math.sin(TAU * f0 * 3.5 * x)) * Math.exp(-x * 3 / decay) * Math.min(1, x / 0.003) * 0.11 * g;
    out(s0 + i, v, pan, 0.45, 0.2);
  }
}

// ---------- Sound design ----------
function whoosh(t, dur, g = 1, up = true, pan0 = -0.6, pan1 = 0.6) {
  const s0 = Math.floor(t * SR), n = Math.floor(dur * SR), f = svf();
  for (let i = 0; i < n; i++) {
    const k = i / n, sh = up ? k : 1 - k;
    const env = Math.pow(Math.sin(Math.PI * Math.pow(k, up ? 1.6 : 0.6)), 2);
    const v = f(noise(), 300 + 5000 * sh * sh, 1.4).bp * env * 0.55 * g;
    out(s0 + i, v, pan0 + (pan1 - pan0) * k, 0.3);
  }
}
function riser(t0, t1, g = 1) {
  const s0 = Math.floor(t0 * SR), n = Math.floor((t1 - t0) * SR), f = svf(); let ph = 0;
  for (let i = 0; i < n; i++) {
    const k = i / n; ph += (220 + 660 * k * k) / SR;
    const v = (f(noise(), 400 + 7000 * k * k, 1.2).bp * 0.6 + saw(ph) * 0.08 * k) * k * k * 0.5 * g;
    out(s0 + i, v, Math.sin(k * 9) * 0.3, 0.3);
  }
}
function impact(t, g = 1) {
  const s0 = Math.floor(t * SR), f = svf(); let ph = 0;
  for (let i = 0; i < SR * 2.2; i++) {
    const x = i / SR; ph += TAU * (34 + 70 * Math.exp(-x * 7)) / SR;
    const boom = Math.tanh(Math.sin(ph) * 2) * Math.exp(-x * 2.4) * 0.7;
    const air = f(noise(), 2500, 0.7).lp * Math.exp(-x * 5) * 0.35;
    out(s0 + i, (boom + air) * g, 0, 0.3);
  }
}
function uiClick(t, g = 1) {
  const s0 = Math.floor(t * SR);
  for (let i = 0; i < SR * 0.05; i++) {
    const x = i / SR;
    const v = (Math.sin(TAU * 2600 * x) * Math.exp(-x * 400) * 0.5 + Math.sin(TAU * 180 * x) * Math.exp(-x * 90) * 0.6) * g * 0.5;
    out(s0 + i, v, 0.15, 0.1);
  }
}
function tick(t, g = 1, pitch = 1) {
  const s0 = Math.floor(t * SR), f = svf();
  for (let i = 0; i < SR * 0.025; i++) {
    const x = i / SR;
    out(s0 + i, f(noise(), 3200 * pitch, 2).bp * Math.exp(-x * 260) * 0.35 * g, -0.2, 0.03);
  }
}
function pop(t, m = 84, g = 1, pan = 0) {
  const s0 = Math.floor(t * SR), f0 = hz(m);
  for (let i = 0; i < SR * 0.12; i++) {
    const x = i / SR;
    out(s0 + i, Math.sin(TAU * f0 * x * (1 + 0.6 * Math.exp(-x * 60))) * Math.exp(-x * 38) * 0.22 * g, pan, 0.25);
  }
}
function drip(t, g = 1) {
  const s0 = Math.floor(t * SR); let ph = 0;
  for (let i = 0; i < SR * 0.25; i++) {
    const x = i / SR; ph += TAU * (500 + 1700 * (1 - Math.exp(-x * 45))) / SR;
    out(s0 + i, Math.sin(ph) * Math.exp(-x * 22) * 0.4 * g, 0, 0.5);
  }
}
function lockClick(t, g = 1) {
  [0, 0.028].forEach((o, k) => {
    const s0 = Math.floor((t + o) * SR), f = svf();
    for (let i = 0; i < SR * 0.06; i++) { const x = i / SR; out(s0 + i, f(noise(), k ? 1800 : 4200, 3).bp * Math.exp(-x * 160) * 0.9 * g, 0, 0.2); }
  });
  sub(t, 0.18, 33, 0.8 * g);
}

// ---------- Harmony ----------
// One chord per bar: [root, pad voicing]. D major, lifted with 9ths and 7ths.
const PROG = [[38, [62, 66, 69, 73, 76]], [35, [59, 62, 66, 69, 74]], [31, [59, 62, 66, 71, 74]], [33, [61, 64, 69, 71, 76]]];
const DARK = [[35, [59, 62, 66, 69]], [31, [59, 62, 67, 71]], [28, [55, 59, 64, 67]], [30, [57, 61, 64, 69]]];
const chord = (t, P = PROG) => P[Math.floor(t / 2) % 4];
const ARP = [0, 2, 4, 2, 1, 3, 4, 3];

function groove(a, b, o = {}) {
  const g = o.gain ?? 1, P = o.dark ? DARK : PROG;
  for (let t = a; t < b - 1e-6; t += B) {
    const beat = Math.round(t / B), [root, notes] = chord(t, P);
    if (!o.noKick) kick(t, g);
    if (!o.noClap && beat % 2 === 1) clap(t, 0.8 * g);
    hat(t + B / 2, 0.9 * g, 0.045, 0.25);
    if (o.busy) { hat(t + B / 4, 0.35 * g, 0.02, -0.3); hat(t + 3 * B / 4, 0.35 * g, 0.02, -0.3); }
    for (let s = 0; s < 4; s++) shaker(t + s * B / 4, (s % 2 ? 0.8 : 0.45) * g);
    sub(t, B * 0.45, root + 12, 0.95 * g);
    sub(t + B * 0.5, B * 0.4, root + (beat % 4 === 3 ? 19 : 12), 0.7 * g);
    if (!o.noArp) for (let s = 0; s < 4; s++) pluck(t + s * B / 4, notes[ARP[(beat * 4 + s) % 8]] + 12, (s === 0 ? 0.9 : 0.6) * g * (o.arpGain ?? 1), s % 2 ? 0.35 : -0.35);
  }
  for (let t = a; t < b - 1e-6; t += 2) pad(t, Math.min(2.1, b - t + 0.1), chord(t, P)[1], 0.9 * g, o.cut ?? 1600, o.cutEnd ?? o.cut ?? 1600);
}

// ---------- Score ----------
const S = TL;
// Hook.
pad(0, 2.2, PROG[0][1].map((m) => m - 12), 0.9, 500, 1400);
sub(0, 2.1, 38, 0.35);
bell(S.hook.in + 0.05, 74, 0.8, -0.2); bell(S.hook.roll[0] + 0.1, 78, 0.8, 0.2); bell(S.hook.roll[1] + 0.1, 81, 0.9, 0);
impact(S.hook.out + 0.05, 0.45);
pad(S.hook.out, 1.6, DARK[0][1], 1.0, 700, 2000);
sub(S.hook.out, 1.5, 35, 0.5);
whoosh(S.floods[0].t0 - 0.15, 0.8, 1.0, true, -0.3, 0.3);
// Logo.
drip(S.logo.drop, 1.2);
impact(S.logo.drop, 0.35);
[86, 93, 90, 97].forEach((m, i) => bell(S.logo.drop + 0.02 + i * 0.09, m, 0.55, [-0.5, 0.5, -0.2, 0.3][i], 2.6));
pad(4.0, 4.1, PROG[0][1], 1.0, 800, 2600);
sub(4.0, 3.9, 38, 0.4);
for (let t = 4.0; t < 8.0 - 1e-6; t += B / 2) { const k = (t - 4) / 4; pluck(t, PROG[Math.floor(t / 2) % 2 ? 0 : 0][1][ARP[Math.round(t * 4) % 8]] + 12, 0.25 + k * 0.5, Math.round(t * 4) % 2 ? 0.4 : -0.4); }
pop(S.logo.glyph, 88, 0.8); pop(S.logo.dot, 93, 0.7);
whoosh(S.logo.word - 0.05, 0.7, 0.35, true, -0.2, 0.5);
whoosh(S.logo.fly[0], 0.95, 0.8, true, 0.2, -0.6);
riser(6.4, 8.0, 0.9);
// App: the beat comes in.
impact(8.0, 0.6);
groove(8.0, 19.5, { cut: 1500, cutEnd: 2400 });
uiClick(S.app.click, 1.3);
pop(S.app.swap + 0.15, 81, 0.6);
S.app.noteTimes.forEach((nt, i) => { if (S.app.notes[i] !== "\n") tick(nt, 0.55 + rnd(i) * 0.3, 0.8 + rnd(i + 5) * 0.5); });
S.app.turns.forEach((tt, i) => pop(tt, 79 + i * 2, 0.45, 0.4));
whoosh(S.app.zoom[0] - 0.1, 1.1, 0.55, true, -0.4, 0.4);
whoosh(S.app.meet - 0.05, 0.7, 0.4, false, 0.8, 0.3);
bell(S.app.rename, 86, 0.8, 0.3); bell(S.app.rename + 0.08, 90, 0.6, 0.4);
whoosh(S.app.out[0] - 0.1, 0.9, 0.7, true, 0.4, -0.6);
S.sum.sections.forEach((st, i) => { bell(st + 0.4, [81, 83, 85, 88][i], 0.35, 0.3); });
pop(S.sum.check, 88, 0.9); pop(S.sum.check + 0.08, 95, 0.5);
// Privacy.
whoosh(S.floods[1].t0 - 0.2, 0.7, 0.9, true, 0.5, -0.2);
impact(20.0, 0.9);
pad(20.0, 2.3, DARK[0][1], 1.1, 600, 1800);
sub(20.0, 2.2, 35, 0.5);
[20.0, 21.0, 22.0].forEach((t) => kick(t, 0.7));
for (let t = 20.0; t < 22.2; t += B) hat(t + B / 2, 0.5);
[0, 1, 2, 3].forEach((i) => pop(S.priv.labels + i * 0.12, 83 + i * 2, 0.5, i < 2 ? -0.5 : 0.5));
whoosh(S.priv.push[0] - 0.1, 0.85, 1.1, true, 0, 0);
impact(S.priv.push[1], 0.8);
for (let k = 0; k < 14; k++) { const c = k / 13; const tt = S.priv.count[0] + (S.priv.count[1] - S.priv.count[0]) * (1 - Math.pow(1 - c, 2.2)); tick(tt, 0.9, 1.6 - c * 0.9); }
bell(S.priv.count[1], 69, 0.9, 0, 3); bell(S.priv.count[1], 81, 0.5, 0, 3);
pad(22.9, 1.8, DARK[1][1], 0.9, 900, 700);
sub(22.9, 1.7, 31, 0.4);
[23.5, 24.0].forEach((t) => kick(t, 0.5));
whoosh(S.priv.zeroOut - 0.05, 0.6, 0.5, false, 0, 0.3);
lockClick(S.priv.click, 1.2);
pad(24.6, 3.0, DARK[2][1], 1.0, 700, 2200);
sub(24.6, 1.4, 28, 0.45);
S.priv.lines.forEach((lt, i) => pop(lt, 79 + i * 3, 0.45, 0.3));
groove(26.0, 27.5, { dark: true, noArp: true, noClap: true, gain: 0.8, cut: 900, cutEnd: 2400 });
riser(26.6, 27.95, 0.9);
whoosh(S.floods[2].t0 - 0.1, 0.6, 0.8, true, -0.5, 0.3);
// MCP.
impact(28.0, 0.5);
groove(28.0, 31.5, { busy: true, cut: 1800, cutEnd: 3000 });
for (let k = 0; k < 18; k++) tick(S.mcp.q[0] + k * ((S.mcp.q[1] - S.mcp.q[0]) / 18), 0.45, 1.2);
pop(S.mcp.tool, 84, 0.6);
for (let i = 0; i < 7; i++) pop(S.mcp.packets + 0.22 + i * 0.1, 91 + (i % 3) * 3, 0.45, -0.4 + i * 0.12);
bell(S.mcp.done, 90, 0.7, 0.3);
[0, 1].forEach((i) => pop(S.mcp.cites + i * 0.1, 86 + i * 3, 0.5));
riser(30.8, 31.95, 0.8);
whoosh(S.floods[3].t0 - 0.1, 0.6, 0.9, true, 0.3, -0.3);
// End card.
impact(32.0, 1.0);
kick(32.0, 1.0);
[74, 78, 81, 86, 93].forEach((m, i) => bell(32.1 + i * 0.06, m, 0.5, [-0.6, 0.6, -0.3, 0.3, 0][i], 3));
pop(S.end.glyph, 88, 0.7); pop(S.end.dot, 93, 0.6);
whoosh(S.end.word - 0.05, 0.7, 0.35, true, -0.2, 0.5);
groove(32.0, 36.0, { gain: 0.7, noClap: false, arpGain: 0.8, cut: 2200 });
pad(36.0, 2.2, PROG[0][1], 1.0, 2000, 600);
sub(36.0, 1.6, 38, 0.6);
kick(36.0, 0.7);
bell(36.0, 86, 0.6, 0, 3); bell(36.06, 90, 0.5, 0.3, 3);

// ---------- Effects and master ----------
// Ping-pong delay, 3/8 note, into the reverb.
{
  const d = Math.floor(0.375 * SR), fb = 0.38; const bl = new Float32Array(N), br = new Float32Array(N); let lp = 0;
  for (let i = 0; i < N; i++) {
    const inL = dly[i] + (i >= d ? br[i - d] * fb : 0), inR = i >= d ? bl[i - d] : 0;
    lp += 0.35 * (inL - lp); bl[i] = lp; br[i] = inR;
    dry[0][i] += bl[i] * 0.5; dry[1][i] += br[i] * 0.5; rev[i] += (bl[i] + br[i]) * 0.1;
  }
}
// Feedback delay network reverb: 8 lines, Householder mix, damped.
{
  const lens = [1553, 1811, 2003, 2213, 2503, 2777, 3079, 3371].map((x) => Math.floor(x * 1.9));
  const bufs = lens.map((l) => new Float32Array(l)), idx = new Array(8).fill(0), damp = new Array(8).fill(0);
  const g = 0.86, pre = Math.floor(0.025 * SR);
  for (let i = 0; i < N; i++) {
    const x = i >= pre ? rev[i - pre] : 0;
    const o = bufs.map((b, k) => b[idx[k]]);
    const sum = o.reduce((a, b) => a + b, 0) * (2 / 8);
    let l = 0, r = 0;
    for (let k = 0; k < 8; k++) {
      let v = (o[k] - sum) * g + x * 0.35;
      damp[k] += 0.45 * (v - damp[k]); v = damp[k];
      bufs[k][idx[k]] = v; idx[k] = (idx[k] + 1) % lens[k];
      if (k % 2) r += o[k]; else l += o[k];
    }
    dry[0][i] += l * 0.32; dry[1][i] += r * 0.32;
  }
}
// Sidechain the music to the kicks, then compress and limit.
const duck = new Float32Array(N).fill(1);
for (const t of kicks) { const s0 = Math.floor(t * SR); for (let i = 0; i < SR * 0.25; i++) if (s0 + i < N) duck[s0 + i] = Math.min(duck[s0 + i], 0.6 + 0.4 * Math.pow(i / (SR * 0.25), 0.7)); }
let env = 0, peak = 0;
const Lo = new Float32Array(N), Ro = new Float32Array(N);
for (let i = 0; i < N; i++) {
  let l = dry[0][i] * duck[i], r = dry[1][i] * duck[i];
  const lev = Math.max(Math.abs(l), Math.abs(r));
  env = lev > env ? env + 0.01 * (lev - env) : env + 0.0002 * (lev - env);
  const gr = env > 0.5 ? Math.pow(0.5 / env, 0.5) : 1;
  l = Math.tanh(l * gr * 1.2); r = Math.tanh(r * gr * 1.2);
  Lo[i] = l; Ro[i] = r; peak = Math.max(peak, Math.abs(l), Math.abs(r));
}
const fadeA = Math.floor(TL.end.fade[0] * SR), fadeB = Math.floor(TL.end.fade[1] * SR);
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const f = i < fadeA ? 1 : Math.max(0, 1 - (i - fadeA) / (fadeB - fadeA)) ** 1.5;
  buf.writeInt16LE(Math.round((Lo[i] / peak) * 0.94 * f * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round((Ro[i] / peak) * 0.94 * f * 32767), 46 + i * 4);
}
writeFileSync("music.wav", buf);
console.log("peak", peak.toFixed(2));
