// Standalone regression test for inline tag DELETION spacing safety.
//
// Run:  node test/strip-inline-tags.test.mjs
//
// This file deliberately mirrors the relevant logic from main.ts so it can run
// without the Obsidian runtime:
//   - getCodeBlockRanges / isInCodeBlockRange  (code-block protection)
//   - the tag regex built in deleteTags()
//   - stripInlineTags()                        (the safety-critical rewrite)
// If you change any of those in main.ts, mirror the change here.
//
// The bug it guards against (reported by kevinmorrisnet / codeshell): after
// deleting a tag, the plugin ran `body.replace(/ {2,}/g, ' ')` over the whole
// note, collapsing ALL multi-space runs — flattening YAML, nested lists, and
// any indented content. The fix removes only the tag and one adjacent space.

// The parser helpers below are imported from the real module rather than mirrored,
// so they cannot drift. Only the stripInlineTags path is still copied, because it
// lives on the plugin class and needs the Obsidian runtime to import directly.
import { fixFrontmatterMapping, isTagListComment, parseCsvRenamePairs, parseTagDeleteList } from '../tag-text.mjs';

// ---- mirrored from main.ts -------------------------------------------------

function getCodeBlockRanges(content) {
    const regex = /```[\s\S]*?```|`[^`\n]+`/g;
    const ranges = [];
    let m;
    while ((m = regex.exec(content)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length });
    }
    return ranges;
}

function isInCodeBlockRange(offset, ranges) {
    for (const range of ranges) {
        if (offset >= range.start && offset < range.end) return true;
    }
    return false;
}

function buildTagRegex(deletableTags) {
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patternParts = deletableTags.map((t) => `(?:${escapeRegExp(t)}(?:\\/[\\p{L}\\p{N}_\\-]+)*)`);
    const combinedPattern = patternParts.join('|');
    return new RegExp(`(^|\\s)(#)(${combinedPattern})(?=[\\s]|$|[^\\p{L}\\p{N}_-])`, 'gu');
}

function stripInlineTags(data, tagRegex, shouldSkip) {
    tagRegex.lastIndex = 0;
    const removals = [];
    let m;
    while ((m = tagRegex.exec(data)) !== null) {
        if (m[0].length === 0) {
            tagRegex.lastIndex++;
            continue;
        }
        const prefixLen = m[1] ? m[1].length : 0;
        const hashOffset = m.index + prefixLen;
        const tagEnd = m.index + m[0].length;
        if (shouldSkip(hashOffset)) continue;
        removals.push({ start: hashOffset, end: tagEnd });
    }
    if (removals.length === 0) return { result: data, modified: false };

    let result = '';
    let cursor = 0;
    for (const { start, end } of removals) {
        result += data.slice(cursor, start);
        const lastNl = Math.max(result.lastIndexOf('\n'), result.lastIndexOf('\r'));
        const tagIsFirstOnLine = result.slice(lastNl + 1).trim().length === 0;
        let next = end;
        if (tagIsFirstOnLine) {
            const c = data.charAt(next);
            if (c === ' ' || c === '\t') next++;
        } else {
            const last = result.charAt(result.length - 1);
            if (last === ' ' || last === '\t') result = result.slice(0, -1);
        }
        cursor = next;
    }
    result += data.slice(cursor);
    return { result, modified: true };
}

// Mirrors the deleteTags() body path: skip frontmatter + code blocks.
function deleteTagsInText(data, tags) {
    const tagRegex = buildTagRegex(tags);
    const codeBlockRanges = getCodeBlockRanges(data);
    const fmMatch = data.match(/^---\n[\s\S]*?\n---/);
    const skipStart = fmMatch ? fmMatch[0].length : 0;
    return stripInlineTags(
        data,
        tagRegex,
        (hashOffset) => hashOffset < skipStart || isInCodeBlockRange(hashOffset, codeBlockRanges)
    ).result;
}

// ---- tiny test runner ------------------------------------------------------

let passed = 0;
let failed = 0;
const show = (s) => JSON.stringify(s);

function eq(name, actual, expected) {
    if (actual === expected) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error(`       expected ${show(expected)}`);
        console.error(`       actual   ${show(actual)}`);
    }
}

// ---- the cases -------------------------------------------------------------

console.log('inline-tag deletion spacing');

// Single inline tag between words -> exactly one space, no double space.
eq('between words', deleteTagsInText('a #foo b', ['foo']), 'a b');
// Tag at end of line -> preceding space removed, newline preserved.
eq('end of line', deleteTagsInText('foo #foo\nbar', ['foo']), 'foo\nbar');
// Tag at start of (un-indented) line -> following space removed, no leading gap.
eq('line start no indent', deleteTagsInText('#foo rest of line', ['foo']), 'rest of line');
// Consecutive tags collapse cleanly.
eq('consecutive tags', deleteTagsInText('text #foo #bar end', ['foo', 'bar']), 'text end');
// Non-targeted tags are untouched.
eq('keeps other tags', deleteTagsInText('#keep #drop here', ['drop']), '#keep here');
// Child tags are removed when the parent is targeted.
eq('child tag', deleteTagsInText('note #foo/child x', ['foo']), 'note x');
// No matching tag -> byte-for-byte identical.
eq('no-op', deleteTagsInText('plain   text with   spaces', ['foo']), 'plain   text with   spaces');

console.log('structure preservation (the reported bug)');

