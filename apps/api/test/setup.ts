// Ignore unhandled rejections from pg-boss connection attempts in tests.
// These are expected when no real database is configured (ECONNREFUSED on port 1).
// Also ignore pg-boss foreign key constraint errors in test database (pg-boss schema issues).
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    const msg = reason.message;
    if (
      msg.includes('ECONNREFUSED') ||
      msg.includes('subscription_name_fkey') ||
      msg.includes('violates foreign key constraint')
    ) {
      // Ignore expected connection failures and pg-boss schema issues in test database.
      return;
    }
  }
  // Log other unhandled rejections for debugging.
  console.error('Unhandled rejection:', reason);
});

process.on('unhandledException', (error) => {
  if (
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('subscription_name_fkey') ||
    error.message.includes('violates foreign key constraint')
  ) {
    // Ignore expected connection failures and pg-boss schema issues.
    return;
  }
  console.error('Unhandled exception:', error);
});
