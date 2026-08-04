import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianPlugin from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

// eslint-plugin-obsidianmd's `recommended` export is a flat-config array, so it is spread
// as top-level configs. Spreading it into a `rules` object -- which worked against the
// 0.1.x API, where it was a plain rules map -- yields numeric keys and, on 0.4.x, makes
// ESLint fail to start.
export default tseslint.config(
    {
        ignores: [
            'node_modules',
            'dist',
            'main.js',
            'coverage',
            'jest.config.js',
            'version-bump.mjs',
            'esbuild.config.mjs',
            'eslint.strict.mjs'
        ]
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    ...obsidianPlugin.configs.recommended,
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            ecmaVersion: 2020,
            globals: {
                ...globals.browser,
                ...globals.node
            },
            parserOptions: {
                project: './tsconfig.json'
            }
        },
        plugins: {
            obsidianmd: obsidianPlugin
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/ban-ts-comment': 'off',
            // Stylistic, and it reports placeholders and tag examples as violations
            // ("^Projects/" -> "^projects/", "#old-tag" -> "#Old-tag"). Kept visible as a
            // warning rather than blocking the build.
            'obsidianmd/ui/sentence-case': 'warn'
        }
    },
    {
        files: ['test/**/*.mjs', 'tag-text.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        },
        rules: {
            // The console guidance is about noise in a running plugin. The test runner is
            // a node script whose entire output is its console report.
            'obsidianmd/rule-custom-message': 'off'
        }
    },
    eslintConfigPrettier
);
