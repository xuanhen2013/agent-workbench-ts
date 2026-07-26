import antfu from '@antfu/eslint-config'

export default antfu({
  rules: {
    'no-console': 'off',
    'prefer-promise-reject-errors': 'off',
    '@typescript-eslint/ban-ts-comment': 'warn',
    'ts/ban-ts-comment': 'warn',
  },
  ignores: ['./old-src'],
})
