import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '.local/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/generated/**',
      'coverage/**',
      'paypal-mediator-frontend/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ['**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
);
