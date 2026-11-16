// /api 는 여기서, 나머지 화면은 정적 파일(ASSETS)이 처리한다.
import { Hono } from "hono";
import { inquiryStatus, settings } from "../src/content";
import { canMove } from "../src/lib/status";
import { type Bindings, bad, clean, describeError, intIn, ownerOnly, rateLimited } from "./lib";
import {
  type MonitorTargetRow,
  collectGenericPage,
  collectKnpsEco,
  runMonitorTarget,
  sendTelegramAlert,
} from "./monitors";
import { mountSettings } from "./settings";

const app = new Hono<{ Bindings: Bindings }>().basePath("/api");

app.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
  c.header("x-robots-tag", "noindex");
});

app.get("/health", c => c.json({ ok: true }));

app.get("/admin/summary", ownerOnly, c => c.json({ ok: true }));

mountSettings(app, settings);

const INITIAL_KNPS_TARGETS = [
  { deptId: "B971002", name: "북한산 생태탐방원 (B971002) 토요일 생활관" },
  { deptId: "B014003", name: "지리산 생태탐방원 (B014003) 토요일 생활관" },
  { deptId: "B123002", name: "소백산 생태탐방원 (B123002) 토요일 생활관" },
  { deptId: "B163001", name: "계룡산 생태탐방원 (B163001) 토요일 생활관" },
  { deptId: "B301002", name: "설악산 생태탐방원 (B301002) 토요일 생활관" },
  { deptId: "B024002", name: "한려해상 생태탐방원 (B024002) 토요일 생활관" },
  { deptId: "B231002", name: "무등산 생태탐방원 (B231002) 토요일 생활관" },
  { deptId: "B133002", name: "가야산 생태탐방원 (B133002) 토요일 생활관" },
  { deptId: "B331001", name: "내장산 생태탐방원 (B331001) 토요일 생활관" },
  { deptId: "B183001", name: "변산반도 생태탐방원 (B183001) 토요일 생활관" },
];

/**
 * 기본 감시 대상(10개 국립공원 생태탐방원 토요일 생활관 + 공통 수집기 예시)이 누락 없이 등록되어 있는지 확인하고
 * 아직 한 번도 조회되지 않은 대상은 초기 조회를 수행한다.
 */
async function ensureInitialSeed(env: Bindings) {
  const { results: existing } = await env.DB.prepare("SELECT url FROM monitor_targets").all<{ url: string }>();
  const existingUrls = new Set(existing.map(r => r.url));

  for (const item of INITIAL_KNPS_TARGETS) {
    const url = `https://res.knps.or.kr/eco/searchEcoMonthReservation.do?deptId=${item.deptId}`;
    if (!existingUrls.has(url)) {
      await env.DB.prepare(
        `INSERT INTO monitor_targets (
           name, url, adapter_type, selector, interval_min, condition_op, condition_val, enabled, auth_env_key
         ) VALUES (?, ?, 'knps-eco', '토요일 생활관 잔여 수 (당월·익월 달력 및 객실 상세)', 5, 'gte', '1', 1, '')`
      )
        .bind(item.name, url)
        .run();
    }
  }

  if (existing.length === 0) {
    await env.DB.prepare(
      `INSERT INTO monitor_targets (
         name, url, adapter_type, selector, interval_min, condition_op, condition_val, enabled, auth_env_key
       ) VALUES (?, ?, 'generic-html', 'title', 30, 'contains', '국립공원', 0, '')`
    )
      .bind("국립공원 예약시스템 메인 공지·타이틀 감시 (공통 수집기)", "https://res.knps.or.kr")
      .run();
  }

  const { results: idleTargets } = await env.DB.prepare(
    "SELECT * FROM monitor_targets WHERE last_status = 'idle' AND enabled = 1 ORDER BY id ASC"
  ).all<MonitorTargetRow>();

  for (const t of idleTargets) {
    await runMonitorTarget(env, t);
  }
}

