
// Mock test for separator logic

const settingsVariants = {
    kebab: {
        caseStrategy: 'lowercase',
        separatorStrategy: 'kebab',
        removeSpecialChars: false,
        applyToNestedTags: true
    },
    snake: {
        caseStrategy: 'lowercase',
        separatorStrategy: 'snake',
        removeSpecialChars: false,
        applyToNestedTags: true
    },
    preserve: {
        caseStrategy: 'lowercase',
        separatorStrategy: 'preserve',
        removeSpecialChars: false,
        applyToNestedTags: true
    }
};

function convertTag(tagContent, settings) {
    let parts = tagContent.split('/');

    let processedParts = parts.map((part, index) => {
        if (index > 0 && !settings.applyToNestedTags) {
            return part;
        }
        return transformSegment(part, settings);
    });

    return processedParts.join('/');
}

function transformSegment(segment, settings) {
    let s = segment;

    if (settings.removeSpecialChars) {
        s = s.replace(/[^\p{L}\p{N}\-_]/gu, '');
    }

    if (settings.separatorStrategy === 'snake') {
        s = s.replace(/-/g, '_');
    } else if (settings.separatorStrategy === 'kebab') {
        s = s.replace(/_/g, '-');
    }

    if (settings.caseStrategy === 'lowercase') {
        s = s.toLowerCase();
    } else if (settings.caseStrategy === 'uppercase') {
        s = s.toUpperCase();
    }

    return s;
}

const testCases = [
    // Kebab Tests
    { input: "My_Tag", settings: settingsVariants.kebab, expected: "my-tag" },
    { input: "Mixed_Separators-Test", settings: settingsVariants.kebab, expected: "mixed-separators-test" },

    // Snake Tests
    { input: "My-Tag", settings: settingsVariants.snake, expected: "my_tag" },
    { input: "Mixed_Separators-Test", settings: settingsVariants.snake, expected: "mixed_separators_test" },

    // Preserve Tests
    { input: "My_Tag-Here", settings: settingsVariants.preserve, expected: "my_tag-here" },
];

console.log("Running Tests...");
let failed = false;
testCases.forEach((tc, idx) => {
    const result = convertTag(tc.input, tc.settings);
    if (result !== tc.expected) {
        console.error(`Test ${idx} FAILED`);
        console.error(`Input:    '${tc.input}'`);
        console.error(`Settings: ${JSON.stringify(tc.settings)}`);
        console.error(`Expected: '${tc.expected}'`);
        console.error(`Actual:   '${result}'`);
        failed = true;
    } else {
        console.log(`Test ${idx} PASSED`);
    }
});

if (failed) {
    process.exit(1);
} else {
    console.log("All tests passed.");
}
