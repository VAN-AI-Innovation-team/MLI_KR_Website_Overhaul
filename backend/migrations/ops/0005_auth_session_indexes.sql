CREATE INDEX idx_sessions_member_parent ON sessions(member_session_id)
  WHERE member_session_id IS NOT NULL;
CREATE INDEX idx_sessions_active_admin_code ON sessions(admin_code_fingerprint)
  WHERE kind = 'admin' AND revoked_at IS NULL;
