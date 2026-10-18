// Shared bits of UI: toast messages, sound effects and per-screen cleanup.

export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// A screen can register a function to run when the user leaves it (e.g. stop a timer).
let leaveFns = [];
export function onLeave(fn) { leaveFns.push(fn); }
export function runLeave() { const fns = leaveFns; leaveFns = []; fns.forEach(f => { try { f(); } catch { /* ignore */ } }); }

// Tiny sound effects made in the browser (no audio files to download).
let ctx;
function tone(freq, start, dur, type = 'sine', gain = 0.18) {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.05);
}

export function playSound(kind, settings) {
  if (!settings?.sounds) return;
  try {
    if (kind === 'correct') { tone(660, 0, 0.18); tone(880, 0.12, 0.28); }
    else if (kind === 'wrong') { tone(220, 0, 0.35, 'triangle', 0.15); }
    else if (kind === 'done') { tone(523, 0, 0.2); tone(659, 0.15, 0.2); tone(784, 0.3, 0.2); tone(1047, 0.45, 0.4); }
    else if (kind === 'tick') { tone(1000, 0, 0.05, 'square', 0.04); }
  } catch { /* sound not available */ }
}
