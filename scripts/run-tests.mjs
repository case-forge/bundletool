/**
 * The test runner behind `npm test`. TEST_SCOPE picks the files: `all` (the default), `fast` (everything except the
 * files named in tests/slow-tests.txt) or `slow` (only those). The slow files drive the command line tools and the PDF and
 * OCR engines, take minutes, and read only scripts, browser modules and vendor files, never a stylesheet or a template, so CI
 * runs them when something they read changed (the CI workflow decides) and runs everything on main.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const scope = process.env.TEST_SCOPE || 'all';
if (!['all', 'fast', 'slow'].includes(scope)) throw new Error(`TEST_SCOPE must be all, fast or slow, not "${scope}"`);

const slow = new Set(fs.readFileSync(path.join(root, 'tests', 'slow-tests.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
const every = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
const files = every.filter((f) => scope === 'all' || (scope === 'slow') === slow.has(f)).map((f) => path.join('tests', f));
console.log(`run-tests: scope ${scope}, ${files.length} of ${every.length} test files`);

const child = spawn(process.execPath, ['--import', './tests/register-hooks.mjs', '--test', ...files], { cwd: root, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
