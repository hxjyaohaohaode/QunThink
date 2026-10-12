/** Persist while holding the auth write lock. Always terminate the affected
 * sockets, including commit-with-lost-ACK and precommit failures. A session
 * still present in the re-read authority can reconnect; unknown state fails closed. */
export async function writeSessionChanges(db, revokedTokens, revoke) {
  try { await db.write(); }
  catch (error) {
    try { await db.read({ force: true }); }
    catch {
      throw Object.assign(new Error('会话更新结果待核验，请稍后重试'), {
        code: 'SESSION_UPDATE_UNKNOWN', statusCode: 503, isOperational: true
      });
    }
    throw error;
  } finally {
    for (const token of revokedTokens) revoke(token);
  }
}
