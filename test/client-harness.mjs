/**
 * Offline harness for the browser half of @wccong1213/dsh-voice-ptt.
 *
 * Runs the REAL lib/client.js inside jsdom with real React 18, a fake slot
 * context, a fake InputState store, a fake speech Remote and a fake
 * microphone, then drives every state the control has:
 *
 *   idle (speech not ready) → disabled
 *   idle (ready) → hold Space → recording → release → transcribing → sent
 *   recording → Esc → cancelled (nothing inserted, nothing sent)
 *   autoSend off → inserted only, no submit
 *   empty transcript → toast, nothing sent
 *   transcribe error → toast, nothing sent
 *   filler cleanup on/off → transcript text differs
 *   spaceEnabled off → Space ignored; click re-enables
 *   Space keydown is preventDefault'ed (no spaces typed)
 *   Space outside an editable is ignored
 *
 * Usage: node test/client-harness.mjs [path-to-client.js]
 * Deps:   jsdom + react + react-dom (see README)
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const CLIENT_PATH = process.argv[2]
	?? 'F:/2 工具/12-DeepSeek-Harness-插件/plugins/dsh-voice-ptt-dev/lib/client.js';
// ESM resolves bare imports against THIS file's path; NODE_PATH and cwd do not
// apply, so the deps are loaded through a require anchored inside the deps dir.
const DEPS = process.argv[3]
	?? 'F:/2 工具/12-DeepSeek-Harness-插件/plugins/dsh-workspace-sidebar-dev/node_modules';
const require = createRequire(`${DEPS}/noop.cjs`);
const { JSDOM } = require('jsdom');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react-dom/test-utils');

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	if (!ok) console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
	else console.log(`ok    ${name}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── jsdom ────────────────────────────────────────────────────────────────────
// jsdom does not implement `isContentEditable`; the real composer is a
// Lexical contenteditable, so the fake one declares the attribute explicitly.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div contenteditable="true" id="composer"></div></body></html>', {
	url: 'http://127.0.0.1:30401/',
	pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.localStorage = dom.window.localStorage;
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

// ── fake microphone stack ───────────────────────────────────────────────────
const mic = { permission: 'granted', started: 0, stopped: 0, disposed: 0, trackStops: 0 };
const makeTrack = () => ({ stop() { mic.trackStops += 1; }, addEventListener() {}, getSettings: () => ({}) });
const makeStream = () => ({ getTracks: () => [makeTrack()] });
Object.defineProperty(dom.window.navigator, 'mediaDevices', {
	configurable: true,
	value: {
		async getUserMedia() {
			if (mic.permission === 'denied') throw new DOMException('denied', 'NotAllowedError');
			if (mic.permission === 'missing') throw new DOMException('missing', 'NotFoundError');
			mic.started += 1;
			return makeStream();
		},
	},
});
class FakeMediaRecorder {
	constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; this.ondataavailable = null; this.onstop = null; this.onerror = null; }
	start() {
		this.state = 'recording';
		// Real browsers deliver chunks while recording; the plugin needs at least
		// one non-empty chunk or `stop()` reports an empty capture.
		setTimeout(() => this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: 'audio/webm' }) }), 5);
	}
	stop() { this.state = 'inactive'; this.onstop?.(); }
}
globalThis.MediaRecorder = dom.window.MediaRecorder = FakeMediaRecorder;
class FakeOfflineContext {
	constructor() { this.destination = {}; }
	createBufferSource() { return { connect() {}, start() {} }; }
	async startRendering() {
		return { getChannelData: () => new Float32Array(16000) }; // 1 s of silence
	}
}
class FakeAudioContext {
	constructor() { this.state = 'running'; }
	async decodeAudioData() { return { duration: 1 }; }
	async close() { this.state = 'closed'; }
}
globalThis.AudioContext = dom.window.AudioContext = FakeAudioContext;
globalThis.OfflineAudioContext = dom.window.OfflineAudioContext = FakeOfflineContext;

// ── fake Host routes (status + transcribe + alive) ──────────────────────────
const speech = {
	ready: true,          // drives /status: provider present and prepared
	providers: [{ id: 'sensevoice-local', location: 'host-local' }],
	selection: { providerId: 'sensevoice-local', language: 'auto' },
	calls: 0,
	lastRequest: null,
	mode: 'ok',           // ok | error | empty
	transcript: '嗯 帮我看看那个报表哪里不对 就是说逐项核对一下',
	error: 'model not loaded',
};
const pings = [];
const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.fetch = async (url, init = {}) => {
	const path = String(url);
	if (path === '/dsh-voice-ptt/alive') {
		pings.push(JSON.parse(init.body ?? '{}'));
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	}
	if (path === '/dsh-voice-ptt/status') {
		return {
			ok: true, status: 200,
			json: async () => ({
				ok: true,
				host: {
					providers: speech.ready ? speech.providers : [],
					snapshot: { selection: speech.selection },
				},
			}),
		};
	}
	if (path === '/dsh-voice-ptt/transcribe') {
		speech.calls += 1;
		speech.lastRequest = JSON.parse(init.body ?? '{}');
		await sleepFor(30);
		if (speech.mode === 'error') return { ok: false, status: 500, json: async () => ({ ok: false, code: 'transcription_failed', message: speech.error }) };
		if (speech.mode === 'empty') return { ok: true, status: 200, json: async () => ({ ok: true, text: '' }) };
		return { ok: true, status: 200, json: async () => ({ ok: true, text: speech.transcript }) };
	}
	throw new Error(`unexpected fetch(${path})`);
};

// ── fake InputState store ────────────────────────────────────────────────────
const store = {
	state: { draft: '', phase: 'plain' },
	listeners: new Set(),
	set(patch) { store.state = { ...store.state, ...patch }; for (const l of store.listeners) l(); },
	subscribe(l) { store.listeners.add(l); return () => store.listeners.delete(l); },
};
function useInput(selector) { return React.useSyncExternalStore(store.subscribe, () => selector(store.state), () => selector(store.state)); }
const actions = { inserts: [], submits: 0 };
const inputActions = {
	captureInsertion: () => ({ start: 0, end: 0, rev: 0 }),
	insertText(text) { actions.inserts.push(text); store.set({ draft: store.state.draft + text }); return true; },
	submit() { actions.submits += 1; store.set({ draft: '' }); },
};

// ── fake locale ──────────────────────────────────────────────────────────────
const dicts = new Map();
const fakeLocale = {
	register(ns, id, dict) { dicts.set(`${ns}:${id}`, dict); return () => {}; },
	bind(ns) { return (key) => dicts.get(`${ns}:zh-CN`)?.[key] ?? key; },
};

// ── load the real client half ────────────────────────────────────────────────
let captured = null;
globalThis.window.__ModuleLoader__ = { load: (mod) => { captured = mod; } };
new Function(fs.readFileSync(CLIENT_PATH, 'utf8'))();
check('client module loads with id @wccong1213/dsh-voice-ptt', captured?.id === '@wccong1213/dsh-voice-ptt', String(captured?.id));

const client = captured.factory((name) => {
	if (name === 'react') return React;
	throw new Error(`unexpected require(${name})`);
});

let Component = null;
const registered = [];
const effects = [];
const fakeCtx = {
	get: (name) => (name === 'locale' ? fakeLocale : undefined),
	effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); },
	inject(_names, cb) { try { cb(fakeCtx); } catch (error) { console.error(error); } return () => {}; },
	slots: {
		inject(name, cb) { registered.push(name); cb(); return () => {}; },
		register(options, component) { registered.push(`${options.name}#${options.id}@${options.order}`); Component = component; return () => {}; },
	},
};
client.apply(fakeCtx);
check('injects into conversation.input.right (coexists with official activity slot)', registered.includes('conversation.input.right'));
check('registers id voice-ptt at order 99 (rightmost)', registered.includes('conversation.input.right#voice-ptt@99'));
check('locale registered zh-CN + en', dicts.has('dsh-voice-ptt:zh-CN') && dicts.has('dsh-voice-ptt:en'));
check('cordis inject declares only slots (recognition is an HTTP route)', JSON.stringify(client.inject) === JSON.stringify(['slots']), JSON.stringify(client.inject));
check('apply pings the Host mount route (apply + slot-registered phases)', pings.length === 2 && pings[0].phase === 'apply' && pings[1].phase === 'slot-registered', JSON.stringify(pings.map((p) => p.phase)));

// ── helpers ──────────────────────────────────────────────────────────────────
const container = document.getElementById('root');
const root = createRoot(container);
const render = (sessionId = 's1') => act(async () => { root.render(React.createElement(Component, { useInput, inputActions, sessionId })); });
const button = () => container.querySelector('[data-dsh-voice-ptt="button"]');
const state = () => button()?.dataset.state;
const text = () => container.querySelector('.dsh-vptt-btn')?.textContent ?? '';
const key = (type, code, target = document.getElementById('composer'), repeat = false) => {
	const event = new dom.window.KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true, repeat });
	target.dispatchEvent(event);
	return event;
};
const resetSync = () => {
	actions.inserts.length = 0;
	actions.submits = 0;
	store.set({ draft: '', phase: 'plain' });
	// Every test starts from a known recognizer + default settings; leaving either
	// behind makes a later assertion fail for a reason that belongs to an earlier test.
	speech.mode = 'ok';
	speech.ready = true;
	speech.transcript = '嗯 帮我看看那个报表哪里不对 就是说逐项核对一下';
	localStorage.removeItem('dsh-voice-ptt.settings.v1');
	window.dispatchEvent(new window.Event('dsh-voice-ptt:settings'));
};
const reset = () => act(async () => { resetSync(); await sleep(30); });
/** Change persisted settings the way a real settings change is observed: write, then notify. */
const setSettings = (patch) => act(async () => {
	localStorage.setItem('dsh-voice-ptt.settings.v1', JSON.stringify({ autoSend: true, fillerCleanup: true, spaceEnabled: true, ...patch }));
	window.dispatchEvent(new window.Event('dsh-voice-ptt:settings'));
	await sleep(10);
});
const defaultSettings = () => act(async () => { localStorage.clear(); window.dispatchEvent(new window.Event('dsh-voice-ptt:settings')); await sleep(10); });

