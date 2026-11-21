import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLocalMongoUri } from '../../config/index.js';

const CONFIG_URL = pathToFileURL(fileURLToPath(new URL('../../config/index.js', import.meta.url))).href;

// Loads the config in a fresh process, as the server does at boot, and reports
// whether it started. Only the variables given here are set.
function bootConfig(env: Record<string, string>): { ok: boolean; stderr: string } {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(CONFIG_URL)})`], {
        env: { PATH: process.env.PATH ?? '', JWT_SECRET: 'boot-test-secret', ...env },
        encoding: 'utf8',
    });
    return { ok: result.status === 0, stderr: result.stderr };
}

const LOCAL_DB = 'mongodb://127.0.0.1:27017/bleya_boot_test';
const REMOTE_DB = 'mongodb+srv://user:pw@cluster0.example.mongodb.net/bleya';
const GUARD_MESSAGE = /DEV_LOGIN_ENABLED is only allowed/;

test('only databases on this machine count as local', () => {
    for (const uri of [
        'mongodb://localhost:27017/bleya',
        'mongodb://127.0.0.1/bleya',
        'mongodb://user:pw@localhost:27017/bleya?authSource=admin',
        'mongodb://[::1]:27017/bleya',
        'mongodb://localhost:27017,127.0.0.1:27018/bleya?replicaSet=rs0',
    ]) {
        assert.equal(isLocalMongoUri(uri), true, uri);
    }

    for (const uri of [
        undefined,
        '',
        REMOTE_DB,
        'mongodb://mongo.railway.internal:27017/bleya',
        'mongodb://localhost.example.com:27017/bleya',
        'mongodb://localhost:27017,db.example.com:27017/bleya',
        'mongodb://user:localhost@db.example.com/bleya',
    ]) {
        assert.equal(isLocalMongoUri(uri), false, String(uri));
    }
});

test('dev login is off unless asked for, and a server without it boots anywhere', () => {
    assert.equal(bootConfig({ NODE_ENV: 'test', MONGODB_URI: REMOTE_DB }).ok, true);
});

test('dev login boots with a local database in development or test', () => {
    assert.equal(bootConfig({ NODE_ENV: 'test', DEV_LOGIN_ENABLED: 'true', MONGODB_URI: LOCAL_DB }).ok, true);
});

test('asking for dev login on production or a remote database stops the server from starting', () => {
    for (const env of [
        { NODE_ENV: 'production', DEV_LOGIN_ENABLED: 'true', MONGODB_URI: LOCAL_DB },
        { NODE_ENV: 'production', DEV_LOGIN_ENABLED: 'true', MONGODB_URI: REMOTE_DB },
        // A deployed server without NODE_ENV counts as development: the database decides.
        { NODE_ENV: 'test', DEV_LOGIN_ENABLED: 'true', MONGODB_URI: REMOTE_DB },
        { NODE_ENV: 'staging', DEV_LOGIN_ENABLED: 'true', MONGODB_URI: LOCAL_DB },
    ]) {
        const result = bootConfig(env);
        assert.equal(result.ok, false, JSON.stringify(env));
        assert.match(result.stderr, GUARD_MESSAGE, JSON.stringify(env));
    }
});
