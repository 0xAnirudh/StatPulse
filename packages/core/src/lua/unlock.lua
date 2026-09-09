-- keys: 1
--
-- Release a lock, but only if it is still ours.
--
-- The naive release is DEL, and it is wrong in a way that only shows up
-- under the load this lock exists to handle. Consider:
--
--   1. A holds the lock and starts rebuilding.
--   2. The rebuild is slow - Mongo is struggling, which is precisely
--      when the cache is missing - and the lock's 5s expiry fires.
--   3. B acquires the now-free lock and starts its own rebuild.
--   4. A finishes and calls DEL, deleting *B's* lock.
--   5. C acquires it. Two rebuilds now run concurrently, which is the
--      stampede the lock was supposed to prevent.
--
-- Comparing the value first closes that. Reading and deleting from
-- JavaScript would not: the check and the delete have to be one step, or
-- the lock can expire between them and the same bug returns.

local token = redis.call('GET', KEYS[1])
if token == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