await render();
await act(async () => { await sleep(30); });

// ── 1. recognizer not ready → disabled ─────────────────────────────────────
// Readiness comes from the Host /status route, polled every 2 s; drive it by
// flipping the fake and letting the poller run.
speech.ready = false;
await act(async () => { await sleep(2200); });
check('no provider → button disabled', state() === 'idle' && button().disabled === true, `state=${state()} disabled=${button().disabled}`);

speech.ready = true;
await act(async () => { await sleep(2200); });
check('provider present → button enabled', state() === 'idle' && button().disabled === false, `state=${state()}`);

// ── 2. full happy path: hold Space → release → sent ────────────────────────
await reset();
await act(async () => { key('keydown', 'Space'); await sleep(400); });
check('hold Space → recording', state() === 'recording', `state=${state()} text=${text()}`);
check('mic started once', mic.started === 1, String(mic.started));
const kd = key('keydown', 'Space');
check('Space keydown preventDefault (no space typed)', kd.defaultPrevented === true);
// Holding produces an auto-repeat stream; every one of those must be swallowed
// too, or the editor receives a space per repeat tick.
const repeat1 = key('keydown', 'Space', undefined, true);
const repeat2 = key('keydown', 'Space', undefined, true);
check('auto-repeat Space keydown also preventDefault (no spaces leak)', repeat1.defaultPrevented === true && repeat2.defaultPrevented === true);
await act(async () => { key('keyup', 'Space'); await sleep(80); });
check('release → transcribing then idle', state() === 'idle', `state=${state()}`);
check('transcribe called once with provider+language', speech.calls === 1 && speech.lastRequest?.providerId === 'sensevoice-local' && speech.lastRequest?.language === 'auto', JSON.stringify({ calls: speech.calls, req: speech.lastRequest && { p: speech.lastRequest.providerId, l: speech.lastRequest.language } }));
check('audio sent as base64 WAV (RIFF header)', typeof speech.lastRequest?.audioBase64 === 'string' && Buffer.from(speech.lastRequest.audioBase64, 'base64').subarray(0, 4).toString() === 'RIFF');
check('filler cleanup: pure 嗯/就是说 removed even when glued; CJK gaps closed; 那个报表 kept (ambiguous, glued)', actions.inserts[0] === '帮我看看那个报表哪里不对逐项核对一下', `inserted="${actions.inserts[0]}"`);
check('autoSend on → submit called once', actions.submits === 1, String(actions.submits));
check('autoSend success → no toast (chat is the confirmation)', document.querySelector('.dsh-vptt-toast') === null, document.querySelector('.dsh-vptt-toast')?.textContent);

