/**
 * Browser half of @wccong1213/dsh-voice-ptt (按住空格说话).
 *
 * One compact indicator in `conversation.input.right` plus a document-level
 * key handler. The whole flow lives in the browser:
 *
 *   hold Space (composer focused)  → start microphone capture
 *   release Space                  → stop, transcribe through the official
 *                                    speech Remote (local SenseVoice), clean
 *                                    filler words, then `inputActions.submit()`
 *   Esc                            → cancel, nothing is inserted or sent
 *
 * What this plugin does NOT do:
 *   - it never ships a recognizer of its own (the official bundle owns it);
 *   - it never touches the official microphone button (`conversation.input.activity`
 *     is a single-occupant slot and stays with the official UI);
 *   - it never sends audio anywhere but the Host's speech Remote.
 *
 * Settings (persisted in localStorage, so they survive restarts):
 *   autoSend      true   — submit after a successful transcription
 *   fillerCleanup true   — drop 嗯/呃/那个/就是说… from the transcript
 *   spaceEnabled   true   — the Space hotkey master switch
 */
window.__ModuleLoader__.load({
	id: '@wccong1213/dsh-voice-ptt',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;

		const VERSION = '0.1.0';
		/** A hold shorter than this never carried speech; release cancels silently. */
		const MIN_HOLD_MS = 350;
		const STORAGE_KEY = 'dsh-voice-ptt.settings.v1';
		const DEFAULTS = { autoSend: true, fillerCleanup: true, spaceEnabled: true };

		const DICTS = {
			'zh-CN': {
				ready: '空格说话',
				recording: '录音中…松开发送',
				transcribing: '识别中…',
				cancelling: '已取消',
				empty: '没听清，再试一次',
				failed: '识别失败',
				noSpeech: '语音识别未就绪，请先在插件页启用「语音输入」',
				sent: '已发送',
				inserted: '已插入（自动发送已关）',
				titleReady: '按住空格说话，松开自动发送；Esc 取消',
				titleRecording: '正在录音，松开空格发送，Esc 取消',
				titleOff: '空格语音已关闭，点击开启',
				titleNoSpeech: '官方语音输入 Bundle 未就绪',
			},
			en: {
				ready: 'Hold Space',
				recording: 'Recording… release to send',
				transcribing: 'Transcribing…',
				cancelling: 'Cancelled',
				empty: 'Nothing heard — try again',
				failed: 'Transcription failed',
				noSpeech: 'Speech not ready — enable the Voice input bundle first',
				sent: 'Sent',
				inserted: 'Inserted (auto-send off)',
				titleReady: 'Hold Space to talk, release to send; Esc cancels',
				titleRecording: 'Recording — release Space to send, Esc to cancel',
				titleOff: 'Space hotkey off — click to enable',
				titleNoSpeech: 'Official voice-input bundle is not ready',
			},
		};

		// ── settings ───────────────────────────────────────────────────────────
		const loadSettings = () => {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw === null) return { ...DEFAULTS };
				const parsed = JSON.parse(raw);
				return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
			} catch {
				return { ...DEFAULTS };
			}
		};
		const saveSettings = (settings) => {
			try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
		};

		// ── transcript cleanup ─────────────────────────────────────────────────
		/**
		 * Drop spoken filler tokens while keeping the words around them.
		 *
		 * Chinese has no word boundaries, so a filler glued to the next word
		 * (`那个报表`) cannot be told apart from a word that contains it
		 * (`那个人`) by pattern alone. Two tiers:
		 *   - `AMBIGUOUS` (那个/这个/然后): removed ONLY when they stand alone
		 *     between boundaries. Eating `那个人` would corrupt the sentence, so
		 *     one leftover `那个` is the cheaper error.
		 *   - `PURE` (嗯/呃/就是说/对对对…): never part of a real word, so a
		 *     leading boundary is enough.
		 */
		const AMBIGUOUS = '那个|这个|然后';
		const PURE = '嗯|呃|额|啊|哦|哎|就是说|然后呢|这个这个|对对对|那个那个';
		const FILLER_AMBIGUOUS = new RegExp(`(^|[\\s，。！？、；：,.!?;:])(${AMBIGUOUS})(?=$|[\\s，。！？、；：,.!?;:])`, 'g');
		const FILLER_PURE = new RegExp(`(^|[\\s，。！？、；：,.!?;:])(${PURE})(?=$|[\\s，。！？、；：,.!?;:]|[^\\s，。！？、；：,.!?;:])`, 'g');
		const cleanTranscript = (text, enabled) => {
			let out = typeof text === 'string' ? text.trim() : '';
			if (out === '') return '';
			if (enabled) {
				out = out.replace(FILLER_PURE, '$1');
				out = out.replace(FILLER_AMBIGUOUS, '$1');
				out = out.replace(/^[\s，。]+|[\s，。]+$/g, '');
				// SenseVoice separates Chinese tokens with spaces the user never
				// spoke; close a gap only when BOTH sides are CJK characters, so
				// `报表 不对` → `报表不对` while `GPT 模型` and `好 ，` stay intact.
				out = out.replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g, '$1');
				out = out.replace(/([\s，。])\1+/g, '$1');
				out = out.replace(/\s+([，。！？、；：,.!?;:])|([，。！？、；：,.!?;:])\s+/g, '$1$2');
			}
			return out;
		};

		// ── audio capture (mirrors the official Recording, trimmed) ───────────
		const encodeWave = (samples) => {
			const bytes = new Uint8Array(44 + samples.length * 2);
			const view = new DataView(bytes.buffer);
			const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
			text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
			view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
			view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
			view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data');
			view.setUint32(40, samples.length * 2, true);
			for (const [i, sample] of samples.entries()) {
				const value = Math.max(-1, Math.min(1, sample));
				view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
			}
			return bytes;
		};
		const audioBase64 = (bytes) => {
			let out = '';
			for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
			return btoa(out);
		};

		class CaptureError extends Error {
			constructor(kind) { super(kind); this.name = 'CaptureError'; this.kind = kind; }
		}

		/** One microphone acquisition that resamples to 16 kHz mono PCM16 WAV. */
		class Capture {
			constructor(onDispose) {
				this.onDispose = onDispose;
				this.stream = undefined; this.recorder = undefined; this.context = undefined;
				this.chunks = []; this.disposal = undefined; this.aborted = false;
			}
			async start() {
				const devices = navigator.mediaDevices;
				if (!devices) throw new CaptureError('unavailable');
				let stream;
				try {
					stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
				} catch (error) {
					if (error instanceof DOMException) {
						if (error.name === 'NotAllowedError') throw new CaptureError('permission');
						if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') throw new CaptureError('deviceMissing');
					}
					throw error;
				}
				if (this.aborted) { stream.getTracks().forEach((t) => t.stop()); throw new CaptureError('cancelled'); }
				this.stream = stream;
				try {
					this.context = new AudioContext();
					this.recorder = new MediaRecorder(stream);
					this.recorder.ondataavailable = (event) => { if (!this.aborted && event.data.size > 0) this.chunks.push(event.data); };
					this.recorder.start();
				} catch (error) { await this.dispose(); throw error; }
			}
			/** Milliseconds of audio captured so far, for the minimum-length guard. */
			durationMs() {
				return this.recorder && this.recorder.state === 'recording' ? Date.now() - this.startedAt : 0;
			}
			async stop(maxDurationSeconds) {
				const recorder = this.recorder; const context = this.context;
				if (!recorder || !context || recorder.state !== 'recording') { await this.dispose(); throw new CaptureError('empty'); }
				try {
					await new Promise((resolve, reject) => {
						recorder.onstop = () => resolve();
						recorder.onerror = () => reject(new CaptureError('empty'));
						recorder.stop();
					});
					this.stream.getTracks().forEach((t) => t.stop());
					const blob = new Blob(this.chunks, { type: recorder.mimeType });
					if (blob.size === 0) throw new CaptureError('empty');
					const decoded = await context.decodeAudioData(await blob.arrayBuffer());
					const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16000)), 16000);
					const source = offline.createBufferSource();
					source.buffer = decoded; source.connect(offline.destination); source.start();
					const resampled = await offline.startRendering();
					return encodeWave(resampled.getChannelData(0));
				} finally { await this.dispose(); }
			}
			dispose() {
				if (!this.disposal) {
					const closing = Promise.withResolvers();
					this.disposal = closing.promise;
					this.release().then(closing.resolve, closing.reject);
				}
				return this.disposal;
			}
			async release() {
				this.aborted = true;
				if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
				this.stream?.getTracks().forEach((t) => t.stop());
				this.stream = undefined;
				const context = this.context; this.context = undefined; this.chunks = [];
				try { if (context && context.state !== 'closed') await context.close(); } finally { this.onDispose(); }
			}
		}

		// ── speech readiness (mirrors the official observeReadiness) ─────────
		/**
		 * Track recognizer readiness through the Host route.
		 *
		 * The browser Remote namespace (`ctx.remote.speech`) is NOT used: it is
		 * mounted by the official voice-input UI, which depends on
		 * `ctx.remote.$stream()` — an API that throws on Desktop. Waiting for that
		 * namespace never completes. The Host half owns recognition
		 * (`speechToText`) and answers `/status` + `/transcribe` directly.
		 */
		const createStatus = () => {
			const listeners = new Set();
			let state = { connected: false, ready: false, error: null, providers: [], selection: null, checkedAt: 0 };
			const set = (next) => {
				const changed = next.ready !== state.ready || next.error !== state.error;
				state = next;
				for (const l of listeners) l();
				return changed;
			};
			let disposed = false;
			const poll = async () => {
				try {
					const response = await fetch('/dsh-voice-ptt/status', { headers: { accept: 'application/json' } });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const body = await response.json();
					if (disposed) return;
					if (body?.ok !== true) throw new Error(body?.message ?? 'status failed');
					const providers = Array.isArray(body.host?.providers) ? body.host.providers : [];
					const selection = body.host?.snapshot?.selection ?? null;
					const chosen = providers.find((p) => p.id === selection?.providerId) ?? providers[0] ?? null;
					// A registered provider with no preparation phase is the local
					// SenseVoice one; it loads its model on first use, so "present" is
					// enough to enable the button.
					const prep = chosen?.preparation;
					const phase = prep?.phase;
					const ready = providers.length > 0 && (phase === undefined || phase === 'ready' || phase === 'standby' || phase === 'waking');
					set({
						connected: true,
						ready,
						error: ready ? null : (prep?.message ?? (providers.length === 0 ? 'no speech provider' : `provider ${chosen?.id} is ${phase}`)),
						providers,
						selection,
						checkedAt: Date.now(),
					});
				} catch (error) {
					if (!disposed) set({ ...state, connected: false, ready: false, error: error instanceof Error ? error.message : String(error), checkedAt: Date.now() });
				}
			};
			return {
				get: () => state,
				refresh: () => { void poll(); },
				subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
				dispose: () => { disposed = true; listeners.clear(); },
			};
		};

		const STYLE = `
.dsh-vptt-root{position:relative;display:inline-flex;align-items:center;height:28px}
/* The composer tool row is [ .standardControls(input.right + model) | .activity(official mic) | send ].
   Slots cannot move across that boundary, so this control is lifted out of
   input.right and parked where the official microphone used to be — right before
   the send action, after the model selector. -34px clears the model selector's
   own trailing gap; the fallback keeps it inline if the row changes shape. */
.dsh-vptt-anchored{position:absolute;right:0;top:0}
.dsh-vptt-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;
  border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;transition:color .15s ease,opacity .15s ease,background .15s ease}
.dsh-vptt-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-vptt-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-vptt-btn:disabled{cursor:default;opacity:.45}
/* Green while speech is being captured — by this plugin or by the official mic. */
.dsh-vptt-btn[data-state="recording"]{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-vptt-btn[data-state="transcribing"]{color:var(--dsw-alias-brand-primary)}
.dsh-vptt-btn[data-state="off"]{opacity:.4}
.dsh-vptt-btn[data-state="recording"] .dsh-vptt-mic{animation:dsh-vptt-pulse 1.1s ease-in-out infinite}
.dsh-vptt-btn[data-state="transcribing"] .dsh-vptt-mic{animation:dsh-vptt-pulse .6s ease-in-out infinite}
@keyframes dsh-vptt-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.86)}}
/* One-shot blink instead of a popup: 'empty' = nothing heard, 'error' = failed. */
.dsh-vptt-btn[data-flash="empty"]{animation:dsh-vptt-blink .7s ease-out 1;color:var(--dsw-alias-label-tertiary)}
.dsh-vptt-btn[data-flash="error"]{animation:dsh-vptt-blink .7s ease-out 1;color:var(--dsw-alias-state-error-primary)}
@keyframes dsh-vptt-blink{0%{opacity:1;transform:scale(1)}25%{opacity:.25;transform:scale(.8)}60%{opacity:.7;transform:scale(1.06)}100%{opacity:1;transform:scale(1)}}
/* Hide the official microphone button: this plugin replaces it. Only THAT one
   button is hidden (matched by its own aria-label), and only while enabled, so
   the official recording row it swaps in stays untouched. */
.dsh-vptt-hide-official [aria-label="开始录音"],
.dsh-vptt-hide-official [aria-label="Start recording"]{display:none !important}
.dsh-vptt-toast{position:fixed;z-index:60;max-width:300px;padding:8px 10px;border-radius:10px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);box-shadow:0 6px 20px rgba(0,0,0,.18);
  font-size:13px;line-height:1.4;cursor:pointer}
.dsh-vptt-toast[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary)}
.dsh-vptt-toast[data-tone="ok"]{border-color:var(--dsw-alias-state-success-primary)}`;

		/**
		 * Decide whether the composer holds text the user typed by hand.
		 *
		 * Dropped references are NOT typing. Two shapes land in the draft:
		 *   - quotes, as Markdown blockquote lines (`> …`);
		 *   - dropped file paths, bare or double-quoted
		 *     (`"F:\dir\报表.xlsx"`, `F:/dir/report.docx`).
		 * Holding Space next to either should still start dictation. Anything
		 * else counts as typed text, and typing keeps priority.
		 * @param draft - composer draft projection.
		 * @returns true when nothing but quotes/quote paths/whitespace remains.
		 */
		const REFERENCE_QUOTED_PATH = /"[^"\n]*"/g;
		/**
		 * A bare path runs to the end of its line. A path containing spaces is
		 * quoted by the dropper, so the unquoted form never needs to stop at a
		 * space — matching only up to the first space would leave the tail
		 * (`工作\报表.xlsx`) behind and read it as typed prose.
		 */
		const REFERENCE_BARE_PATH = /(?:^|\s)(?:[A-Za-z]:[\\/][^\n]*|[\\/]{2}[^\n]+|\/[^\n]+)/g;
		const draftIsOnlyReferences = (draft) => {
			if (typeof draft !== 'string') return true;
			let rest = draft
				// Quotes wrap in the draft and may span lines, so test each line.
				.split('\n')
				.filter((line) => !/^\s*>/.test(line))
				.join('\n')
				// A dropped path is reference, not prose.
				.replace(REFERENCE_QUOTED_PATH, '')
				.replace(REFERENCE_BARE_PATH, ' ')
				// Invisible editor placeholders are not content.
				.replace(/[\u200b-\u200d\ufeff]/g, '')
				.trim();
			return rest === '';
		};

		const MicIcon = () => h('svg', { className: 'dsh-vptt-mic', viewBox: '0 0 48 48', width: 16, height: 16, 'aria-hidden': true, fill: 'none' },
			h('rect', { x: 19, y: 7, width: 10, height: 20, rx: 5, fill: 'currentColor' }),
			h('path', { d: 'M13 23a11 11 0 0 0 22 0', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' }),
			h('path', { d: 'M24 34v7M17 41h14', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' }));

		const failureText = (error, t) => {
			if (error instanceof CaptureError) {
				if (error.kind === 'permission') return '麦克风权限被拒绝';
				if (error.kind === 'deviceMissing') return '没有可用的麦克风';
				if (error.kind === 'unavailable') return '浏览器不支持录音';
				if (error.kind === 'empty') return t('empty');
			}
			return error?.message ? `${t('failed')}：${error.message}` : t('failed');
		};

		return {
			// slots registers the composer control. Recognition goes through the Host route
			// (/dsh-voice-ptt/transcribe), so no Remote namespace is required — the
			// browser Remote cannot be used on Desktop anyway ($stream throws there).
			inject: ['slots'],
			apply(ctx) {
				// Mount ping FIRST: the Host counter is the only evidence on Desktop
				// that the module was served and applied, and it must survive any
				// later setup failure.
				const ping = (phase) => {
					try {
						fetch('/dsh-voice-ptt/alive', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ version: VERSION, appliedAt: Date.now(), phase }),
						}).catch(() => {});
					} catch { /* diagnostics never break the plugin */ }
				};
				ping('apply');

				// ── locale (optional; failures keep the built-in text) ──
				/**
				 * UI text is Chinese on purpose, not locale-driven.
				 *
				 * The dictionaries are still registered so a future locale switch can
				 * find them, but the label is fixed: this plugin is built for one user
				 * who reads Chinese, and a half-bound locale (which showed English on an
				 * otherwise Chinese UI) is worse than a fixed string.
				 */
				const translate = (key) => DICTS['zh-CN'][key] ?? key;
				try {
					const locale = ctx.get('locale');
					if (locale && typeof locale.register === 'function') {
						for (const [id, dict] of Object.entries(DICTS)) {
							try { locale.register('dsh-voice-ptt', id, dict); } catch { /* first owner wins */ }
						}
					}
				} catch { /* locale is optional */ }

				// ── recognizer status (HTTP, no Remote namespace) ──
				const recognizer = createStatus();
				const readinessListeners = new Set();
				let lastReported = '';
				const reportReadiness = () => {
					const live = recognizer.get();
					const stamp = `${live.connected}|${live.ready}|${live.error ?? ''}|${live.providers.map((p) => p.id).join(',')}`;
					if (stamp === lastReported) return;
					lastReported = stamp;
					try {
						fetch('/dsh-voice-ptt/alive', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								version: `${VERSION}|${JSON.stringify({ c: live.connected ? 1 : 0, r: live.ready ? 1 : 0, e: live.error, pv: live.providers.map((p) => p.id), sel: live.selection })}`,
								phase: 'readiness',
								readiness: { connected: live.connected, ready: live.ready, error: live.error, providers: live.providers.map((p) => p.id), selection: live.selection },
							}),
						}).catch(() => {});
					} catch { /* diagnostics only */ }
				};
				recognizer.subscribe(() => { reportReadiness(); for (const l of readinessListeners) l(); });
				/**
				 * Take over the official microphone button's slot visually.
				 *
				 * The official control is hidden with a scoped class on <body> (see STYLE).
				 * The class is removed whenever recognition is not usable, so the official
				 * setup entry ("前往安装") is never hidden — on a fresh machine that entry is
				 * the only way to download the model.
				 */
				let officialHidden = false;
				const syncOfficialVisibility = () => {
					const usable = recognizer.get().ready;
					if (usable === officialHidden) return;
					officialHidden = usable;
					try { document.body.classList.toggle('dsh-vptt-hide-official', usable); } catch { /* no body yet */ }
				};
				recognizer.subscribe(syncOfficialVisibility);
				setTimeout(syncOfficialVisibility, 0);
				ctx.effect(() => () => {
					try { document.body.classList.remove('dsh-vptt-hide-official'); } catch { /* gone */ }
				});
				// Poll once now and every 2 s for the first minute, then every 10 s —
				// the recognizer can be (un)prepared by the official UI at any time.
				recognizer.refresh();
				let fastTicks = 0;
				let slowTimer = null;
				const pollTimer = setInterval(() => {
					recognizer.refresh();
					if (++fastTicks === 30) { clearInterval(pollTimer); slowTimer = setInterval(() => recognizer.refresh(), 10000); }
				}, 2000);
				ctx.effect(() => () => {
					clearInterval(pollTimer);
					if (slowTimer !== null) clearInterval(slowTimer);
					recognizer.dispose();
				});
				ctx.effect(() => () => { void 0; });

				// ── official microphone mirror ──
				/*
				 * The official voice-input UI renders `[data-voice-activity]` while it
				 * records or transcribes. Watching that attribute lets this plugin's dot
				 * turn green together with the official microphone, so the two controls
				 * read as one indicator instead of two competing ones. Only the attribute
				 * is observed — no element is modified, moved or restyled.
				 */
				let officialActive = false;
				const officialListeners = new Set();
				ctx.effect(() => {
					const read = () => {
						const node = document.querySelector('[data-voice-activity]');
						const value = node?.getAttribute('data-voice-activity') ?? '';
						const active = value === 'recording' || value === 'requesting' || value === 'transcribing';
						if (active === officialActive) return;
						officialActive = active;
						for (const l of officialListeners) l();
					};
					// `MutationObserver` is absent in some test runtimes; polling keeps the
					// mirror working there without blocking anything.
					const Observer = globalThis.MutationObserver;
					if (typeof Observer !== 'function') {
						read();
						const timer = setInterval(read, 400);
						return () => clearInterval(timer);
					}
					const observer = new Observer(read);
					observer.observe(document.body, {
						subtree: true,
						attributes: true,
						attributeFilter: ['data-voice-activity'],
						childList: true,
					});
					read();
					return () => observer.disconnect();
				});

				// ── key handling ──
				/** The active PTT session, shared between the key handler and the indicator. */
				let active = null;
				const listeners = new Set();
				const notify = () => { for (const l of listeners) l(); };
				/** True while this plugin owns the microphone (requesting, recording, transcribing). */
				const capturing = () => active !== null && active.busy();

				const isEditable = (node) => {
					if (!(node instanceof HTMLElement)) return false;
					const tag = node.tagName?.toLowerCase();
					if (tag === 'textarea' || tag === 'input') return true;
					// `isContentEditable` is the browser truth; the attribute check is
					// a fallback for environments that do not implement the property.
					if (node.isContentEditable === true) return true;
					const attr = node.getAttribute?.('contenteditable');
					return attr === '' || attr === 'true' || attr === 'plaintext-only';
				};

				const onKeyDown = (event) => {
					if (event.code !== 'Space') return;
					if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
					if (!isEditable(event.target)) return;
					// While a hold-to-talk session owns the keyboard, EVERY Space —
					// including the OS auto-repeat stream — must be swallowed, or the
					// editor receives one space per repeat tick.
					if (capturing()) {
						event.preventDefault();
						event.stopPropagation();
						return;
					}
					if (event.repeat) return;
					if (!loadSettings().spaceEnabled) return;
					if (!active || !active.canStart()) return;
					event.preventDefault();
					event.stopPropagation();
					if (!active.begin()) return;
					notify();
				};
				const onKeyUp = (event) => {
					if (event.code !== 'Space') return;
					if (!active || !active.finish()) return;
					notify();
				};
				const cancelActive = () => {
					if (!active) return;
					if (active.cancel()) notify();
				};
				const onEscape = (event) => { if (event.key === 'Escape') cancelActive(); };
				const onBlur = () => cancelActive();

				ctx.effect(() => {
					document.addEventListener('keydown', onKeyDown, true);
					document.addEventListener('keyup', onKeyUp, true);
					document.addEventListener('keydown', onEscape);
					window.addEventListener('blur', onBlur);
					return () => {
						document.removeEventListener('keydown', onKeyDown, true);
						document.removeEventListener('keyup', onKeyUp, true);
						document.removeEventListener('keydown', onEscape);
						window.removeEventListener('blur', onBlur);
						cancelActive();
					};
				});

				function VoicePtt(props) {
					const { useInput, inputActions, sessionId } = props;
					const draft = typeof useInput === 'function' ? useInput((s) => s?.draft) : '';
					const phase = typeof useInput === 'function' ? useInput((s) => s?.phase) : 'plain';

					const [settings, setSettings] = React.useState(loadSettings);
					// Settings are read on every key press anyway; keep the UI in sync
					// when they change from elsewhere (another tab, or a remount-free
					// edit) without requiring a page reload.
					React.useEffect(() => {
						const sync = () => setSettings(loadSettings());
						window.addEventListener('storage', sync);
						window.addEventListener('dsh-voice-ptt:settings', sync);
						return () => { window.removeEventListener('storage', sync); window.removeEventListener('dsh-voice-ptt:settings', sync); };
					}, []);
					const updateSettings = React.useCallback((patch) => {
						const next = { ...loadSettings(), ...patch };
						saveSettings(next);
						setSettings(next);
						window.dispatchEvent(new Event('dsh-voice-ptt:settings'));
					}, []);
					const [status, setStatus] = React.useState('idle');
					/**
					 * Transient icon feedback, used instead of a toast for outcomes the user
					 * already sees: 'empty' (nothing heard) blinks grey, 'error' blinks red.
					 * Cleared automatically so it can never stick.
					 */
					const [flash, setFlash] = React.useState('');
					const flashTimer = React.useRef(null);
					const triggerFlash = React.useCallback((kind) => {
						if (flashTimer.current !== null) clearTimeout(flashTimer.current);
						setFlash(kind);
						flashTimer.current = setTimeout(() => { setFlash(''); flashTimer.current = null; }, 700);
					}, []);
					const [message, setMessage] = React.useState('');
					const captureRef = React.useRef(null);
					const generation = React.useRef(0);
					const buttonRef = React.useRef(null);
					const toastNode = React.useRef(null);
					const toastTimer = React.useRef(null);

					const clearToast = React.useCallback(() => {
						if (toastTimer.current !== null) { clearTimeout(toastTimer.current); toastTimer.current = null; }
						const node = toastNode.current; toastNode.current = null;
						if (node !== null) node.remove();
					}, []);
					const showToast = React.useCallback((text, tone) => {
						clearToast();
						const node = document.createElement('div');
						node.className = 'dsh-vptt-toast';
						node.setAttribute('role', 'status');
						node.dataset.tone = tone ?? 'info';
						node.textContent = text;
						node.addEventListener('click', () => clearToast());
						document.body.appendChild(node);
						toastNode.current = node;
						try {
							const rect = buttonRef.current?.getBoundingClientRect?.();
							node.style.right = `${Math.max(12, window.innerWidth - (rect && rect.width > 0 ? rect.right : 36))}px`;
							node.style.bottom = `${Math.max(12, window.innerHeight - (rect && rect.width > 0 ? rect.top : 72) + 8)}px`;
						} catch { node.style.right = '24px'; node.style.bottom = '96px'; }
						toastTimer.current = setTimeout(() => clearToast(), 3500);
					}, [clearToast]);

					const inputMutable = phase !== 'submitting' && phase !== 'adjudicating';
					const canSubmit = typeof inputActions?.submit === 'function' && typeof inputActions?.insertText === 'function';
					// Re-render whenever the Host pushes a new readiness snapshot, and
					// reconcile once on mount: a snapshot that arrived before this
					// component existed would otherwise be lost.
					const [, setReadinessTick] = React.useState(0);
					React.useEffect(() => {
						const listener = () => setReadinessTick((n) => n + 1);
						readinessListeners.add(listener);
						officialListeners.add(listener);
						setReadinessTick((n) => n + 1);
						return () => {
							readinessListeners.delete(listener);
							officialListeners.delete(listener);
						};
					}, []);
					const ready = recognizer.get().ready;

					// Session change retires any in-flight recording.
					React.useEffect(() => {
						generation.current++;
						const cap = captureRef.current; captureRef.current = null;
						if (cap) void cap.dispose().catch(() => {});
						setStatus('idle'); setMessage(''); clearToast();
					}, [sessionId, clearToast]);

					/** Begin a hold-to-talk session. Returns false if not possible right now. */
					const begin = React.useCallback(async (viaPointer = false) => {
						if (!ready || !inputMutable || !canSubmit || captureRef.current) return false;
						if (typeof MediaRecorder === 'undefined') { showToast(translate('noSpeech'), 'error'); return false; }
						const run = ++generation.current;
						const cap = new Capture(() => { if (captureRef.current === cap) captureRef.current = null; });
						cap.byPointer = viaPointer === true;
						captureRef.current = cap;
						setStatus('requesting');
						try {
							await cap.start();
							cap.startedAt = Date.now();
							if (run !== generation.current || captureRef.current !== cap) return false;
							setStatus('recording');
							return true;
						} catch (error) {
							void cap.dispose().catch(() => {});
							if (captureRef.current === cap) captureRef.current = null;
							if (run === generation.current) { setStatus('idle'); showToast(failureText(error, translate), 'error'); }
							return false;
						}
					}, [ready, inputMutable, canSubmit, showToast]);

					/** Release: stop, transcribe, clean, insert, optionally submit. */
					const finish = React.useCallback(async () => {
						const cap = captureRef.current;
						if (!cap) return false;
						if (cap.recorder === undefined || cap.recorder.state !== 'recording') {
							// Still waiting for the mic permission: treat release as cancel.
							return cancel();
						}
						// A hold shorter than MIN_HOLD_MS never carried speech; that guard is
						// for the Space hotkey only. A deliberate two-click session may be
						// short on purpose, so it is never dropped here.
						const held = typeof cap.startedAt === 'number' ? Date.now() - cap.startedAt : 0;
						if (cap.byPointer !== true && held < MIN_HOLD_MS) {
							generation.current++;
							captureRef.current = null;
							setStatus('idle');
							void cap.dispose().catch(() => {});
							return true;
						}
						const run = generation.current;
						captureRef.current = null;
						setStatus('transcribing');
						try {
							const wav = await cap.stop(120);
							if (run !== generation.current) return true;
							const live = recognizer.get();
						const selection = live.selection ?? null;
							const response = await fetch('/dsh-voice-ptt/transcribe', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({
									audioBase64: audioBase64(wav),
									...(selection?.providerId === undefined ? {} : { providerId: selection.providerId }),
									...(selection?.language === undefined ? {} : { language: selection.language }),
								}),
							});
							if (run !== generation.current) return true;
							const result = await response.json().catch(() => ({}));
							if (result?.ok !== true) throw new Error(result?.message ?? `HTTP ${response.status}`);
							const text = cleanTranscript(result.text, loadSettings().fillerCleanup);
							if (text === '') {
								// "Nothing heard" is not worth a popup: blink the icon once.
								setStatus('idle');
								triggerFlash('empty');
								return true;
							}
							const span = inputActions.captureInsertion();
							if (!inputActions.insertText(text, span)) { setStatus('idle'); triggerFlash('error'); return true; }
							const current = loadSettings();
							if (current.autoSend) {
								// No success toast in either mode: the text appearing in the
								// composer (or the message in the chat) IS the confirmation.
								// Toasts are reserved for failures that need the user's eye.
								inputActions.submit();
							}
							setStatus('idle');
							return true;
						} catch (error) {
							if (run === generation.current) { setStatus('idle'); triggerFlash('error'); }
							return true;
						}
					}, [inputActions, showToast]);

					/** Esc / blur: drop the recording without inserting anything. */
					const cancel = React.useCallback(() => {
						const cap = captureRef.current;
						if (!cap) return false;
						generation.current++;
						captureRef.current = null;
						void cap.dispose().catch(() => {});
						setStatus('idle');
						return true;
					}, []);

					// Publish the session handle for the document key handler. Updated on
					// every render so the handler always sees the latest readiness,
					// input phase and callbacks; cleared only on unmount.
					const session = {
						/**
						 * DaBao-style gating, with references exempted: Space starts
						 * dictation while the composer holds nothing but quotes or dropped
						 * file paths. Once the user has typed real text, Space is an
						 * ordinary space again.
						 */
						canStart: () => ready && inputMutable && canSubmit && draftIsOnlyReferences(draft),
						busy: () => captureRef.current !== null || status === 'requesting' || status === 'recording' || status === 'transcribing',
						begin, finish, cancel,
					};
					active = session;
					React.useEffect(() => {
						active = session;
						return () => { if (active === session) active = null; };
					});

					/**
					 * Button = click-to-start, click-again-to-send (two-step, not push-to-hold).
					 *
					 * A hold gesture cannot work here: the browser fires
					 * `pointerdown → pointerup → click`, so a `pointerup` handler that stops
					 * the recording runs BEFORE `click` starts it. Registering both left the
					 * control stuck in "recording" with no way back. Two explicit clicks are
					 * unambiguous and also work for touch.
					 */
					const onButtonClick = () => {
						if (status === 'transcribing') return;
						if (captureRef.current !== null) { void finish(); return; }
						if (!settings.spaceEnabled) { updateSettings({ spaceEnabled: true }); return; }
						void begin(true);
					};

					const state = status === 'recording' || status === 'requesting' ? 'recording'
						: status === 'transcribing' ? 'transcribing'
							: officialActive ? 'recording'
								: !settings.spaceEnabled ? 'off' : 'idle';
					const label = status === 'recording' || status === 'requesting' ? translate('recording')
						: status === 'transcribing' ? translate('transcribing')
							: !ready ? translate('noSpeech')
								: !settings.spaceEnabled ? translate('titleOff') : translate('ready');
					const title = status === 'recording' ? translate('titleRecording')
						: !ready ? translate('titleNoSpeech') : translate('titleReady');

					// A microphone glyph that replaces the official button: one control,
					// green while speech is captured — by this plugin or by the official
					// mic (whose transient recording row is left alone).
					return h(React.Fragment, null,
						h('style', { 'data-plugin-css': 'dsh-voice-ptt' }, STYLE),
						h('span', { className: 'dsh-vptt-root' },
							h('button', {
								ref: buttonRef,
								type: 'button',
								className: 'dsh-vptt-btn',
								'data-dsh-voice-ptt': 'button',
								'data-state': state,
								'data-flash': flash || undefined,
								title,
								'aria-label': title,
								disabled: !ready && status === 'idle',
								onClick: onButtonClick,
							}, MicIcon())));
				}

				// ── composer control ──
				// Registered LAST but guarded: the slot entry is the user-visible
				// deliverable, so a throw here is logged rather than propagated.
				try {
					ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
						name: 'conversation.input.right',
						id: 'voice-ptt',
						// Larger order = further right in the tool row (ascending sort), so
						// this sits last — right before the model selector and send action,
						// which is where the official microphone used to be.
						order: 99,
					}, VoicePtt));
					ping('slot-registered');
				} catch (error) {
					try { console.error('[dsh-voice-ptt] slot registration failed', error); } catch { /* no console */ }
				}
			},
		};
	},
});