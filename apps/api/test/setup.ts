// Ignore unhandled rejections from pg-boss connection attempts in tests.
// These are expected when no real database is configured (ECONNREFUSED on port 1).
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && reason.message.includes('ECONNREFUSED')) {
    // Ignore expected connection failures to non-existent test database.
    return;
  }
  // Log other unhandled rejections for debugging.
  console.error('Unhandled rejection:', reason);
});

process.on('unhandledException', (error) => {
  if (error.message.includes('ECONNREFUSED')) {
    // Ignore expected connection failures.
    return;
  }
  console.error('Unhandled exception:', error);
});