// ── 3. Esc cancels ──────────────────────────────────────────────────────────
await reset();
await act(async () => { key('keydown', 'Space'); await sleep(400); });
check('recording again', state() === 'recording');
await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(10); });
check('Esc → idle, nothing inserted or sent', state() === 'idle' && actions.inserts.length === 0 && actions.submits === 0, `inserts=${actions.inserts.length} submits=${actions.submits}`);
await act(async () => { key('keyup', 'Space'); await sleep(50); });
check('release after Esc does nothing', actions.inserts.length === 0 && speech.calls === 1);

// ── 4. autoSend off → insert only ──────────────────────────────────────────
await reset(); speech.calls = 0;
await setSettings({ autoSend: false });
await act(async () => { key('keydown', 'Space'); await sleep(400); key('keyup', 'Space'); await sleep(80); });
check('autoSend off → inserted but NOT submitted', actions.inserts.length === 1 && actions.submits === 0, `inserts=${actions.inserts.length} submits=${actions.submits}`);
check('autoSend off → no toast either', document.querySelector('.dsh-vptt-toast') === null, document.querySelector('.dsh-vptt-toast')?.textContent);
await defaultSettings();

// ── 5. empty transcript → toast, no send ───────────────────────────────────
await reset(); speech.calls = 0; speech.mode = 'empty';
await act(async () => { key('keydown', 'Space'); await sleep(400); key('keyup', 'Space'); await sleep(80); });
check('empty transcript → nothing inserted/sent', actions.inserts.length === 0 && actions.submits === 0);
check('empty transcript → icon flash, no popup', document.querySelector('.dsh-vptt-toast') === null && button()?.dataset.state === 'idle', 'toast=' + (document.querySelector('.dsh-vptt-toast')?.textContent ?? 'none'));