// Indented first-token tag keeps its indentation.
eq('indented first token', deleteTagsInText('parent\n    #foo value', ['foo']), 'parent\n    value');
// A tag on its own line must NOT merge the surrounding lines.
eq('own line keeps newlines', deleteTagsInText('above\n#foo\nbelow', ['foo']), 'above\n\nbelow');
// Unrelated multi-space runs elsewhere in the body must survive untouched.
eq(
    'preserves unrelated double spaces',
    deleteTagsInText('drop #foo here\nkey:    value\n- a\n    - nested', ['foo']),
    'drop here\nkey:    value\n- a\n    - nested'
);

// The headline scenario: frontmatter + inline tag + an indented YAML code block.
// After deleting the tag, the fenced block must be byte-for-byte identical.
const yamlNote = [
    '---',
    'tags: [foo]',
    '---',
    '',
    'Some prose with an inline #foo tag.',
    '',
    '```yaml',
    'containers:',
    '  - name: app',
    '    image: nginx',
    '    env:',
    '      - name: PORT',
    '        value: "8080"',
    '    resources:',
    '      limits:',
    '        cpu: "500m"',
    '    volumeMounts:',
    '      - mountPath: /data',
    '```',
    ''
].join('\n');

const out = deleteTagsInText(yamlNote, ['foo']);
const codeBlock = (s) => s.slice(s.indexOf('```yaml'), s.indexOf('```\n', s.indexOf('```yaml') + 1) + 3);
eq('yaml code block untouched', codeBlock(out), codeBlock(yamlNote));
eq('inline tag removed from prose', /Some prose with an inline tag\./.test(out), true);
eq('frontmatter region untouched', out.startsWith('---\ntags: [foo]\n---\n'), true);

// ---- tag list / CSV parsing -------------------------------------------------

const eqJson = (name, actual, expected) => eq(name, JSON.stringify(actual), JSON.stringify(expected));

console.log('comment detection');

eq('hash-space is a comment', isTagListComment('# a note to self'), true);
eq('double hash is a comment', isTagListComment('##disabled'), true);
eq('slash-slash is a comment', isTagListComment('// disabled'), true);
eq('a plain tag is not a comment', isTagListComment('#project/old'), false);

console.log('delete-list parsing');

// The bug: "#" was stripped before the comment test ran, so "# comment" survived as a
// tag literally named " comment".
eqJson('hash comments are dropped', parseTagDeleteList('# tags to remove\n#project/old\nstatus/wip'), [
    'project/old',
    'status/wip'
]);
eqJson('slash comments are dropped', parseTagDeleteList('// disabled\n#keep'), ['keep']);
eqJson('blank lines are dropped', parseTagDeleteList('\n\n#a\n   \n#b\n'), ['a', 'b']);
eqJson('a bare hash yields nothing', parseTagDeleteList('#'), []);
eqJson('crlf input', parseTagDeleteList('#a\r\n#b'), ['a', 'b']);

console.log('csv rename parsing');

// The bug: every line beginning with "#" was discarded as a comment, so a CSV written
// in Obsidian's own tag syntax silently parsed to zero pairs.
eqJson('hash-prefixed pairs are kept', parseCsvRenamePairs('#old,#new'), [{ from: 'old', to: 'new' }]);
eqJson('bare pairs are kept', parseCsvRenamePairs('old,new'), [{ from: 'old', to: 'new' }]);
eqJson('header row is skipped', parseCsvRenamePairs('old_tag,new_tag\n#a,#b'), [{ from: 'a', to: 'b' }]);
eqJson('comments are still dropped', parseCsvRenamePairs('# mapping file\n#a,#b'), [{ from: 'a', to: 'b' }]);
eqJson('incomplete rows are dropped', parseCsvRenamePairs('a,\n,b\nnocomma\n#a,#b'), [{ from: 'a', to: 'b' }]);

console.log('frontmatter mapping repair');

eq(
    'quotes an unquoted colon value',
    fixFrontmatterMapping('---\nResumen: algo: importante\n---\nbody'),
    '---\nResumen: "algo: importante"\n---\nbody'
);
// The bug: \w is ASCII-only, so accented keys were never matched.
eq(
    'handles non-ascii keys',
    fixFrontmatterMapping('---\nTítulo: algo: importante\n---\nbody'),
    '---\nTítulo: "algo: importante"\n---\nbody'
);
// The bug: indexOf('---\n') never matched a CRLF document, so it silently no-opped.
eq(
    'handles crlf documents',
    fixFrontmatterMapping('---\r\nResumen: algo: importante\r\n---\r\nbody'),
    '---\r\nResumen: "algo: importante"\r\n---\r\nbody'
);
eq('leaves already-quoted values alone', fixFrontmatterMapping('---\nkey: "a: b"\n---\n'), null);
eq('leaves valid frontmatter alone', fixFrontmatterMapping('---\ntags: [a, b]\n---\n'), null);
eq('returns null without frontmatter', fixFrontmatterMapping('no frontmatter: here at all\n'), null);
eq(
    'body containing --- is preserved',
    fixFrontmatterMapping('---\nResumen: algo: importante\n---\n\ntext\n\n---\n\nmore text\n'),
    '---\nResumen: "algo: importante"\n---\n\ntext\n\n---\n\nmore text\n'
);
eq(
    'escapes embedded double quotes',
    fixFrontmatterMapping('---\nk: say "hi": now\n---\n'),
    '---\nk: "say \\"hi\\": now"\n---\n'
);

// ---- summary ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
