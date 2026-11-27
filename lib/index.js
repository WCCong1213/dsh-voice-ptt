/**
 * Host half of @wccong1213/dsh-voice-ptt.
 *
 * Recognition goes straight to the Host's own `speechToText` service — the same
 * registry the official bundle populates with its local SenseVoice provider.
 * The browser Remote namespace (`ctx.remote.speech`) is deliberately NOT used:
 * it is mounted by the official voice-input UI, which relies on
 * `ctx.remote.$stream()` and therefore cannot work on Desktop, so waiting for
 * that namespace waits forever.
 *
 * Routes (loopback + same-origin / Desktop-origin only):
 *   POST /dsh-voice-ptt/transcribe — base64 PCM16 WAV in, transcript out
 *   GET  /dsh-voice-ptt/status      — providers, readiness, last ping/run
 *   POST /dsh-voice-ptt/alive       — browser mount / readiness telemetry
 */
import { readFileSync } from 'node:fs';

export const inject = ['webServer', 'speechToText'];

const ROUTE_ROOT = '/dsh-voice-ptt';
const CLIENT_ID = '@wccong1213/dsh-voice-ptt';
const DESKTOP_ORIGIN = 'dsh-app://app';
/** A 120 s 16 kHz mono PCM16 WAV is ~3.8 MB; allow the decoded payload plus base64 slack. */
const BODY_MAX_BYTES = 8 * 1024 * 1024;

function versionOf() {
	try {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		return typeof pkg.version === 'string' ? pkg.version : '';
	} catch {
		return '';
	}
}

function header(headers, name) {
	const value = headers[name];
	return typeof value === 'string' ? value : undefined;
}

function isLoopback(hostname) {
	const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
	return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

/** Loopback + same-origin / Desktop-origin trust fence. */
function trustedRequest(req, trustedHosts) {
	const host = header(req.headers, 'host');
	if (host === undefined) return false;
	let parsedHost;
	try { parsedHost = new URL(`http://${host}`); } catch { return false; }
	if (!isLoopback(parsedHost.hostname)) {
		const listed = trustedHosts.some((entry) => {
			try { return new URL(`http://${entry}`).host === parsedHost.host; } catch { return false; }
		});
		if (!listed) return false;
	}
	if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false;
	const origin = header(req.headers, 'origin');
	if (origin === undefined) return true;
	if (origin === DESKTOP_ORIGIN) return true;
	try { return new URL(origin).host === parsedHost.host; } catch { return false; }
}

function sourceTrustedHosts(ctx) {
	for (const entry of ctx.loader?.entries?.() ?? []) {
		if (entry.options.name !== '@deepseek-ai/dsh-client-connection') continue;
		const value = entry.fiber?.config?.trustedHosts;
		if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
	}
	return [];
}

function json(res, status, body, origin) {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	if (typeof origin === 'string' && origin !== '') {
		res.setHeader('access-control-allow-origin', origin);
		res.setHeader('vary', 'origin');
	}
	res.end(JSON.stringify(body));
}

function readJson(req, maxBytes = BODY_MAX_BYTES) {
	return new Promise((resolvePromise, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				const raw = Buffer.concat(chunks).toString('utf8').trim();
				resolvePromise(raw === '' ? {} : JSON.parse(raw));
			} catch { reject(new Error('invalid json')); }
		});
		req.on('error', (cause) => reject(cause));
	});
}

