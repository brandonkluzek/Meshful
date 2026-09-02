import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const environment = {
  ...process.env,
  MESHFUL_CANONICAL_ROOT: root,
  MESHFUL_ACCOUNTS_ROOT: root,
};
delete environment.NODE_COMPILE_CACHE;

function testsAt(relative) {
  return readdirSync(resolve(root, relative))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => `${relative}/${name}`);
}

const suites = [
  ['accounts', testsAt('accounts/tests')],
  ['backend-v1', [
    ...testsAt('backend/tests'),
    'backend/integration/accounts.test.mjs',
  ]],
  ['backend-v2', [
    ...testsAt('backend/v2/tests'),
    'backend/v2/integration/account-storage.test.mjs',
    'backend/v2/integration/capacity.test.mjs',
  ]],
];

for (const [name, files] of suites) {
  console.log(`\n# ${name}`);
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...files], {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
