import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';

const LUA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'lua');

/**
 * Lua script loader.
 *
 * Every script declares how many of its arguments are keys on its first
 * line:
 *
 *     -- keys: 2
 *
 * That matters more than it looks. Redis Cluster routes a command by its
 * declared keys, so a script that lies about its key count works on a
 * single node and breaks the moment the deployment grows. Declaring it
 * in the file, next to the KEYS[] uses it describes, keeps the two from
 * drifting apart.
 *
 * Loading goes through ioredis `defineCommand`, which caches the SHA,
 * calls EVALSHA, and transparently falls back to EVAL and reloads on
 * NOSCRIPT - which happens after a Redis restart or a SCRIPT FLUSH.
 * Hand-rolling that retry would be reimplementing a solved problem in
 * the one place where getting it wrong fails a request.
 */

const KEYS_DIRECTIVE = /^\s*--\s*keys:\s*(\d+)\s*$/m;

export function parseKeyCount(source, name) {
  const match = source.match(KEYS_DIRECTIVE);
  if (!match) {
    throw new Error(
      `lua script "${name}" is missing its key-count directive. ` +
        `Add a line like "-- keys: 1" declaring how many arguments are keys.`,
    );
  }
  return Number(match[1]);
}

/**
 * A script's filename becomes a method on the Redis client, so a file
 * named `get.lua` does not add a command - it *replaces* `redis.get()`
 * with itself. Every caller then invokes the script where it meant to
 * call the real command, with the wrong arity, and fails somewhere
 * unrelated and baffling.
 *
 * Throwing at load keeps this a boot-time error rather than a mystery at
 * runtime.
 */
export function assertNoCollision(redis, name) {
  if (typeof redis[name] === 'function') {
    throw new Error(
      `lua script "${name}" would shadow the existing redis client method ` +
        `"${name}". Rename the file - a script's name becomes a client method, ` +
        `so it silently replaces the real command.`,
    );
  }
}

export async function loadScripts(redis, dir = LUA_DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.lua')).sort();
  const loaded = [];

  for (const file of files) {
    const name = basename(file, '.lua');
    const lua = await readFile(join(dir, file), 'utf8');
    assertNoCollision(redis, name);
    redis.defineCommand(name, { numberOfKeys: parseKeyCount(lua, name), lua });
    loaded.push(name);
  }

  log.info('lua scripts loaded', { count: loaded.length, scripts: loaded });
  return loaded;
}