export function apply(ctx, rawConfig = {}) {
	const version = versionOf();
	const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
	const state = {
		lastPing: 0, pingCount: 0, clientVersion: '', phase: '',
		readiness: null, lastRun: null, okCount: 0, failCount: 0, lastRefusal: null,
	};

	/** Human-readable provider roster, so /status alone can explain "not ready". */
	const providerFacts = () => {
		try {
			return ctx.speechToText.listProviders().map((info) => ({
				id: info.id,
				location: info.location,
				languages: info.languages,
				defaultFor: info.id === ctx.speechToText.snapshot()?.selection?.providerId ? true : undefined,
			}));
		} catch (error) {
			return [{ error: error?.message ?? String(error) }];
		}
	};

	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: ROUTE_ROOT,
		handler: async (req, res) => {
			const origin = header(req.headers, 'origin');
			const allowedOrigin = origin === DESKTOP_ORIGIN ? origin : undefined;
			if (!trustedRequest(req, sourceTrustedHosts(ctx))) {
				json(res, 403, { ok: false, code: 'forbidden' }, allowedOrigin);
				return;
			}
			if (req.method === 'OPTIONS') {
				res.statusCode = 204;
				res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
				res.setHeader('access-control-allow-headers', 'content-type');
				if (allowedOrigin !== undefined) res.setHeader('access-control-allow-origin', allowedOrigin);
				res.end();
				return;
			}
			const path = (req.url ?? '/').split('?')[0];
			const action = path.slice(ROUTE_ROOT.length).replace(/\/+$/, '');
			try {
				if (action === '/alive' && req.method === 'POST') {
					const body = await readJson(req, 64 * 1024);
					state.lastPing = Date.now();
					state.pingCount += 1;
					state.clientVersion = typeof body.version === 'string' ? body.version : '';
					state.phase = typeof body.phase === 'string' ? body.phase : '';
					if (body.readiness !== undefined) {
						if (state.phase === 'space-refused') state.lastRefusal = { at: Date.now(), detail: body.readiness };
						else state.readiness = body.readiness;
					}
					json(res, 200, { ok: true, hostVersion: version }, allowedOrigin);
					return;
				}

				if (action === '/status' && req.method === 'GET') {
					json(res, 200, {
						ok: true,
						plugin: CLIENT_ID,
						version,
						hostPid: process.pid,
						host: {
							providers: providerFacts(),
							snapshot: (() => { try { return ctx.speechToText.snapshot(); } catch (error) { return { error: error?.message ?? String(error) }; } })(),
						},
						client: { ...state },
						counts: { ok: state.okCount, fail: state.failCount },
					}, allowedOrigin);
					return;
				}

				if (action === '/transcribe' && req.method === 'POST') {
					const body = await readJson(req);
					const encoded = typeof body.audioBase64 === 'string' ? body.audioBase64 : '';
					if (encoded === '') {
						json(res, 400, { ok: false, code: 'empty_audio' }, allowedOrigin);
						return;
					}
					let audio;
					try {
						audio = Buffer.from(encoded, 'base64');
						if (audio.length < 46 || audio.subarray(0, 4).toString() !== 'RIFF') throw new Error('not a RIFF/WAV payload');
					} catch (error) {
						json(res, 400, { ok: false, code: 'bad_audio', message: error?.message ?? String(error) }, allowedOrigin);
						return;
					}
					const controller = new AbortController();
					const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 60000;
					const timer = setTimeout(() => controller.abort(), timeoutMs);
					if (typeof timer.unref === 'function') timer.unref();
					const startedAt = Date.now();
					try {
						const spec = ctx.speechToText.resolve({
							audio,
							...(typeof body.providerId === 'string' && body.providerId !== '' ? { providerId: body.providerId } : {}),
							...(typeof body.language === 'string' && body.language !== '' ? { language: body.language } : {}),
						});
						const transcript = await ctx.speechToText.transcribe(spec, controller.signal);
						const text = typeof transcript?.text === 'string' ? transcript.text : '';
						state.okCount += 1;
						state.lastRun = { at: Date.now(), ok: true, ms: Date.now() - startedAt, chars: text.length, providerId: spec?.provider?.info?.id ?? null, language: spec?.language ?? null };
						json(res, 200, { ok: true, text, elapsedMs: state.lastRun.ms, providerId: state.lastRun.providerId, language: state.lastRun.language }, allowedOrigin);
					} catch (error) {
						state.failCount += 1;
						const message = error?.message ?? String(error);
						state.lastRun = { at: Date.now(), ok: false, ms: Date.now() - startedAt, message };
						const aborted = controller.signal.aborted;
						json(res, aborted ? 504 : 500, { ok: false, code: aborted ? 'timeout' : 'transcription_failed', message }, allowedOrigin);
					} finally {
						clearTimeout(timer);
					}
					return;
				}

				json(res, 404, { ok: false, code: 'not_found', path }, allowedOrigin);
			} catch (error) {
				json(res, 400, { ok: false, code: 'bad_request', message: error?.message ?? String(error) }, allowedOrigin);
			}
		},
	}), 'voice-ptt: routes');
}
