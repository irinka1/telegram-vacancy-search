function createRateLimiter({ windowMs, maxRequests, banDurationMs }) {
  const records = new Map();

  function now() {
    return Date.now();
  }

  function getRecord(key) {
    const normalizedKey = String(key);
    if (!records.has(normalizedKey)) {
      records.set(normalizedKey, {
        hits: [],
        bannedUntil: 0,
        lastReason: ''
      });
    }

    return records.get(normalizedKey);
  }

  function prune(record, currentTime) {
    record.hits = record.hits.filter((timestamp) => currentTime - timestamp < windowMs);
  }

  function check(key) {
    const currentTime = now();
    const record = getRecord(key);

    if (record.bannedUntil > currentTime) {
      return {
        allowed: false,
        banned: true,
        retryAfterMs: record.bannedUntil - currentTime,
        reason: record.lastReason || 'banned'
      };
    }

    if (record.bannedUntil && record.bannedUntil <= currentTime) {
      record.bannedUntil = 0;
      record.lastReason = '';
    }

    prune(record, currentTime);
    record.hits.push(currentTime);

    if (record.hits.length > maxRequests) {
      record.hits = [];
      record.bannedUntil = currentTime + banDurationMs;
      record.lastReason = 'rate-limit';

      return {
        allowed: false,
        banned: true,
        retryAfterMs: banDurationMs,
        reason: 'rate-limit'
      };
    }

    return {
      allowed: true,
      banned: false,
      remaining: Math.max(0, maxRequests - record.hits.length)
    };
  }

  function ban(key, reason = 'manual-ban') {
    const currentTime = now();
    const record = getRecord(key);
    record.hits = [];
    record.bannedUntil = currentTime + banDurationMs;
    record.lastReason = reason;
  }

  function isBanned(key) {
    const record = records.get(String(key));
    if (!record) return false;
    return record.bannedUntil > now();
  }

  function clear(key) {
    records.delete(String(key));
  }

  function clearExpired() {
    const currentTime = now();
    for (const [key, record] of records.entries()) {
      if (record.bannedUntil <= currentTime && record.hits.length === 0) {
        records.delete(key);
      }
    }
  }

  return {
    check,
    ban,
    isBanned,
    clear,
    clearExpired
  };
}

module.exports = {
  createRateLimiter
};