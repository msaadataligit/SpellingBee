// Text-to-speech using the voices built into the device. No audio leaves the device
// unless the device itself uses an online voice (some Chrome "Google" voices do).

const synth = window.speechSynthesis;

export const speechSupported = !!synth && 'SpeechSynthesisUtterance' in window;

let voicesReady;
export function getVoices() {
  if (!speechSupported) return Promise.resolve([]);
  return voicesReady ||= new Promise(resolve => {
    const list = synth.getVoices();
    if (list.length) return resolve(list);
    const t = setTimeout(() => resolve(synth.getVoices()), 1500);
    synth.addEventListener('voiceschanged', () => { clearTimeout(t); resolve(synth.getVoices()); }, { once: true });
  });
}

export async function voicesFor(accent) {
  const all = await getVoices();
  const code = accent.toLowerCase().replace('_', '-');
  return all.filter(v => v.lang.toLowerCase().replace('_', '-') === code);
}

// Prefer local, natural-sounding voices.
function score(v) {
  let s = 0;
  if (v.localService) s += 2;
  if (/natural|enhanced|premium|neural/i.test(v.name)) s += 3;
  if (/google/i.test(v.name)) s += 1;
  return s;
}

export async function pickVoice(settings) {
  const list = await voicesFor(settings.accent);
  if (settings.voiceName) {
    const chosen = list.find(v => v.name === settings.voiceName);
    if (chosen) return chosen;
  }
  return list.sort((a, b) => score(b) - score(a))[0] || null;
}

export async function speak(text, settings, { rate } = {}) {
  if (!speechSupported || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = await pickVoice(settings);
  if (v) u.voice = v;
  u.lang = v ? v.lang : settings.accent;
  u.rate = rate ?? settings.rate ?? 0.9;
  return new Promise(resolve => {
    u.onend = u.onerror = () => resolve();
    synth.speak(u);
  });
}

export function stopSpeaking() {
  if (speechSupported) synth.cancel();
}
