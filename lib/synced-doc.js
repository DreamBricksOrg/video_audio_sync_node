/**
 * A JSON document kept in a store shared by several servers (local file or an
 * S3 object with ETags, see lib/config-store.js).
 *
 * mutate(fn): re-read the latest version, apply fn to a copy, save it
 * conditionally and retry if another server saved in between — so concurrent
 * servers never overwrite each other. fn may throw to abort (nothing is saved);
 * its return value is passed on. Calls on one doc are queued.
 *
 * refresh(): pick up changes from other servers; onChange(prev, next) runs
 * when there is a newer version.
 */
class SyncConflictError extends Error {}

function createSyncedDoc({ store, isConflict, onChange = () => {}, maxAttempts = 5 }) {
  let value = {};
  let queue = Promise.resolve();

  async function load() {
    value = await store.load();
    return value;
  }

  async function refresh() {
    const fresh = await store.refresh();
    if (!fresh) return false;
    const prev = value;
    value = fresh;
    onChange(prev, fresh);
    return true;
  }

  function mutate(fn) {
    const run = async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await refresh();
        const next = structuredClone(value);
        const result = fn(next);
        try {
          await store.save(next);
          value = next;
          return result;
        } catch (err) {
          if (!isConflict(err)) throw err;
        }
      }
      throw new SyncConflictError("changed by another server too many times in a row");
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  return { load, refresh, mutate, get: () => value };
}

module.exports = { createSyncedDoc, SyncConflictError };
