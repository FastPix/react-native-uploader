import { fixupConfigRules } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  ...fixupConfigRules(compat.extends('@react-native', 'prettier')),
  {
    plugins: { prettier },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'prettier/prettier': 'warn',
    },
  },
  {
    // Build/generated output. Without these, a local Android or iOS build
    // leaves artifacts that bury real lint findings under ~100k reports.
    ignores: [
      'node_modules/',
      'lib/',
      'dist/',
      'coverage/',
      '**/build/',
      '**/Pods/',
      '.turbo/',
    ],
  },
];
