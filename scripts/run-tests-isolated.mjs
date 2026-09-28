// Runs every compiled test file in its own process, one after another. Files
// share a single mongodb-memory-server binary and in-process module state, so
// one combined `node --test` run is flaky; isolated runs are the reliable signal.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function findTestFiles(dir) {
    return readdirSync(dir).flatMap((entry) => {
        const fullPath = path.join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
            return findTestFiles(fullPath);
        }
        return entry.endsWith('.test.js') ? [fullPath] : [];
    });
}

const files = findTestFiles('dist/tests').sort();
const failed = [];

for (const file of files) {
    const result = spawnSync(process.execPath, ['--test', file], {
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'test' },
    });
    if (result.status !== 0) {
        failed.push(file);
    }
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed.`);
if (failed.length > 0) {
    console.log(`Failed:\n  ${failed.join('\n  ')}`);
    process.exit(1);
}