app.get("/monitors", async c => {
  await ensureInitialSeed(c.env);
  const { results: targets } = await c.env.DB.prepare(
    "SELECT * FROM monitor_targets ORDER BY id ASC"
  ).all<MonitorTargetRow>();

  const { results: logs } = await c.env.DB.prepare(
    "SELECT * FROM monitor_logs ORDER BY id DESC LIMIT 60"
  ).all();

  const telegramConfigured = Boolean(c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID);
  const siteAuthConfigured = Boolean(c.env.SITE_AUTH_COOKIE);

  return c.json({
    targets,
    logs,
    integrations: {
      telegramConfigured,
      telegramBotMasked: c.env.TELEGRAM_BOT_TOKEN ? "연결됨 (환경 변수 보호됨)" : "미설정",
      telegramChatMasked: c.env.TELEGRAM_CHAT_ID ? "연결됨 (환경 변수 보호됨)" : "미설정",
      siteAuthConfigured,
    },
  });
});

app.post("/monitors", async c => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = clean(b.name, 100);
  const url = clean(b.url, 500);
  const adapter_type = clean(b.adapter_type, 30) || "generic-html";
  const selector = clean(b.selector, 300) || (adapter_type === "knps-eco" ? "토요일 생활관" : "title");
  const interval_min = intIn(b.interval_min, 1, 1440, 5);
  const condition_op = clean(b.condition_op, 20) || "gte";
  const condition_val = clean(b.condition_val, 120) || "1";
  const enabled = b.enabled === false || b.enabled === 0 ? 0 : 1;
  const auth_env_key = clean(b.auth_env_key, 60);

  if (!name || !url) return bad(c, "사이트 이름과 URL을 모두 입력해 주세요.");
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return bad(c, "http:// 또는 https:// 로 시작하는 올바른 주소를 입력해 주세요.");
    }
  } catch {
    return bad(c, "올바른 URL 형식이 아니에요.");
  }

  const res = await c.env.DB.prepare(
    `INSERT INTO monitor_targets (
       name, url, adapter_type, selector, interval_min, condition_op, condition_val, enabled, auth_env_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(name, url, adapter_type, selector, interval_min, condition_op, condition_val, enabled, auth_env_key)
    .run();

  const newId = Number(res.meta.last_row_id);
  const created = await c.env.DB.prepare("SELECT * FROM monitor_targets WHERE id = ?")
    .bind(newId)
    .first<MonitorTargetRow>();

  if (created) {
    await runMonitorTarget(c.env, created);
  }

  const updated = await c.env.DB.prepare("SELECT * FROM monitor_targets WHERE id = ?")
    .bind(newId)
    .first<MonitorTargetRow>();

  return c.json({ target: updated }, 201);
});

app.patch("/monitors/:id", async c => {
  const id = Number(c.req.param("id"));
  const existing = await c.env.DB.prepare("SELECT * FROM monitor_targets WHERE id = ?")
    .bind(id)
    .first<MonitorTargetRow>();
  if (!existing) return bad(c, "감시 대상을 찾을 수 없어요.", 404);

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = b.name !== undefined ? clean(b.name, 100) : existing.name;
  const url = b.url !== undefined ? clean(b.url, 500) : existing.url;
  const adapter_type = b.adapter_type !== undefined ? clean(b.adapter_type, 30) : existing.adapter_type;
  const selector = b.selector !== undefined ? clean(b.selector, 300) : existing.selector;
  const interval_min =
    b.interval_min !== undefined ? intIn(b.interval_min, 1, 1440, existing.interval_min) : existing.interval_min;
  const condition_op = b.condition_op !== undefined ? clean(b.condition_op, 20) : existing.condition_op;
  const condition_val = b.condition_val !== undefined ? clean(b.condition_val, 120) : existing.condition_val;
  const enabled =
    b.enabled !== undefined ? (b.enabled === true || b.enabled === 1 ? 1 : 0) : existing.enabled;
  const auth_env_key = b.auth_env_key !== undefined ? clean(b.auth_env_key, 60) : existing.auth_env_key;

  const resetDedup = b.reset_dedup === true;

  await c.env.DB.prepare(
    `UPDATE monitor_targets
     SET name = ?, url = ?, adapter_type = ?, selector = ?, interval_min = ?,
         condition_op = ?, condition_val = ?, enabled = ?, auth_env_key = ?,
         last_alert_hash = ?
     WHERE id = ?`
  )
    .bind(
      name,
      url,
      adapter_type,
      selector,
      interval_min,
      condition_op,
      condition_val,
      enabled,
      auth_env_key,
      resetDedup ? "" : existing.last_alert_hash,
      id
    )
    .run();

  const updated = await c.env.DB.prepare("SELECT * FROM monitor_targets WHERE id = ?")
    .bind(id)
    .first<MonitorTargetRow>();
  if (updated && (b.selector !== undefined || b.condition_op !== undefined || b.condition_val !== undefined)) {
    const outcome = await runMonitorTarget(c.env, updated);
    return c.json({ target: outcome.target });
  }
  return c.json({ target: updated });
});

app.post("/monitors/batch-days", async c => {
  const b = (await c.req.json().catch(() => ({}))) as { days?: string[] };
  const validDays = (b.days ?? []).filter(d => ["금", "토", "일"].includes(d));
  if (validDays.length === 0) return bad(c, "최소 한 개 이상의 요일(금·토·일)을 선택해 주세요.");

  const dayStr = validDays.join(",");
  const dayLabel = validDays.join("·") + "요일";
  const newSelector = `요일:${dayStr} | ${dayLabel} 생활관 잔여 수`;

  const { results: knpsTargets } = await c.env.DB.prepare(
    "SELECT * FROM monitor_targets WHERE adapter_type = 'knps-eco' ORDER BY id ASC"
  ).all<MonitorTargetRow>();

  for (const t of knpsTargets) {
    const baseName = t.name.replace(/\s*(금·토·일|금·토|토·일|금·일|금요일|토요일|일요일|[금토일·]+요일)\s*생활관.*$/, "");
    const nextName = `${baseName} ${dayLabel} 생활관`;
    await c.env.DB.prepare(
      "UPDATE monitor_targets SET name = ?, selector = ?, last_alert_hash = '' WHERE id = ?"
    )
      .bind(nextName, newSelector, t.id)
      .run();
    const refreshed = await c.env.DB.prepare("SELECT * FROM monitor_targets WHERE id = ?")
      .bind(t.id)
      .first<MonitorTargetRow>();
    if (refreshed && refreshed.enabled === 1) {
      await runMonitorTarget(c.env, refreshed);
    }
  }

  return c.json({ ok: true, count: knpsTargets.length, selector: newSelector });
});

app.delete("/monitors/:id", async c => {
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM monitor_targets WHERE id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM monitor_logs WHERE target_id = ?").bind(id).run();
  return c.json({ ok: true });
});

app.post("/monitors/:id/check", async c => {
  const id = Number(c.req.param("id"));
  const target = await c.env.DB.prepare("SELECT * FROM monitor_targets WHERE id = ?")
    .bind(id)
    .first<MonitorTargetRow>();
  if (!target) return bad(c, "감시 대상을 찾을 수 없어요.", 404);

  const b = (await c.req.json().catch(() => ({}))) as { forceAlertTest?: boolean };
  const outcome = await runMonitorTarget(c.env, target, { forceAlertTest: Boolean(b.forceAlertTest) });
  return c.json(outcome);
});

app.get("/monitors/check-due", async c => {
  const forceAll = c.req.query("force") === "1" || c.req.query("force") === "true";
  const { results: targets } = await c.env.DB.prepare(
    "SELECT * FROM monitor_targets WHERE enabled = 1 ORDER BY id ASC"
  ).all<MonitorTargetRow>();

  const now = Date.now();
  const executed: Array<unknown> = [];

  for (const t of targets) {
    const lastMs = t.last_checked_at ? Date.parse(t.last_checked_at) : 0;
    const dueMs = t.interval_min * 60 * 1000;
    if (forceAll || !lastMs || now - lastMs >= dueMs - 5000) {
      const res = await runMonitorTarget(c.env, t);
      executed.push({
        id: t.id,
        name: t.name,
        extractedValue: res.result.extractedValue,
        conditionMet: res.conditionMet,
        alertStatus: res.alertStatus,
      });
    }
  }

  return c.json({ ok: true, checkedAt: new Date().toISOString(), executedCount: executed.length, executed });
});

app.post("/monitors/check-due", async c => {
  const b = (await c.req.json().catch(() => ({}))) as { forceAll?: boolean };
  const { results: targets } = await c.env.DB.prepare(
    "SELECT * FROM monitor_targets WHERE enabled = 1 ORDER BY id ASC"
  ).all<MonitorTargetRow>();

  const now = Date.now();
  const executed: Array<unknown> = [];

  for (const t of targets) {
    const lastMs = t.last_checked_at ? Date.parse(t.last_checked_at) : 0;
    const dueMs = t.interval_min * 60 * 1000;
    if (b.forceAll || !lastMs || now - lastMs >= dueMs - 5000) {
      const res = await runMonitorTarget(c.env, t);
      executed.push(res);
    }
  }

  return c.json({ executedCount: executed.length, executed });
});

app.post("/monitors/test-connection", async c => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = clean(b.url, 500);
  const adapter_type = clean(b.adapter_type, 30) || "generic-html";
  const selector = clean(b.selector, 300) || (adapter_type === "knps-eco" ? "토요일 생활관" : "title");
  const auth_env_key = clean(b.auth_env_key, 60);

  if (!url) return bad(c, "테스트할 URL을 입력해 주세요.");

  const tempTarget: MonitorTargetRow = {
    id: 0,
    name: "연결 테스트",
    url,
    adapter_type,
    selector,
    interval_min: 5,
    condition_op: clean(b.condition_op, 20) || "gte",
    condition_val: clean(b.condition_val, 120) || "1",
    enabled: 1,
    auth_env_key,
    last_status: "idle",
    last_value: "",
    last_summary: "",
    last_detail_json: "{}",
    last_alert_hash: "",
    last_checked_at: "",
    last_alerted_at: "",
    last_error: "",
    created_at: "",
  };

  const authCookie =
    auth_env_key && typeof c.env[auth_env_key] === "string"
      ? (c.env[auth_env_key] as string)
      : undefined;

  const result =
    adapter_type === "knps-eco"
      ? await collectKnpsEco(tempTarget, authCookie)
      : await collectGenericPage(tempTarget, authCookie);

  return c.json({ result });
});

app.post("/telegram/test", async c => {
  const b = (await c.req.json().catch(() => ({}))) as { customMessage?: string };
  const text =
    clean(b.customMessage, 500) ||
    [
      "🛰️ [파수꾼 모니터링 연결 테스트]",
      "• 대상: 북한산 생태탐방원 (B971002) 외 통합 감시",
      "• 상태: 텔레그램 알림 채널이 정상 작동 중입니다.",
      `• 테스트 시각: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    ].join("\n");

  const res = await sendTelegramAlert(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID, text);
  return c.json(res);
});

