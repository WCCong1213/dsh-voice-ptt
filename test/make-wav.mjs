// Build a 16 kHz mono PCM16 WAV for end-to-end probing of the transcribe route.
// Usage: node make-wav.mjs <out.wav> [seconds] [toneHz]
import fs from 'node:fs';

const out = process.argv[2] ?? 'probe.wav';
const seconds = Number(process.argv[3] ?? 1);
const hz = Number(process.argv[4] ?? 440);
const rate = 16000;
const n = Math.max(1, Math.floor(rate * seconds));
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + n * 2, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);   // PCM
buf.writeUInt16LE(1, 22);   // mono
buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(n * 2, 40);
const gain = hz === 0 ? 0 : 0.3;
for (let i = 0; i < n; i++) {
	const sample = hz === 0 ? 0 : Math.sin((2 * Math.PI * hz * i) / rate) * gain;
	buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
}
fs.writeFileSync(out, buf);
console.log(`wrote ${buf.length} bytes → ${out} (${seconds}s @ ${rate}Hz, ${hz === 0 ? 'silence' : hz + 'Hz tone'})`);
