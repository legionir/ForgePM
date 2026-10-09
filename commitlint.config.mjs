export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // plan §2: `feat(work-items): ...` style scope is expected
    'scope-case': [2, 'always', 'kebab-case'],
  },
};
