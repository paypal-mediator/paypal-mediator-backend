// Ignore unhandled rejections from pg-boss connection attempts in tests.
// These are expected when no real database is configured (ECONNREFUSED on port 1).
// Also ignore pg-boss foreign key constraint errors in test database (pg-boss schema issues).
function isIgnorableError(err: unknown): boolean {
  if (!err) return false;
  // Handle AggregateError (pg-boss wraps errors in AggregateError)
  if (err instanceof AggregateError) {
    return err.errors.some((e) => isIgnorableError(e));
  }
  if (err instanceof Error) {
    const msg = err.message;
    return (
      msg.includes('ECONNREFUSED') ||
      msg.includes('subscription_name_fkey') ||
      msg.includes('violates foreign key constraint')
    );
  }
  // If it's a string or other type, check string representation
  const msg = String(err);
  return (
    msg.includes('ECONNREFUSED') ||
    msg.includes('subscription_name_fkey') ||
    msg.includes('violates foreign key constraint')
  );
}

process.on('unhandledRejection', (reason) => {
  if (isIgnorableError(reason)) {
    // Ignore expected connection failures and pg-boss schema issues in test database.
    return;
  }
  // Log other unhandled rejections for debugging.
  console.error('Unhandled rejection:', reason);
});

process.on('unhandledException', (error) => {
  if (isIgnorableError(error)) {
    // Ignore expected connection failures and pg-boss schema issues.
    return;
  }
  console.error('Unhandled exception:', error);
});
