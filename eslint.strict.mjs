// Maximally strict Obsidian lint: every rule the plugin exposes, at "error",
// applied to TypeScript AND to the JSON files the normal config never touches.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianPlugin from 'eslint-plugin-obsidianmd';
import globals from 'globals';

// Every rule at error, regardless of what "recommended" chooses.
const allRules = Object.fromEntries(Object.keys(obsidianPlugin.rules).map((r) => [`obsidianmd/${r}`, 'error']));

// Rules that operate on JSON sources rather than TS.
const jsonRuleNames = [
    'obsidianmd/validate-manifest',
    'obsidianmd/validate-license',
    'obsidianmd/ui/sentence-case-json'
];
const tsRules = Object.fromEntries(Object.entries(allRules).filter(([k]) => !jsonRuleNames.includes(k)));
const jsonRules = Object.fromEntries(Object.entries(allRules).filter(([k]) => jsonRuleNames.includes(k)));

export default tseslint.config(
    {
        ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'package-lock.json', 'main.js']
    },
    { files: ['**/*.ts', '**/*.tsx', '**/*.mjs', '**/*.cjs'], ...eslint.configs.recommended },
    ...tseslint.configs.recommended.map((c) => ({ files: ['**/*.ts', '**/*.tsx'], ...c })),
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            ecmaVersion: 2020,
            globals: { ...globals.browser, ...globals.node },
            parserOptions: { project: './tsconfig.json' }
        },
        plugins: { obsidianmd: obsidianPlugin },
        rules: {
            ...tsRules,
            'obsidianmd/ui/sentence-case': ['error', { enforceCamelCaseLower: true }]
        }
    },
    {
        // validate-manifest / validate-license are typescript-eslint rules that walk an
        // ESTree Program, so the file must go through the TS parser -- not @eslint/json.
        files: ['**/manifest.json', '**/LICENSE'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: false } }
        },
        plugins: { obsidianmd: obsidianPlugin },
        rules: {
            ...jsonRules
        }
    },
    {
        files: ['**/*.mjs', '**/*.cjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node }
        }
    }
);
