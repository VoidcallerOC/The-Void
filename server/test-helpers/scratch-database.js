// Test-only teardown for scratch databases.
//
// pg-pool's end() resolves once it has asked idle clients to close, not once their
// sockets are gone. DROP DATABASE ... WITH (FORCE) can then race those closing
// sessions and deliver FATAL 57P01 to a client that no longer has an error
// listener, which surfaces as an uncaught exception. Wait until Postgres reports
// no sessions on the database before dropping it.
export async function dropScratchDatabase(adminPool, name, { pool = null, timeoutMs = 10_000 } = {}) {
  if (pool) await pool.end().catch(() => {});
  if (!name) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await adminPool.query("SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()", [name]);
    if (rows[0].sessions === 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
}
