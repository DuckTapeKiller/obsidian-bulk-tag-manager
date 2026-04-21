
const testCases = [
    {
        name: "Indented List",
        content: `---
tags:
  - movie
  - house
---`
    },
    {
        name: "Non-indented List",
        content: `---
tags:
- movie
- house
---`
    },
    {
        name: "Inline Array",
        content: `---
tags: [movie, house]
---`
    },
    {
        name: "Inline Array Multiline",
        content: `---
tags: [
  movie,
  house
]
---`
    },
    {
        name: "Mixed/Empty",
        content: `---
tags:
---`
    },
    {
        name: "Tags with Case",
        content: `---
Tags:
  - movie
---`
    }
];

function analyze(name, content) {
    console.log(`Analyzing: ${name}`);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
        console.log("No FM match");
        return;
    }

    const fmText = fmMatch[1];
    const lines = fmText.split('\n');
    let foundTags = false;
    let isInline = false;
    let isList = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.match(/^(tags?):/i)) { // Added 'i' flag
            // Wait, the current code in main.ts uses /^(tags?):/ which IS case-sensitive unless 'i' flag is passed.
            // The user code seems to rely on default (case sensitive).
            foundTags = true;
            let fullSection = line;

            // Collect
            for (let j = i + 1; j < lines.length; j++) {
                const subLine = lines[j];
                // THE LOGIC IN QUESTION:
                if (subLine.match(/^[a-zA-Z0-9_\-]+:/)) {
                    console.log(`  Break on line: '${subLine}'`);
                    break;
                }
                fullSection += '\n' + subLine;
            }

            console.log(`  Full Section: ${JSON.stringify(fullSection)}`);

            if (fullSection.includes('[')) {
                isInline = true;
            } else if (fullSection.match(/-\s/)) {
                isList = true;
            }
            break;
        }
    }

    console.log(`  Result: Inline=${isInline}, List=${isList}`);
    console.log('---');
}

testCases.forEach(t => analyze(t.name, t.content));
