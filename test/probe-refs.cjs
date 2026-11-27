/**
 * Probe the real `draftIsOnlyReferences` from lib/client.js against the shapes a
 * dropped file can actually produce. Extracted at runtime so this test can never
 * drift from the shipped implementation.
 *
 * Run: node test/probe-refs.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

const quoted = source.match(/const REFERENCE_QUOTED_PATH = .*?;/)[0];
const bare = source.match(/const REFERENCE_BARE_PATH = .*?;/s)[0];
const loneAt = source.match(/const LONE_AT = .*?;/s)[0];
const start = source.indexOf('const draftIsOnlyReferences');
const end = source.indexOf('\n\t\t};', start) + 5;
const body = source.slice(start, end);

const draftIsOnlyReferences = new Function(`${quoted}\n${bare}\n${loneAt}\n${body}\nreturn draftIsOnlyReferences;`)();

/** [label, draft, expectedIsReferenceOnly] */
const cases = [
	['quote only', '> 引用一段', true],
	['quoted path (spaces)', '"F:\\1 工作\\小组培训\\报表.xlsx"', true],
	['bare path (spaces)', 'F:\\1 工作\\小组培训\\报表.xlsx', true],
	['two quoted paths', '"F:\\a.xlsx"\n"F:\\b.docx"', true],
	['two bare paths', 'F:\\a.xlsx\nF:\\b.docx', true],
	['trailing newline', '"F:\\a.xlsx"\n', true],
	['parentheses in path', '"F:\\1 工作\\审计(2026)\\报告.docx"', true],
	['hash in path', '"F:\\1 工作\\#草稿\\a.xlsx"', true],
	['brackets in path', '"F:\\1 工作\\[旧]\\a.xlsx"', true],
	['posix path', '"/Users/me/报表.xlsx"', true],
	['two paths same line', '"F:\\a.xlsx" "F:\\b.xlsx"', true],
	['path plus quote', '"F:\\a.xlsx"\n> 引用', true],
	['typed text', '我打的一段话', false],
	['path plus typed text', '"F:\\a.xlsx" 帮我分析', false],
	['quote plus typed text', '> 引用\n我自己写的', false],
	// The exact draft observed on the real machine (2026-11-27 22:34): the editor
	// stores a dropped file as `@"…"`, not a bare quoted path.
	['real @-quoted path', '@"F:\\1 工作\\2627财年\\豪能股份\\豪能2026预审+年审时间安排表.xlsx" ', true],
	['two @-quoted paths', '@"F:\\a.xlsx"\n@"F:\\b.docx"', true],
	['@-path then typed text', '@"F:\\a.xlsx" 帮我看看这个表', false],
];

let failed = 0;
for (const [label, draft, expected] of cases) {
	let got;
	try { got = draftIsOnlyReferences(draft); } catch (error) { got = `ERR:${error.message}`; }
	const ok = got === expected;
	if (!ok) failed += 1;
	const shown = got === true ? 'reference-only (Space records)' : got === false ? 'typed (Space types)' : got;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(24)} → ${shown}`);
}

console.log(`\n${cases.length - failed}/${cases.length} shape checks passed`);
process.exit(failed === 0 ? 0 : 1);
