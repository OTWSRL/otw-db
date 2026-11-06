import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'test-results/**',
      'playwright-report/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/*.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React calls whatever an effect returns as its cleanup. An arrow with an expression body
      // returns that expression, such as scrollIntoView()'s promise in today's Chrome.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name=/^use(Layout|Insertion)?Effect$/] > ArrowFunctionExpression[expression=true][body.type!='ArrowFunctionExpression']",
          message:
            'Give the effect a block body: React calls what it returns as its cleanup, so it may return a function or nothing.',
        },
      ],
    },
  },
)