// ── 6. transcribe error → toast, no send ────────────────────────────────────
await reset(); speech.mode = 'error';
await act(async () => { key('keydown', 'Space'); await sleep(400); key('keyup', 'Space'); await sleep(80); });
check('transcribe error → nothing inserted/sent', actions.inserts.length === 0 && actions.submits === 0);
check('transcribe error → icon flash, no popup', document.querySelector('.dsh-vptt-toast') === null && button()?.dataset.state === 'idle', 'toast=' + (document.querySelector('.dsh-vptt-toast')?.textContent ?? 'none'));

// ── 7. filler cleanup off keeps the raw words ──────────────────────────────
await reset(); speech.mode = 'ok';
await setSettings({ autoSend: false, fillerCleanup: false });
await act(async () => { key('keydown', 'Space'); await sleep(400); key('keyup', 'Space'); await sleep(80); });
check('fillerCleanup off → raw transcript kept', actions.inserts[0] === speech.transcript, `inserted="${actions.inserts[0]}"`);
await defaultSettings();

// ── 7b. cleanup must not eat a word that merely contains a filler string ────
// autoSend is off so the transcript lands in the composer instead of being sent:
// this test is about the text, not about submission.
await reset(); await setSettings({ autoSend: false }); speech.transcript = '那个人 经理 说 对对对';
await act(async () => { key('keydown', 'Space'); await sleep(400); key('keyup', 'Space'); await sleep(120); });
check('cleanup keeps 那个人 (no leading boundary) and drops standalone 对对对; CJK gaps closed', actions.inserts[0] === '那个人经理说', `inserted="${actions.inserts[0]}"`);
speech.transcript = '嗯 帮我看看那个报表哪里不对 就是说逐项核对一下';
await defaultSettings();

// ── 8. spaceEnabled off → Space ignored; click re-enables ─────────────────
await reset();
const startedBefore8 = mic.started;
await setSettings({ spaceEnabled: false });
check('spaceEnabled off → data-state=off', state() === 'off', state());
const kd2 = key('keydown', 'Space');
await act(async () => { await sleep(10); });
check('spaceEnabled off → Space NOT preventDefault, not recording', kd2.defaultPrevented === false && state() === 'off' && mic.started === startedBefore8, `prevented=${kd2.defaultPrevented} started=${mic.started}`);
await act(async () => { key('keyup', 'Space'); });
await act(async () => { button().click(); await sleep(10); });
check('click while off → re-enabled (idle), no recording', state() === 'idle' && mic.started === startedBefore8, `state=${state()} started=${mic.started}`);
check('setting persisted', JSON.parse(localStorage.getItem('dsh-voice-ptt.settings.v1')).spaceEnabled === true);

// ── 9. Space outside an editable is ignored ─────────────────────────────────
await reset(); const before = mic.started;
await act(async () => { key('keydown', 'Space', document.body); await sleep(10); key('keyup', 'Space', document.body); await sleep(10); });
check('Space on <body> → ignored', mic.started === before && state() === 'idle');

// ── 9b. DaBao rule: a non-empty draft keeps Space as a plain space ──────────
await reset();
await act(async () => { store.set({ draft: '已经有文字了' }); await sleep(30); });
const startedBeforeText = mic.started;
const spaced = key('keydown', 'Space');
await act(async () => { await sleep(30); });
check('draft has text → Space does NOT record and is NOT swallowed', spaced.defaultPrevented === false && mic.started === startedBeforeText && state() === 'idle', `prevented=${spaced.defaultPrevented} started=${mic.started} state=${state()}`);
await act(async () => { key('keyup', 'Space'); });
await reset();

