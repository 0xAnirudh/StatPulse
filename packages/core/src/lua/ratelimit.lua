-- keys: 1
--
-- Sliding-window rate limit over a sorted set.
--
-- Each request adds one member scored by the moment it arrived. Counting
-- the members inside the window gives a true sliding count, rather than
-- the fixed-window approximation that INCR-with-an-expiry produces.
--
-- Why not a fixed window. A counter that resets on the minute lets a
-- caller fire a full window's worth at 11:59:59.9 and another full
-- window's worth at 12:00:00.1 - twice the intended rate, delivered as a
-- burst, at whatever moment the attacker chooses. For a subscribe
-- endpoint that feeds a notification queue, that is the whole attack.
--
-- Why this is a script rather than four commands from Node. Trim, count,
-- decide, record has to be atomic. Issued separately, fifty concurrent
-- requests all read the same pre-increment count, all see room, and all
-- pass - which is precisely the case a limiter exists for.
--
-- Time comes from Redis, not from the caller. Several API instances
-- answer these requests and their clocks differ by tens of milliseconds;
-- letting each supply its own would make the window ragged in a way that
-- depends on which instance you happened to reach. One server, one clock.

local key    = KEYS[1]
local window = tonumber(ARGV[1])   -- milliseconds
local limit  = tonumber(ARGV[2])
local member = ARGV[3]             -- unique per request

local t = redis.call('TIME')
local now_ms = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

-- Drop everything that has fallen out of the window.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms - window)

local used = redis.call('ZCARD', key)

if used >= limit then
  -- Refused. Report when the oldest request ages out, which is the
  -- earliest moment a retry could succeed.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_ms = window
  if oldest[2] then
    reset_ms = math.ceil(tonumber(oldest[2]) + window - now_ms)
  end
  return { 0, 0, reset_ms }
end

redis.call('ZADD', key, now_ms, member)

-- Re-set on every accepted request, so an idle caller's key disappears
-- on its own. The keyspace stays self-cleaning with no sweeper.
redis.call('PEXPIRE', key, window)

return { 1, limit - used - 1, window }
