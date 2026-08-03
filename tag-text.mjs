// Pure text helpers shared by the plugin and its tests.
//
// Nothing in here may import from 'obsidian' or touch the DOM: this module is loaded
// directly by node in test/, so it must run outside the Obsidian runtime. Keeping these
// functions here rather than in main.ts means the tests exercise the real implementation
// instead of a hand-maintained copy.

/**
 * A line is a comment when it starts with "//", or with "#" followed by whitespace or
 * another "#". Tag names cannot contain spaces, so "#foo" is a tag and "# foo" is not.
 * This test must run on the raw line, before any leading "#" is stripped.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isTagListComment(line) {
    return line.startsWith('//') || /^#(\s|#)/.test(line);
}

/**
 * Parse "old,new" rename pairs. The documented format allows an optional leading "#" on
 * either column, so the comment filter is deliberately narrower than "starts with #".
 *
 * @param {string} csvText
 * @returns {{ from: string; to: string }[]}
 */
export function parseCsvRenamePairs(csvText) {
    const lines = csvText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !isTagListComment(l));

    const pairs = [];

    for (const line of lines) {
        const commaIdx = line.indexOf(',');
        if (commaIdx === -1) continue;

        const from = line.substring(0, commaIdx).trim().replace(/^#/, '');
        const to = line
            .substring(commaIdx + 1)
            .trim()
            .replace(/^#/, '');

        // Skip header row
        if (from === 'old_tag' && to === 'new_tag') continue;
        if (!from || !to) continue;

        pairs.push({ from, to });
    }

    return pairs;
}

/**
 * Parse a newline-separated list of tags to delete.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseTagDeleteList(text) {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !isTagListComment(l))
        .map((l) => l.replace(/^#/, ''))
        .filter((l) => l.length > 0);
}

/**
 * Quote frontmatter values that contain an unescaped ": " sequence, which YAML would
 * otherwise read as a nested mapping and reject.
 *
 * Returns the corrected document, or null when nothing needed fixing. Delimiters are
 * captured rather than re-located with indexOf so CRLF files and notes containing a
 * "---" horizontal rule are both handled correctly.
 *
 * @param {string} data
 * @returns {string | null}
 */
export function fixFrontmatterMapping(data) {
    const fmMatch = data.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
    if (!fmMatch) return null;

    const [fullMatch, openDelim, body, closeDelim] = fmMatch;
    const newline = openDelim.includes('\r\n') ? '\r\n' : '\n';
    let isModified = false;

    const fixedLines = body.split(/\r?\n/).map((line) => {
        // Targets lines like: Key: Text with a: inside
        // Group 1: the key (e.g. "Resumen", "Título")
        // Group 2: the invalid unquoted value (contains ": ")
        //
        // Group 2 must *begin* with a character that is neither whitespace nor a YAML
        // structural marker, which leaves already-quoted and structured values alone.
        // Note this cannot be written as \s*(?!["'[{>|]): there, \s* simply backtracks to
        // zero width so the lookahead inspects the space instead of the quote, and
        // `key: "a: b"` gets quoted a second time.
        const match = line.match(/^([\p{L}\p{N}\s_-]+):\s*([^\s"'[{>|].*:\s.*)$/u);
        if (!match) return line;

        const key = match[1];
        // Escape any existing double quotes inside the string.
        const value = match[2].replace(/"/g, '\\"');

        isModified = true;
        return `${key}: "${value}"`;
    });

    if (!isModified) return null;

    return openDelim + fixedLines.join(newline) + closeDelim + data.substring(fullMatch.length);
}