app.delete("/logs", async c => {
  await c.env.DB.prepare("DELETE FROM monitor_logs").run();
  return c.json({ ok: true });
});

// --- 기존 문의 라우트 보존 ---
const code6 = () =>
  [...crypto.getRandomValues(new Uint8Array(6))]
    .map(b => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31])
    .join("");

app.post("/inquiries", async c => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = clean(b.name, 40),
    contact = clean(b.contact, 80),
    message = clean(b.message, 1000);
  if (!name || !contact || !message) return bad(c, "이름·연락처·내용을 모두 적어 주세요");
  if (await rateLimited(c, "inquiry", 10, 600)) return bad(c, "잠시 뒤 다시 보내 주세요", 429);
  const code = code6();
  await c.env.DB.prepare("INSERT INTO inquiry (code, name, contact, message) VALUES (?, ?, ?, ?)")
    .bind(code, name, contact, message)
    .run();
  return c.json({ code }, 201);
});

app.get("/admin/inquiries", ownerOnly, async c => {
  const { results } = await c.env.DB.prepare("SELECT * FROM inquiry ORDER BY id DESC LIMIT 1000").all();
  return c.json({ rows: results });
});

app.patch("/admin/inquiries/:id", ownerOnly, async c => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM inquiry WHERE id = ?")
    .bind(id)
    .first<{ status: string; assignee: string }>();
  if (!row) return bad(c, "없는 문의예요", 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = b.status === undefined ? row.status : String(b.status);
  if (status !== row.status && !canMove(inquiryStatus, row.status, status))
    return bad(c, "지금 상태에서는 바꿀 수 없어요", 409);
  const assignee = b.assignee === undefined ? row.assignee : clean(b.assignee, 40);
  await c.env.DB.prepare("UPDATE inquiry SET status = ?, assignee = ? WHERE id = ?")
    .bind(status, assignee, id)
    .run();
  return c.json({ row: await c.env.DB.prepare("SELECT * FROM inquiry WHERE id = ?").bind(id).first() });
});

app.notFound(c => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} 500\n${describeError(err)}`);
  return c.json({ error: "잠시 뒤 다시 시도해 주세요" }, 500);
});

export default app;
