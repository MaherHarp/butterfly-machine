import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const deterministic = [
  { object: 'Math', property: 'random', message: 'The simulation must be deterministic: use src/sim/hash.ts.' },
  { object: 'Math', property: 'sin', message: 'Use dsin() — engine-independent.' },
  { object: 'Math', property: 'cos', message: 'Use dcos() — engine-independent.' },
  { object: 'Math', property: 'atan2', message: 'Avoid transcendental functions in the simulation.' },
  { object: 'Math', property: 'exp', message: 'Avoid transcendental functions in the simulation.' },
  { object: 'Math', property: 'log', message: 'Avoid transcendental functions in the simulation.' },
  { object: 'Math', property: 'pow', message: 'Avoid transcendental functions in the simulation.' },
  { object: 'Math', property: 'hypot', message: 'Use Math.sqrt (IEEE-exact).' },
];

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.worker, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  // The simulation core and the workers that run it: no uncontrolled randomness, no engine-dependent math.
  { files: ['src/sim/**/*.ts'], rules: { 'no-restricted-properties': ['error', ...deterministic] } },
  {
    files: ['src/engine/**/*.ts'],
    rules: { 'no-restricted-properties': ['error', deterministic[0]] },
  },
);
