-- Only the authorized backend database role accesses submission records.
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_events ENABLE ROW LEVEL SECURITY;
