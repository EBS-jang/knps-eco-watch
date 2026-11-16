-- 배포 때 BAZE 가 이 파일을 D1 에 적용한다. 바꿀 때는 기존 표를 지우지 말고 더하기만 한다.
CREATE TABLE IF NOT EXISTS rate_limit (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS inquiry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  assignee TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 감시 사이트 목록
CREATE TABLE IF NOT EXISTS monitor_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  adapter_type TEXT NOT NULL DEFAULT 'generic-html', -- 'knps-eco' | 'generic-html' | 'json-api'
  selector TEXT NOT NULL DEFAULT '',                 -- CSS/키워드/파라미터(예: deptId=B971002&day=sat&room=생활관)
  interval_min INTEGER NOT NULL DEFAULT 5,
  condition_op TEXT NOT NULL DEFAULT 'gte',          -- 'gte' | 'gt' | 'eq' | 'contains' | 'changed'
  condition_val TEXT NOT NULL DEFAULT '1',
  enabled INTEGER NOT NULL DEFAULT 1,
  auth_env_key TEXT NOT NULL DEFAULT '',             -- 인증/세션 환경변수 이름 (코드/평문 저장 금지)
  last_status TEXT NOT NULL DEFAULT 'idle',          -- 'idle' | 'ok' | 'matched' | 'blocked' | 'error'
  last_value TEXT NOT NULL DEFAULT '',
  last_summary TEXT NOT NULL DEFAULT '',
  last_detail_json TEXT NOT NULL DEFAULT '{}',
  last_alert_hash TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT NOT NULL DEFAULT '',
  last_alerted_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 수집 및 알림 실행 이력
CREATE TABLE IF NOT EXISTS monitor_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL,
  target_name TEXT NOT NULL,
  status TEXT NOT NULL,                              -- 'ok' | 'matched' | 'blocked' | 'error'
  extracted_value TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  condition_met INTEGER NOT NULL DEFAULT 0,
  alert_status TEXT NOT NULL DEFAULT 'none',         -- 'none' | 'sent' | 'skipped_duplicate' | 'simulated' | 'failed'
  alert_message TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