// ── 9c. quotes are not typing: Space still dictates next to a quote ─────────
const startedBeforeQuote = mic.started;
for (const [label, draftText] of [
	['single-line quote', '> 这是一段引用'],
	['wrapped quote', '> 引用第一行\n> 引用第二行'],
	['quote with trailing blank', '> 引用\n\n'],
]) {
	await reset();
	await act(async () => { store.set({ draft: draftText }); await sleep(40); });
	const kdQuote = key('keydown', 'Space');
	await act(async () => { await sleep(400); key('keyup', 'Space'); await sleep(120); });
	check(`draft is only a ${label} → Space records`, kdQuote.defaultPrevented === true && mic.started > startedBeforeQuote, `prevented=${kdQuote.defaultPrevented}`);
}
await reset();
await act(async () => { store.set({ draft: '> 引用\n我自己打的字' }); await sleep(40); });
const startedMixed = mic.started;
const kdMixed = key('keydown', 'Space');
await act(async () => { await sleep(60); key('keyup', 'Space'); });
check('quote + typed text → Space is a plain space again', kdMixed.defaultPrevented === false && mic.started === startedMixed, `prevented=${kdMixed.defaultPrevented}`);
await reset();

// ── 9d. dropped file paths are references, not typing ──────────────────────
for (const [label, draftText] of [
	['quoted Windows path', '"F:\\1 工作\\小组培训\\报表.xlsx"'],
	['bare Windows path', 'F:\\1 工作\\报表.xlsx'],
	['forward-slash path', 'F:/1 工作/报表.xlsx'],
	['quoted posix path', '"/home/me/report.docx"'],
	['two dropped paths', '"F:\\a.xlsx"\n"F:\\b.docx"'],
	['path plus quote', '"F:\\a.xlsx"\n> 引用一段'],
]) {
	await reset();
	await act(async () => { store.set({ draft: draftText }); await sleep(40); });
	const kdPath = key('keydown', 'Space');
	await act(async () => { await sleep(400); key('keyup', 'Space'); await sleep(120); });
	check(`${label} → Space records`, kdPath.defaultPrevented === true, `prevented=${kdPath.defaultPrevented} draft=${JSON.stringify(draftText)}`);
}

// A path followed by prose is prose: the user typed something next to it.
await reset();
await act(async () => { store.set({ draft: '"F:\\a.xlsx" 帮我分析这个' }); await sleep(40); });
const startedPathProse = mic.started;
const kdPathProse = key('keydown', 'Space');
await act(async () => { await sleep(60); key('keyup', 'Space'); });
check('dropped path + typed prose → Space is a plain space', kdPathProse.defaultPrevented === false && mic.started === startedPathProse, `prevented=${kdPathProse.defaultPrevented}`);
await reset();

// ── 10. mic permission denied → toast, no throw ─────────────────────────────
await reset(); mic.permission = 'denied'; const startedBefore = mic.started;
await act(async () => { key('keydown', 'Space'); await sleep(400); key('keyup', 'Space'); await sleep(30); });
check('permission denied → idle + toast', state() === 'idle' && (document.querySelector('.dsh-vptt-toast')?.textContent ?? '').includes('麦克风权限'), document.querySelector('.dsh-vptt-toast')?.textContent);
mic.permission = 'granted';

// ── 11. input locked (submitting) → Space ignored ──────────────────────────
await reset(); const startedBefore11 = mic.started;
await act(async () => { store.set({ phase: 'submitting' }); await sleep(10); });
const kd3 = key('keydown', 'Space');
await act(async () => { await sleep(10); key('keyup', 'Space'); });
check('phase=submitting → Space ignored', kd3.defaultPrevented === false && mic.started === startedBefore11, `prevented=${kd3.defaultPrevented} started=${mic.started}`);
await act(async () => { store.set({ phase: 'plain' }); await sleep(10); });

// ── 11b. the dot mirrors the official microphone's recording state ──────────
await reset();
const official = document.createElement('div');
official.setAttribute('data-voice-activity', 'recording');
document.body.appendChild(official);
await act(async () => { await sleep(600); });
check('official mic recording → our dot turns green (state=recording)', state() === 'recording', `state=${state()}`);
official.setAttribute('data-voice-activity', 'idle');
await act(async () => { await sleep(600); });
check('official mic idle → our dot returns to idle', state() === 'idle', `state=${state()}`);
official.remove();
await act(async () => { await sleep(600); });

// ── 12. unmount cleans up the document listeners ────────────────────────────
await act(async () => { root.unmount(); });
const kd4 = key('keydown', 'Space');
check('after unmount → Space no longer handled', kd4.defaultPrevented === false);
for (const d of effects) { try { await d(); } catch { /* ignore */ } }

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
