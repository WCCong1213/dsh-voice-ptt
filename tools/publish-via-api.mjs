/**
 * Publish the package to GitHub through the REST API.
 *
 * Why not `git push`: on this machine outbound git-over-HTTPS fails with
 * "Recv failure: Connection was reset", while api.github.com works.
 *
 * The Git Data API refuses to create blobs in a repository with no commits
 * ("Git Repository is empty", 409), so the first file goes in through the
 * Contents API — that call creates the initial commit — and every later file is
 * committed on top of it. Sequential on purpose: parallel commits would race on
 * the same branch.
 *
 * Usage: node publish-via-api.mjs <owner/repo> [branch]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
const branch = process.argv[3] ?? 'main';
if (!repo) {
	console.error('usage: node publish-via-api.mjs <owner/repo> [branch]');
	process.exit(2);
}

const cwd = process.cwd();
const API = 'https://api.github.com';

function token() {
	const out = execFileSync('git', ['credential', 'fill'], {
		input: 'protocol=https\nhost=github.com\n\n',
		encoding: 'utf8',
	});
	const line = out.split('\n').find((l) => l.startsWith('password='));
	if (!line) throw new Error('no password in git credential output');
	return line.slice('password='.length).trim();
}
const TOKEN = token();

async function api(method, url, body) {
	const response = await fetch(`${API}${url}`, {
		method,
		headers: {
			authorization: `token ${TOKEN}`,
			accept: 'application/vnd.github+json',
			'user-agent': 'dsh-voice-ptt-publisher',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	let parsed;
	try { parsed = text === '' ? {} : JSON.parse(text); } catch { parsed = { raw: text }; }
	if (!response.ok) {
		const error = new Error(`${method} ${url} → ${response.status} ${text.slice(0, 300)}`);
		error.status = response.status;
		throw error;
	}
	return parsed;
}

/** git decides what belongs in the repository. */
function trackedFiles() {
	const out = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' });
	return out.split('\n').map((s) => s.trim()).filter((s) => s !== '').map((s) => s.replace(/\\/g, '/'));
}

/** Read a file's current sha on the branch, or null when it is not there. */
async function existingSha(file) {
	try {
		const found = await api('GET', `/repos/${repo}/contents/${encodeURI(file)}?ref=${branch}`);
		return found.sha ?? null;
	} catch (error) {
		if (error.status === 404) return null;
		throw error;
	}
}

const files = trackedFiles();
console.log(`tracked files: ${files.length}`);
const message = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd, encoding: 'utf8' }).trim();

let first = true;
for (const file of files) {
	const content = fs.readFileSync(path.join(cwd, file));
	const body = {
		message: first ? message : `chore: add ${file}`,
		content: content.toString('base64'),
		branch,
	};
	const sha = await existingSha(file);
	if (sha !== null) body.sha = sha;
	const result = await api('PUT', `/repos/${repo}/contents/${encodeURI(file)}`, body);
	console.log(`  ${file} → ${result.commit?.sha?.slice(0, 8) ?? 'ok'}${first ? ' (initial commit)' : ''}`);
	first = false;
}

const info = await api('GET', `/repos/${repo}`);
console.log(`\n${info.html_url}`);
console.log(`default branch: ${info.default_branch}`);
