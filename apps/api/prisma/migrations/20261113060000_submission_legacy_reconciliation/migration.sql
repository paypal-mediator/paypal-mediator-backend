-- The previous sender classified timeouts and unparsed successful responses as
-- FAILED. Their delivery cannot be disproved; require manual reconciliation.
UPDATE submissions
SET status = 'UNKNOWN', error_code = 'SUBMISSION_RECONCILIATION_REQUIRED',
    error_message = 'Historical delivery requires reconciliation before another submission'
WHERE status = 'FAILED' AND request_hash IS NULL;
