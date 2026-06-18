import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianPlugin from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: [
            'node_modules',
            'dist',
            'main.js',
            'coverage',
            'jest.config.js',
            'version-bump.mjs',
            'esbuild.config.mjs'
        ]
    },
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
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            ...obsidianPlugin.configs.recommended,
            // The 24 substantive Obsidian rules above stay as errors. The
            // sentence-case rule is stylistic and has false positives on proper
            // nouns ("Global Search") and abbreviations ("A-Z"), so it is kept
            // as a warning — visible guidance that never blocks the build.
            'obsidianmd/ui/sentence-case': 'warn'
        }
    },
    {
        files: ['test/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        }
    },
    eslintConfigPrettier
);
