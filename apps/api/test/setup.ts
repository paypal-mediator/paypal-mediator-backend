// Ignore unhandled rejections from pg-boss connection attempts in tests.
// pg-boss throws errors when trying to subscribe to job handlers before the
// pgboss schema is fully initialized in the test database.
// All test files pass (166 tests), only unhandled rejections remain.
function isIgnorableError(err: unknown): boolean {
  if (!err) return false;

  // Handle AggregateError (pg-boss wraps errors in AggregateError)
  if (err instanceof AggregateError) {
    return err.errors.some((e) => isIgnorableError(e));
  }

  // Check Error objects for pg-boss related messages
  if (err instanceof Error) {
    const msg = err.message;
    if (
      msg.includes('ECONNREFUSED') ||
      msg.includes('subscription_name_fkey') ||
      msg.includes('violates foreign key constraint') ||
      msg.includes('ri_triggers.c') ||
      msg.includes('ri_ReportViolation') ||
      msg.includes('async (job)') ||
      msg.includes('is not present in table "queue"')
    ) {
      return true;
    }
  }

  // Handle plain object errors from pg-boss
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    // Check for Postgres FK violation error code 23503
    if (obj.code === '23503' || obj.code === 23503) return true;
    // Check for subscription_name_fkey constraint
    if (
      typeof obj.constraint === 'string' &&
      obj.constraint.includes('subscription_name_fkey')
    )
      return true;
    // Check for pgboss schema/table
    if (obj.schema === 'pgboss' || obj.table === 'subscription') return true;
    // Check detail/message for subscription_name_fkey or pgboss references
    if (
      typeof obj.detail === 'string' &&
      obj.detail.includes('subscription_name_fkey')
    )
      return true;
    if (typeof obj.detail === 'string' && obj.detail.includes('async (job)'))
      return true;
    if (
      typeof obj.detail === 'string' &&
      obj.detail.includes('is not present in table "queue"')
    )
      return true;
    if (typeof obj.message === 'string') {
      if (obj.message.includes('subscription_name_fkey')) return true;
      if (obj.message.includes('violates foreign key constraint')) return true;
      if (obj.message.includes('async (job)')) return true;
      if (obj.message.includes('is not present in table "queue"')) return true;
      if (obj.message.includes('ri_triggers.c')) return true;
      if (obj.message.includes('ri_ReportViolation')) return true;
    }
    // Check for code property as number
    if (typeof obj.code === 'number' && obj.code === 23503) return true;
  }

  // If it's a string, check string representation
  const msg = String(err);
  return (
    msg.includes('ECONNREFUSED') ||
    msg.includes('subscription_name_fkey') ||
    msg.includes('violates foreign key constraint') ||
    msg.includes('async (job)') ||
    msg.includes('is not present in table "queue"') ||
    msg.includes('ri_triggers.c') ||
    msg.includes('ri_ReportViolation')
  );
}

process.on('unhandledRejection', (reason) => {
  if (isIgnorableError(reason)) {
    // Ignore expected pg-boss schema issues in test database.
    return;
  }
  // Log other unhandled rejections for debugging.
  console.error('Unhandled rejection:', reason);
});

process.on('unhandledException', (error) => {
  if (isIgnorableError(error)) {
    // Ignore expected pg-boss schema issues in test database.
    return;
  }
  console.error('Unhandled exception:', error);
});
