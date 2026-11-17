import { useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wifi,
} from "lucide-react";

interface KnpsRoomDetail {
  prdNm: string;
  remain: number;
  maxNopCnt: number;
  rsrvtCnt: number;
  saleOpen: boolean;
}

interface KnpsDaySlot {
  useDt: string;
  yearMonth: string;
  day: string;
  dayOfWeek: string;
  remainCount: number;
  saleState: string;
  calYn: string;
  rooms?: KnpsRoomDetail[];
}

interface MonitorTarget {
  id: number;
  name: string;
  url: string;
  adapter_type: "knps-eco" | "generic-html" | "json-api";
  selector: string;
  interval_min: number;
  condition_op: "gte" | "gt" | "eq" | "contains" | "changed";
  condition_val: string;
  enabled: number;
  auth_env_key: string;
  last_status: "idle" | "ok" | "matched" | "blocked" | "error";
  last_value: string;
  last_summary: string;
  last_detail_json: string;
  last_alert_hash: string;
  last_checked_at: string;
  last_alerted_at: string;
  last_error: string;
  created_at: string;
}

interface MonitorLog {
  id: number;
  target_id: number;
  target_name: string;
  status: string;
  extracted_value: string;
  summary: string;
  detail_json: string;
  condition_met: number;
  alert_status: "none" | "sent" | "skipped_duplicate" | "simulated" | "failed";
  alert_message: string;
  error_message: string;
  duration_ms: number;
  created_at: string;
}

interface IntegrationsInfo {
  telegramConfigured: boolean;
  telegramBotMasked: string;
  telegramChatMasked: string;
  siteAuthConfigured: boolean;
  isLiveDeployment?: boolean;
}

const ADAPTER_LABELS: Record<string, string> = {
  "knps-eco": "사이트별 전용 연동 · 국립공원 생태탐방원",
  "generic-html": "공통 수집기 · 일반 웹페이지 (HTML/CSS)",
  "json-api": "사이트별 연동 · 동적 JSON 엔드포인트",
};

const CONDITION_LABELS: Record<string, string> = {
  gte: "이상 (>=)",
  gt: "초과 (>)",
  eq: "일치 (==)",
  contains: "텍스트 포함",
  changed: "이전 값과 달라짐",
};

const KNPS_DEPTS = [
  { id: "B971002", name: "북한산 생태탐방원" },
  { id: "B014003", name: "지리산 생태탐방원" },
  { id: "B123002", name: "소백산 생태탐방원" },
  { id: "B301002", name: "설악산 생태탐방원" },
  { id: "B163001", name: "계룡산 생태탐방원" },
  { id: "B024002", name: "한려해상 생태탐방원" },
  { id: "B231002", name: "무등산 생태탐방원" },
  { id: "B133002", name: "가야산 생태탐방원" },
  { id: "B331001", name: "내장산 생태탐방원" },
  { id: "B183001", name: "변산반도 생태탐방원" },
];

const WEEKEND_DAYS = ["금", "토", "일"] as const;

function parseDaysFromSelector(selector: string): string[] {
  const m = selector.match(/요일\s*:\s*([월화수목금토일,\s]+)/);
  if (m) {
    const parsed = m[1]
      .split(",")
      .map(s => s.trim())
      .filter(d => ["금", "토", "일"].includes(d));
    if (parsed.length > 0) return parsed;
  }
  const cleaned = selector.replace(/\([^)]*\)/g, " ");
  const found: string[] = [];
  if (cleaned.includes("금요일") || cleaned.includes("금·")) found.push("금");
  if (cleaned.includes("토요일") || cleaned.includes("·토") || cleaned.includes("토·")) found.push("토");
  if (cleaned.includes("일요일") || cleaned.includes("·일")) found.push("일");
  return found.length > 0 ? found : ["토"];
}

function buildSelectorWithDays(days: string[]): string {
  const ordered = WEEKEND_DAYS.filter(d => days.includes(d));
  const finalDays = ordered.length > 0 ? ordered : ["토"];
  return `요일:${finalDays.join(",")} | ${finalDays.join("·")}요일 생활관 잔여 수`;
}

function formatKst(iso: string) {
  if (!iso) return "아직 실행 안 됨";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

export default function Home() {
  const [targets, setTargets] = useState<MonitorTarget[]>([]);
  const [logs, setLogs] = useState<MonitorLog[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationsInfo>({
    telegramConfigured: false,
    telegramBotMasked: "확인 중",
    telegramChatMasked: "확인 중",
    siteAuthConfigured: false,
  });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const isLiveHost =
    typeof window !== "undefined" && window.location.hostname.endsWith(".baze.cloud");
  const [autoLoopOn, setAutoLoopOn] = useState(isLiveHost);
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(1);
  const [editingTarget, setEditingTarget] = useState<MonitorTarget | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // 새 사이트 등록 / 수정 폼 상태
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formAdapter, setFormAdapter] = useState<"knps-eco" | "generic-html" | "json-api">("generic-html");
  const [formSelector, setFormSelector] = useState("h1, title");
  const [formInterval, setFormInterval] = useState(5);
  const [formCondOp, setFormCondOp] = useState<"gte" | "gt" | "eq" | "contains" | "changed">("gte");
  const [formCondVal, setFormCondVal] = useState("1");
  const [formAuthKey, setFormAuthKey] = useState("");

  // 연결 테스트 결과
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{
    status: string;
    extractedValue: string;
    summary: string;
    durationMs: number;
    errorMessage?: string;
  } | null>(null);

  // 텔레그램 테스트 결과
  const [tgBusy, setTgBusy] = useState(false);
  const [tgFeedback, setTgFeedback] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showNotice(msg: string) {
    setToast(msg);
    setTimeout(() => {
      setToast(prev => (prev === msg ? null : prev));
    }, 4500);
  }

  async function loadDashboard() {
    try {
      const r = await fetch("/api/monitors");
      if (!r.ok) return;
      const data = (await r.json()) as {
        targets: MonitorTarget[];
        logs: MonitorLog[];
        integrations: IntegrationsInfo;
      };
      setTargets(data.targets);
      setLogs(data.logs);
      setIntegrations(data.integrations);
      if (data.targets.length > 0 && selectedTargetId === null) {
        setSelectedTargetId(data.targets[0].id);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDashboard();
  }, []);

  // 화면이 열려 있는 동안 확인 주기가 도래한 활성 사이트를 정기적으로 점검
  useEffect(() => {
    if (!autoLoopOn) return;
    const timer = setInterval(async () => {
      try {
        const r = await fetch("/api/monitors/check-due", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forceAll: false }),
        });
        if (r.ok) {
          const d = (await r.json()) as { executedCount: number };
          if (d.executedCount > 0) {
            await loadDashboard();
          }
        }
      } catch {
        // 무시
      }
    }, 25000);
    return () => clearInterval(timer);
  }, [autoLoopOn]);

  async function handleCheckNow(targetId: number, forceAlertTest = false) {
    setBusyId(targetId);
    try {
      const r = await fetch(`/api/monitors/${targetId}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceAlertTest }),
      });
      if (r.ok) {
        const d = (await r.json()) as {
          alertStatus: string;
          conditionMet: boolean;
          result: { summary: string };
        };
        await loadDashboard();
        if (forceAlertTest) {
          showNotice(
            d.alertStatus === "sent"
              ? "실제 데이터로 텔레그램 알림 발송까지 완료했어요."
              : "조건 충족 및 알림 시뮬레이션을 이력에 기록했어요."
          );
        } else {
          showNotice(`즉시 수집 완료: ${d.result.summary.slice(0, 65)}…`);
        }
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleCheckAllActive() {
    setBusyId(-1);
    try {
      await fetch("/api/monitors/check-due", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceAll: true }),
      });
      await loadDashboard();
      showNotice("켜져 있는 모든 감시 사이트를 최신 상태로 조회했어요.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleEnabled(t: MonitorTarget) {
    const nextEnabled = t.enabled ? 0 : 1;
    await fetch(`/api/monitors/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: nextEnabled }),
    });
    await loadDashboard();
    showNotice(`${t.name} 감시를 ${nextEnabled ? "켰어요" : "껐어요"}.`);
  }

  async function handleResetDedup(t: MonitorTarget) {
    await fetch(`/api/monitors/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset_dedup: true }),
    });
    await loadDashboard();
    showNotice("중복 알림 방지 상태를 초기화했어요. 다음 조건 충족 시 다시 알림을 보냅니다.");
  }

  async function handleToggleDayOnTarget(t: MonitorTarget, day: string) {
    const curDays = parseDaysFromSelector(t.selector);
    const exists = curDays.includes(day);
    const nextDays = exists ? curDays.filter(d => d !== day) : [...curDays, day];
    if (nextDays.length === 0) {
      showNotice("최소 한 개 이상의 감시 요일(금·토·일)을 켜 두어야 해요.");
      return;
    }
    const ordered = WEEKEND_DAYS.filter(d => nextDays.includes(d));
    const nextSelector = buildSelectorWithDays(ordered);
    const dayLabel = ordered.join("·") + "요일";
    const baseName = t.name.replace(
      /\s*(금·토·일|금·토|토·일|금·일|금요일|토요일|일요일|[금토일·]+요일)\s*생활관.*$/,
      ""
    );
    const nextName = `${baseName} ${dayLabel} 생활관`;

    setBusyId(t.id);
    try {
      const r = await fetch(`/api/monitors/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName, selector: nextSelector, reset_dedup: true }),
      });
      if (r.ok) {
        await loadDashboard();
        showNotice(`${baseName} 감시 요일을 [${dayLabel}]로 변경하고 즉시 재조회했어요.`);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleBatchSetDays(days: string[]) {
    setBusyId(-2);
    try {
      const r = await fetch("/api/monitors/batch-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      if (r.ok) {
        await loadDashboard();
        showNotice(`전국 10개 생태탐방원 감시 요일을 [${days.join("·")}요일]로 일괄 변경하고 재조회했어요.`);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteTarget(t: MonitorTarget) {
    await fetch(`/api/monitors/${t.id}`, { method: "DELETE" });
    if (selectedTargetId === t.id) setSelectedTargetId(null);
    await loadDashboard();
    showNotice(`'${t.name}' 감시 대상을 삭제했어요.`);
  }

  function openNewTargetForm(preset?: "knps" | "generic") {
    setEditingTarget(null);
    setTestResult(null);
    if (preset === "knps") {
      setFormName("지리산 생태탐방원 (B014003) 토요일 생활관");
      setFormUrl("https://res.knps.or.kr/eco/searchEcoMonthReservation.do?deptId=B014003");
      setFormAdapter("knps-eco");
      setFormSelector("토요일 생활관 잔여 수");
      setFormInterval(5);
      setFormCondOp("gte");
      setFormCondVal("1");
      setFormAuthKey("");
    } else {
      setFormName("");
      setFormUrl("https://");
      setFormAdapter("generic-html");
      setFormSelector("title, h1");
      setFormInterval(10);
      setFormCondOp("contains");
      setFormCondVal("예약");
      setFormAuthKey("");
    }
    setShowAddForm(true);
  }

  function openEditTargetForm(t: MonitorTarget) {
    setEditingTarget(t);
    setTestResult(null);
    setFormName(t.name);
    setFormUrl(t.url);
    setFormAdapter(t.adapter_type);
    setFormSelector(t.selector);
    setFormInterval(t.interval_min);
    setFormCondOp(t.condition_op);
    setFormCondVal(t.condition_val);
    setFormAuthKey(t.auth_env_key);
    setShowAddForm(true);
  }

  async function handleTestConnection() {
    if (!formUrl.trim()) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const r = await fetch("/api/monitors/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: formUrl,
          adapter_type: formAdapter,
          selector: formSelector,
          condition_op: formCondOp,
          condition_val: formCondVal,
          auth_env_key: formAuthKey,
        }),
      });
      const d = (await r.json()) as {
        result?: {
          status: string;
          extractedValue: string;
          summary: string;
          durationMs: number;
          errorMessage?: string;
        };
        error?: string;
      };
      if (d.result) {
        setTestResult(d.result);
      } else {
        setTestResult({
          status: "error",
          extractedValue: "오류",
          summary: d.error || "연결 테스트에 실패했어요.",
          durationMs: 0,
        });
      }
    } finally {
      setTestBusy(false);
    }
  }

  async function handleSaveTarget(e: FormEvent) {
    e.preventDefault();
    const payload = {
      name: formName,
      url: formUrl,
      adapter_type: formAdapter,
      selector: formSelector,
      interval_min: formInterval,
      condition_op: formCondOp,
      condition_val: formCondVal,
      auth_env_key: formAuthKey,
      enabled: editingTarget ? editingTarget.enabled : 1,
    };

    if (editingTarget) {
      const r = await fetch(`/api/monitors/${editingTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        setShowAddForm(false);
        await loadDashboard();
        showNotice(`'${formName}' 설정을 저장했어요.`);
      }
    } else {
      const r = await fetch("/api/monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const d = (await r.json()) as { target?: MonitorTarget };
        setShowAddForm(false);
        await loadDashboard();
        if (d.target) setSelectedTargetId(d.target.id);
        showNotice(`'${formName}' 감시 사이트를 추가하고 첫 수집을 마쳤어요.`);
      }
    }
  }

  async function handleTestTelegram() {
    setTgBusy(true);
    setTgFeedback(null);
    try {
      const r = await fetch("/api/telegram/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = (await r.json()) as { ok: boolean; status: string; detail: string };
      setTgFeedback(d.detail);
      showNotice(d.detail);
    } finally {
      setTgBusy(false);
    }
  }

  async function handleClearLogs() {
    await fetch("/api/logs", { method: "DELETE" });
    await loadDashboard();
    showNotice("수집 이력을 비웠어요.");
  }

  const activeCount = targets.filter(t => t.enabled === 1).length;
  const matchedCount = targets.filter(t => t.last_status === "matched").length;
  const errorOrBlockedCount = targets.filter(
    t => t.last_status === "error" || t.last_status === "blocked"
  ).length;

  const primaryKnps =
    targets.find(t => t.id === selectedTargetId) ||
    targets.find(t => t.adapter_type === "knps-eco") ||
    targets[0];

  let parsedDetail: {
    facilityTitle?: string;
    deptId?: string;
    targetDow?: string;
    checkedMonths?: string[];
    totalTargetRemain?: number;
    totalAnyDayRemain?: number;
    targetSlots?: KnpsDaySlot[];
    availableAnyDaySample?: Array<{ useDt: string; dayOfWeek: string; remainCount: number }>;
  } = {};

  if (primaryKnps?.last_detail_json) {
    try {
      parsedDetail = JSON.parse(primaryKnps.last_detail_json);
    } catch {
      parsedDetail = {};
    }
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#111513] text-[#E6ECE8]">
      {/* 상단 고정 알림 토스트 */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 rounded-lg border border-[#2F4538] bg-[#18241D] px-4 py-3 text-sm text-[#D1FAE5] shadow-lg"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[#34D399]" />
          <span>{toast}</span>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-7 md:px-8 md:py-10 space-y-8">
        {/* 헤더 */}
        <header className="flex flex-col gap-5 border-b border-[#232D28] pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-[#86A894]">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#293B31] bg-[#17211C] px-2.5 py-0.5 text-[#6EE7B7]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#34D399]" />
                {isLiveHost ? "배포 사이트 (실제 텔레그램 발송 켜짐)" : "미리보기 안전 모드 (중복 발송 차단됨)"}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-[#26312B] bg-[#161D19] px-2.5 py-0.5 text-[#9BA8A0]">
                <ShieldCheck className="h-3.5 w-3.5 text-[#38BDF8]" />
                CAPTCHA·접근 제한 무우회 원칙 적용
              </span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-[#F3F7F4] md:text-3xl">
              파수꾼 · 개인용 통합 웹사이트 모니터링 관제소
            </h1>
            <p className="max-w-3xl text-sm text-[#9BA8A0]">
              일반 웹페이지는 공통 HTML 수집기로, 국립공원 생태탐방원 같은 동적 예약 페이지는 전용 연동 어댑터로 수집합니다.
              조건 충족 시 이전 알림 해시와 대조해 중복 알림을 막고 텔레그램으로 알려줍니다.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setAutoLoopOn(v => !v)}
              className={`inline-flex items-center gap-2 rounded-md border px-3.5 py-2 text-xs font-medium ${
                autoLoopOn
                  ? "border-[#2D4A39] bg-[#192920] text-[#A7F3D0]"
                  : "border-[#2B352F] bg-[#171D1A] text-[#9BA8A0]"
              }`}
            >
              <Clock className="h-3.5 w-3.5" />
              <span>화면 열림 중 주기 자동점검: {autoLoopOn ? "켜짐" : "꺼짐"}</span>
            </button>
            <button
              type="button"
              disabled={busyId === -1}
              onClick={handleCheckAllActive}
              className="inline-flex items-center gap-2 rounded-md border border-[#314139] bg-[#1B2420] px-3.5 py-2 text-xs font-medium text-[#E6ECE8] hover:bg-[#24302A] disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busyId === -1 ? "animate-spin" : ""}`} />
              <span>켜진 사이트 전체 지금 확인</span>
            </button>
            <button
              type="button"
              onClick={() => openNewTargetForm("generic")}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#2E8B57] px-4 py-2 text-xs font-semibold text-white hover:bg-[#27784B]"
            >
              <Plus className="h-4 w-4" />
              <span>새 감시 사이트 추가</span>
            </button>
          </div>
        </header>

        {/* 통합 현황판 요약 지표 4칸 */}
        <section aria-label="통합 현황판 요약" className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          <div className="rounded-lg border border-[#232D28] bg-[#161D19] p-4">
            <div className="flex items-center justify-between text-xs text-[#8D9B93]">
              <span>활성 감시 사이트</span>
              <Activity className="h-4 w-4 text-[#34D399]" />
            </div>
            <p className="mt-2 font-mono text-2xl font-semibold text-[#F3F7F4] tnum">
              {activeCount} <span className="text-sm font-normal text-[#7E8D85]">/ {targets.length}개</span>
            </p>
            <p className="mt-1 text-xs text-[#88968E]">정기 확인 켜짐/꺼짐 개별 제어</p>
          </div>

          <div className="rounded-lg border border-[#232D28] bg-[#161D19] p-4">
            <div className="flex items-center justify-between text-xs text-[#8D9B93]">
              <span>조건 충족 (알림 대상)</span>
              <Bell className="h-4 w-4 text-[#38BDF8]" />
            </div>
            <p className="mt-2 font-mono text-2xl font-semibold text-[#38BDF8] tnum">
              {matchedCount} <span className="text-sm font-normal text-[#7E8D85]">건</span>
            </p>
            <p className="mt-1 text-xs text-[#88968E]">동일 상태 해시 중복 발송 차단</p>
          </div>

          <div className="rounded-lg border border-[#232D28] bg-[#161D19] p-4">
            <div className="flex items-center justify-between text-xs text-[#8D9B93]">
              <span>오류 · 접근 제한 감지</span>
              <AlertTriangle className="h-4 w-4 text-[#FBBF24]" />
            </div>
            <p className="mt-2 font-mono text-2xl font-semibold text-[#F3F7F4] tnum">
              {errorOrBlockedCount} <span className="text-sm font-normal text-[#7E8D85]">건</span>
            </p>
            <p className="mt-1 text-xs text-[#88968E]">CAPTCHA 감지 시 우회 없이 즉시 중단</p>
          </div>

          <div className="rounded-lg border border-[#232D28] bg-[#161D19] p-4">
            <div className="flex items-center justify-between text-xs text-[#8D9B93]">
              <span>텔레그램 · 보안 인증 연결</span>
              <KeyRound className="h-4 w-4 text-[#A7F3D0]" />
            </div>
            <p className="mt-2 text-base font-semibold text-[#F3F7F4]">
              {integrations.telegramConfigured ? (
                <span className="text-[#34D399]">텔레그램 연결됨</span>
              ) : (
                <span className="text-[#FBBF24]">텔레그램 키 대기 중</span>
              )}
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                disabled={tgBusy}
                onClick={handleTestTelegram}
                className="inline-flex items-center gap-1 rounded border border-[#2E3D35] bg-[#1C2621] px-2.5 py-1 text-xs text-[#D1E0D7] hover:bg-[#25332C]"
              >
                <Send className="h-3 w-3" />
                <span>{tgBusy ? "발송 중…" : "텔레그램 연결 테스트"}</span>
              </button>
            </div>
          </div>
        </section>

        {/* 첫 대상 검증 카드: 국립공원 생태탐방원 (B971002) 실시간 조회 검증 리포트 */}
        {primaryKnps && primaryKnps.adapter_type === "knps-eco" && (
          <section
            aria-label="첫 대상 실제 데이터 조회 검증 결과"
            className="rounded-xl border border-[#293B32] bg-[#151D19] p-5 md:p-6"
          >
            <div className="flex flex-col justify-between gap-4 border-b border-[#223029] pb-4 lg:flex-row lg:items-center">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-[#1E3A2B] px-2.5 py-0.5 text-xs font-semibold text-[#6EE7B7]">
                    생태탐방원 실시간 조회 검증 완료
                  </span>
                  <span className="font-mono text-xs text-[#88968E]">
                    deptId={parsedDetail.deptId || "B971002"} · Checked {parsedDetail.checkedMonths?.join(", ")}
                  </span>
                </div>
                <h2 className="text-lg font-semibold text-[#F3F7F4]">
                  {primaryKnps.name} — 실시간 월간 달력 &amp; 객실별 잔여 현황
                </h2>
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {targets
                    .filter(t => t.adapter_type === "knps-eco")
                    .map(t => {
                      const shortName = t.name.split(" ")[0];
                      const isSel = primaryKnps.id === t.id;
                      const hasRem = Number(t.last_value) >= 1;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setSelectedTargetId(t.id)}
                          className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                            isSel
                              ? "border-[#34D399] bg-[#1D3529] text-white"
                              : hasRem
                              ? "border-[#2D5A43] bg-[#162920] text-[#6EE7B7]"
                              : "border-[#25312B] bg-[#131916] text-[#9BA8A0] hover:text-[#E6ECE8]"
                          }`}
                        >
                          {shortName}{" "}
                          <span className="font-mono text-[11px] opacity-90">
                            ({t.last_value || "0"})
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busyId === primaryKnps.id}
                  onClick={() => handleCheckNow(primaryKnps.id, false)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#304439] bg-[#1C2822] px-3 py-2 text-xs font-medium text-[#E6ECE8] hover:bg-[#24342C] disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busyId === primaryKnps.id ? "animate-spin" : ""}`} />
                  <span>실시간 재조회</span>
                </button>
                <button
                  type="button"
                  disabled={busyId === primaryKnps.id}
                  onClick={() => handleCheckNow(primaryKnps.id, true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#2A4B5C] bg-[#162933] px-3 py-2 text-xs font-medium text-[#7DD3FC] hover:bg-[#1D3542] disabled:opacity-50"
                >
                  <Bell className="h-3.5 w-3.5" />
                  <span>조건 충족 알림 시뮬레이션</span>
                </button>
                <a
                  href={primaryKnps.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-[#2B3630] bg-[#18201C] px-3 py-2 text-xs text-[#B5C4BC] hover:text-white"
                >
                  <span>원본 사이트 열기</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>

            {/* 감시 요일(금·토·일) 선택 및 10개 탐방원 일괄 변경 바 */}
            <div className="mt-4 flex flex-col justify-between gap-3 rounded-lg border border-[#24332B] bg-[#121915] px-4 py-3 sm:flex-row sm:items-center">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-[#A7F3D0]">
                  현재 탐방원 감시 요일 (복수 선택 가능):
                </span>
                <div className="inline-flex items-center gap-1.5">
                  {WEEKEND_DAYS.map(day => {
                    const activeDays = parseDaysFromSelector(primaryKnps.selector);
                    const isOn = activeDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        disabled={busyId === primaryKnps.id}
                        onClick={() => handleToggleDayOnTarget(primaryKnps, day)}
                        className={`rounded-md border px-3 py-1 text-xs font-semibold transition-colors ${
                          isOn
                            ? "border-[#34D399] bg-[#1F4231] text-white"
                            : "border-[#2B3731] bg-[#171F1B] text-[#88968E] hover:text-[#DCE5DF]"
                        }`}
                      >
                        {day}요일 {isOn ? "✓" : ""}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-[#88968E]">10개 탐방원 일괄 적용:</span>
                {[
                  { label: "토만", days: ["토"] },
                  { label: "금·토", days: ["금", "토"] },
                  { label: "토·일", days: ["토", "일"] },
                  { label: "금·토·일 전체", days: ["금", "토", "일"] },
                ].map(preset => (
                  <button
                    key={preset.label}
                    type="button"
                    disabled={busyId === -2}
                    onClick={() => handleBatchSetDays(preset.days)}
                    className="rounded border border-[#2B3B33] bg-[#19241E] px-2.5 py-1 text-xs text-[#C4D4CC] hover:border-[#34D399] hover:text-white disabled:opacity-50"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="rounded-lg border border-[#232F29] bg-[#121815] p-4 lg:col-span-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-[#B5C4BC]">
                    예약 열린 {parsedDetail.targetDow || "토"}요일 생활관 잔여 현황 ({parsedDetail.targetSlots?.length || 0}일 감지)
                  </h3>
                  <span className="font-mono text-xs text-[#88968E]">
                    최근 확인: {formatKst(primaryKnps.last_checked_at)}
                  </span>
                </div>

                {parsedDetail.targetSlots && parsedDetail.targetSlots.length > 0 ? (
                  <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    {parsedDetail.targetSlots.map(slot => {
                      const hasRemain = slot.remainCount >= 1;
                      return (
                        <div
                          key={slot.useDt}
                          className={`rounded-md border p-3 ${
                            hasRemain
                              ? "border-[#2E6F4E] bg-[#152B21]"
                              : "border-[#222B26] bg-[#161D19]"
                          }`}
                        >
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-mono font-medium text-[#DCE5DF]">
                              {slot.useDt} ({slot.dayOfWeek})
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${
                                hasRemain
                                  ? "bg-[#059669] text-white"
                                  : "bg-[#222B26] text-[#88968E]"
                              }`}
                            >
                              잔여 {slot.remainCount}개
                            </span>
                          </div>
                          {slot.rooms && slot.rooms.length > 0 && (
                            <p className="mt-2 text-[11px] text-[#88968E] line-clamp-2">
                              객실 {slot.rooms.length}개 중{" "}
                              {slot.rooms.filter(r => r.remain > 0).length > 0
                                ? slot.rooms
                                    .filter(r => r.remain > 0)
                                    .map(r => `${r.prdNm}(${r.remain})`)
                                    .join(", ")
                                : "전 객실 예약 마감 (0개)"}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-[#88968E]">조회된 토요일 일정이 없습니다.</p>
                )}
              </div>

              <div className="rounded-lg border border-[#232F29] bg-[#121815] p-4 flex flex-col justify-between">
                <div>
                  <h3 className="text-xs font-semibold text-[#B5C4BC]">
                    평일·일요일 포함 생활관 잔여 참고 데이터
                  </h3>
                  <p className="mt-1 text-xs text-[#88968E]">
                    토요일은 현재 잔여 0개이나, 실제 파서가 정상 동작하는지 증명하기 위해 함께 수집된 잔여 호실 일정입니다.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {parsedDetail.availableAnyDaySample?.map(item => (
                      <span
                        key={item.useDt}
                        className="rounded border border-[#26382E] bg-[#17231C] px-2 py-1 font-mono text-xs text-[#A7F3D0]"
                      >
                        {item.useDt.slice(5)}({item.dayOfWeek}): <b>{item.remainCount}개</b>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="mt-4 border-t border-[#202924] pt-3 text-xs text-[#9BA8A0]">
                  알림 조건: <strong className="text-[#F3F7F4]">토요일 생활관 잔여 수 &gt;= 1</strong>일 때 텔레그램 즉시 발송
                </div>
              </div>
            </div>
          </section>
        )}

        {/* 사이트 추가/수정 모달 성격의 드로어 카드 */}
        {showAddForm && (
          <section
            aria-label="감시 사이트 설정 폼"
            className="rounded-xl border border-[#32473B] bg-[#161F1A] p-5 md:p-6 shadow-xl"
          >
            <div className="flex flex-col justify-between gap-3 border-b border-[#25332B] pb-4 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-base font-semibold text-[#F3F7F4]">
                  {editingTarget ? `감시 사이트 수정 · ${editingTarget.name}` : "새 감시 사이트 등록"}
                </h2>
                <p className="text-xs text-[#9BA8A0]">
                  일반 웹페이지는 공통 HTML 선택자로, 국립공원 생태탐방원은 전용 연동 어댑터로 설정할 수 있습니다.
                </p>
              </div>
              {!editingTarget && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => openNewTargetForm("knps")}
                    className="rounded border border-[#2D4437] bg-[#1D2C24] px-2.5 py-1 text-xs text-[#A7F3D0] hover:bg-[#24382D]"
                  >
                    국립공원 생태탐방원 프리셋 채우기
                  </button>
                </div>
              )}
            </div>

            <form onSubmit={handleSaveTarget} className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="grid gap-1.5 text-xs">
                <span className="font-medium text-[#D0DCD5]">사이트 이름 *</span>
                <input
                  required
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="예: 북한산 생태탐방원 (B971002) 토요일 생활관"
                  className="rounded border border-[#2B3831] bg-[#111613] px-3 py-2 text-sm text-[#F3F7F4]"
                />
              </label>

              <label className="grid gap-1.5 text-xs">
                <span className="font-medium text-[#D0DCD5]">수집 방식 (공통 수집기 / 사이트별 연동) *</span>
                <select
                  value={formAdapter}
                  onChange={e => {
                    const next = e.target.value as "knps-eco" | "generic-html" | "json-api";
                    setFormAdapter(next);
                    if (next === "knps-eco" && !formUrl.includes("knps.or.kr")) {
                      setFormUrl("https://res.knps.or.kr/eco/searchEcoMonthReservation.do?deptId=B971002");
                      setFormSelector("토요일 생활관 잔여 수");
                      setFormCondOp("gte");
                      setFormCondVal("1");
                    }
                  }}
                  className="rounded border border-[#2B3831] bg-[#111613] px-3 py-2 text-sm text-[#F3F7F4]"
                >
                  <option value="generic-html">공통 수집기 · 일반 웹페이지 (CSS 선택자/키워드)</option>
                  <option value="knps-eco">사이트별 전용 연동 · 국립공원 생태탐방원 (월간 달력/호실)</option>
                  <option value="json-api">사이트별 연동 · 동적 JSON API 응답 경로</option>
                </select>
              </label>

              <div className="grid gap-1.5 text-xs md:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-[#D0DCD5]">대상 URL *</span>
                  {formAdapter === "knps-eco" && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-[#88968E]">탐방원 빠른 선택:</span>
                      {KNPS_DEPTS.slice(0, 5).map(d => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => {
                            setFormUrl(
                              `https://res.knps.or.kr/eco/searchEcoMonthReservation.do?deptId=${d.id}`
                            );
                            setFormName(`${d.name} (${d.id}) 토요일 생활관`);
                          }}
                          className="rounded border border-[#2B3831] bg-[#19231E] px-2 py-0.5 text-[11px] text-[#B5C4BC] hover:text-white"
                        >
                          {d.name.replace(" 생태탐방원", "")}({d.id})
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input
                  required
                  value={formUrl}
                  onChange={e => setFormUrl(e.target.value)}
                  placeholder="https://..."
                  className="rounded border border-[#2B3831] bg-[#111613] px-3 py-2 font-mono text-sm text-[#F3F7F4]"
                />
              </div>

              <div className="grid gap-1.5 text-xs">
                <span className="font-medium text-[#D0DCD5]">
                  {formAdapter === "knps-eco"
                    ? "감시 요일 선택 (금·토·일 복수 선택 가능)"
                    : formAdapter === "json-api"
                    ? "JSON 속성 경로 (예: data.remainCount)"
                    : "수집 항목 (CSS 선택자 또는 키워드)"}
                </span>
                {formAdapter === "knps-eco" ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {WEEKEND_DAYS.map(day => {
                        const cur = parseDaysFromSelector(formSelector);
                        const isOn = cur.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => {
                              const next = isOn
                                ? cur.filter(d => d !== day)
                                : [...cur, day];
                              if (next.length === 0) return;
                              setFormSelector(buildSelectorWithDays(next));
                            }}
                            className={`rounded border px-3 py-1.5 text-xs font-semibold transition-colors ${
                              isOn
                                ? "border-[#34D399] bg-[#1F4231] text-white"
                                : "border-[#2B3831] bg-[#141A17] text-[#88968E]"
                            }`}
                          >
                            {day}요일 {isOn ? "✓" : ""}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => setFormSelector(buildSelectorWithDays(["금", "토", "일"]))}
                        className="rounded border border-[#2B3831] bg-[#19231E] px-2.5 py-1.5 text-xs text-[#B5C4BC] hover:text-white"
                      >
                        금·토·일 모두 선택
                      </button>
                    </div>
                    <input
                      value={formSelector}
                      onChange={e => setFormSelector(e.target.value)}
                      className="w-full rounded border border-[#2B3831] bg-[#111613] px-3 py-1.5 font-mono text-xs text-[#B5C4BC]"
                    />
                  </div>
                ) : (
                  <input
                    value={formSelector}
                    onChange={e => setFormSelector(e.target.value)}
                    placeholder="예: .remain-count, #status, title"
                    className="rounded border border-[#2B3831] bg-[#111613] px-3 py-2 text-sm text-[#F3F7F4]"
                  />
                )}
              </div>

              <label className="grid gap-1.5 text-xs">
                <span className="font-medium text-[#D0DCD5]">확인 주기 (분 단위) *</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  required
                  value={formInterval}
                  onChange={e => setFormInterval(Number(e.target.value))}
                  className="rounded border border-[#2B3831] bg-[#111613] px-3 py-2 font-mono text-sm text-[#F3F7F4]"
                />
              </label>

              <label className="grid gap-1.5 text-xs">
                <span className="font-medium text-[#D0DCD5]">알림 조건 비교 방식 *</span>
                <select
                  value={formCondOp}
                  onChange={e =>
                    setFormCondOp(e.target.value as "gte" | "gt" | "eq" | "contains" | "changed")
                  }
                  className="rounded border border-[#2B3831] bg-[#111613] px-3 py-2 text-sm text-[#F3F7F4]"
                >
                  <option value="gte">숫자 이상 (&gt;=)</option>
                  <option value="gt">숫자 초과 (&gt;)</option>
                  <option value="eq">값 일치 (==)</option>
                  <option value="contains">특정 텍스트 포함</option>
                  <option value="changed">직전 수집값과 달라짐</option>
                </select>
              </label>

              <label className="grid gap-1.5 text-xs">
                <span className="font-medium text-[#D0DCD5]">알림 기준값 *</span>
                <input
                  required={formCondOp !== "changed"}
                  value={formCondVal}
                  onChange={e => setFormCondVal(e.target.value)}
                  placeholder="예: 1 (토요일 잔여 1개 이상)"
                  className="rounded border border-[#2B3831] bg-[#111613] px-3 py-2 font-mono text-sm text-[#F3F7F4]"
                />
              </label>

              <label className="grid gap-1.5 text-xs md:col-span-2">
                <span className="font-medium text-[#D0DCD5]">
                  보안 인증 환경변수 이름 (선택 · 비밀번호/쿠키를 DB에 평문 저장하지 않고 환경변수 참조)
                </span>
                <input
                  value={formAuthKey}
                  onChange={e => setFormAuthKey(e.target.value)}
                  placeholder="비워두면 공개 조회 · 로그인이 필요하면 예: SITE_AUTH_COOKIE"
                  className="rounded border border-[#2B3831] bg-[#111613] px-3 py-2 font-mono text-sm text-[#F3F7F4]"
                />
              </label>

              {/* 연결 테스트 결과 상자 */}
              {testResult && (
                <div className="rounded-lg border border-[#2C3E34] bg-[#111714] p-3.5 text-xs md:col-span-2">
                  <div className="flex items-center justify-between font-medium">
                    <span className="text-[#A7F3D0]">
                      연결 테스트 결과 ({testResult.status.toUpperCase()} · {testResult.durationMs}ms)
                    </span>
                    <span className="font-mono text-[#38BDF8]">
                      추출값: {testResult.extractedValue}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[#D0DCD5]">{testResult.summary}</p>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#25332B] pt-4 md:col-span-2">
                <button
                  type="button"
                  disabled={testBusy || !formUrl.trim()}
                  onClick={handleTestConnection}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#30473A] bg-[#1B2921] px-3.5 py-2 text-xs font-medium text-[#A7F3D0] hover:bg-[#22352A] disabled:opacity-50"
                >
                  <Wifi className="h-3.5 w-3.5" />
                  <span>{testBusy ? "실제 페이지 연결 테스트 중…" : "저장 전 연결 및 파싱 테스트"}</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="rounded-md border border-[#2B3630] bg-[#18201C] px-4 py-2 text-xs text-[#B5C4BC]"
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    className="rounded-md bg-[#2E8B57] px-4 py-2 text-xs font-semibold text-white hover:bg-[#267649]"
                  >
                    {editingTarget ? "변경사항 저장" : "사이트 등록 및 첫 수집 실행"}
                  </button>
                </div>
              </div>
            </form>
          </section>
        )}

        {/* 감시 대상 사이트 목록 + 우측 이력 및 보안 안내 */}
        <div className="grid gap-6 lg:grid-cols-12">
          {/* 좌측 7컬럼: 등록된 사이트 카드 목록 */}
          <section className="min-w-0 space-y-3.5 lg:col-span-7">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-[#F3F7F4]">
                감시 사이트 목록 ({targets.length})
              </h2>
              <span className="text-xs text-[#88968E]">
                카드를 눌러 상세 설정·연결 테스트·개별 ON/OFF 제어
              </span>
            </div>

            {loading ? (
              <div className="rounded-lg border border-[#232D28] bg-[#161D19] p-8 text-center text-sm text-[#88968E]">
                감시 대상과 실시간 조회 결과를 불러오고 있어요…
              </div>
            ) : (
              <div className="space-y-3">
                {targets.map(t => {
                  const isBusy = busyId === t.id;
                  const statusBadge =
                    t.last_status === "matched"
                      ? { label: "조건 충족 (알림 대상)", cls: "bg-[#065F46] text-[#A7F3D0]" }
                      : t.last_status === "ok"
                      ? { label: "정상 수집 완료", cls: "bg-[#1E2E26] text-[#86EFAC]" }
                      : t.last_status === "blocked"
                      ? { label: "접근제한·CAPTCHA 중단", cls: "bg-[#451A1A] text-[#FCA5A5]" }
                      : t.last_status === "error"
                      ? { label: "수집 오류", cls: "bg-[#422006] text-[#FDE68A]" }
                      : { label: "대기 중", cls: "bg-[#222925] text-[#9BA8A0]" };

                  return (
                    <article
                      key={t.id}
                      className={`rounded-xl border p-5 transition-colors ${
                        selectedTargetId === t.id
                          ? "border-[#355443] bg-[#17211C]"
                          : "border-[#232D28] bg-[#151B18]"
                      }`}
                    >
                      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${statusBadge.cls}`}>
                              {statusBadge.label}
                            </span>
                            <span className="rounded border border-[#2A3830] bg-[#141A17] px-2 py-0.5 text-[11px] text-[#9BA8A0]">
                              {ADAPTER_LABELS[t.adapter_type] || t.adapter_type}
                            </span>
                            {t.last_alert_hash && (
                              <span className="rounded border border-[#284252] bg-[#14232C] px-2 py-0.5 text-[11px] text-[#7DD3FC]">
                                중복 알림 방지 해시 잠금됨
                              </span>
                            )}
                          </div>
                          <h3 className="text-base font-semibold text-[#F3F7F4]">{t.name}</h3>
                          <a
                            href={t.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-xs text-[#88968E] hover:text-[#D0DCD5] break-all"
                          >
                            <span>{t.url}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                        </div>

                        {/* 켜기/끄기 스위치 */}
                        <div className="flex items-center gap-2 self-start">
                          <button
                            type="button"
                            onClick={() => handleToggleEnabled(t)}
                            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                              t.enabled
                                ? "bg-[#2E8B57] text-white"
                                : "border border-[#2E3833] bg-[#1A201D] text-[#88968E]"
                            }`}
                          >
                            {t.enabled ? "감시 켜짐 (ON)" : "감시 꺼짐 (OFF)"}
                          </button>
                        </div>
                      </div>

                      {/* 설정 요약 그리드 */}
                      <div className="mt-4 grid grid-cols-2 gap-2.5 rounded-lg border border-[#202A25] bg-[#121714] p-3 text-xs sm:grid-cols-4">
                        <div>
                          <span className="text-[#7E8D85]">
                            {t.adapter_type === "knps-eco" ? "감시 요일 (금·토·일)" : "수집 항목"}
                          </span>
                          {t.adapter_type === "knps-eco" ? (
                            <div className="mt-1 flex items-center gap-1">
                              {WEEKEND_DAYS.map(day => {
                                const activeDays = parseDaysFromSelector(t.selector);
                                const isOn = activeDays.includes(day);
                                return (
                                  <button
                                    key={day}
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => handleToggleDayOnTarget(t, day)}
                                    className={`rounded border px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                                      isOn
                                        ? "border-[#34D399] bg-[#1D3E2E] text-white"
                                        : "border-[#28332D] bg-[#161C19] text-[#7E8D85] hover:text-[#DCE5DF]"
                                    }`}
                                    title={`${day}요일 감시 켜기/끄기`}
                                  >
                                    {day}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="mt-0.5 font-medium text-[#DCE5DF] truncate" title={t.selector}>
                              {t.selector}
                            </p>
                          )}
                        </div>
                        <div>
                          <span className="text-[#7E8D85]">확인 주기</span>
                          <p className="mt-0.5 font-mono font-medium text-[#DCE5DF]">
                            {t.interval_min}분마다
                          </p>
                        </div>
                        <div>
                          <span className="text-[#7E8D85]">알림 조건</span>
                          <p className="mt-0.5 font-mono font-medium text-[#A7F3D0]">
                            {CONDITION_LABELS[t.condition_op] || t.condition_op} {t.condition_val}
                          </p>
                        </div>
                        <div>
                          <span className="text-[#7E8D85]">최근 추출값</span>
                          <p className="mt-0.5 font-mono font-semibold text-[#38BDF8]">
                            {t.last_value || "-"}
                          </p>
                        </div>
                      </div>

                      {/* 최근 결과 요약 또는 오류 표시 */}
                      <div className="mt-3 text-xs">
                        {t.last_error ? (
                          <div className="rounded border border-[#522525] bg-[#261414] px-3 py-2 text-[#FCA5A5]">
                            <strong>오류/제한 내역:</strong> {t.last_error}
                          </div>
                        ) : (
                          <p className="text-[#B5C4BC] leading-relaxed">
                            {t.last_summary || "아직 수집된 요약이 없습니다."}
                          </p>
                        )}
                      </div>

                      {/* 하단 액션 바 */}
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[#202A25] pt-3 text-xs">
                        <span className="font-mono text-[11px] text-[#7E8D85]">
                          마지막 확인: {formatKst(t.last_checked_at)}
                        </span>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleCheckNow(t.id, false)}
                            className="inline-flex items-center gap-1 rounded border border-[#2D3E35] bg-[#1B2620] px-2.5 py-1 text-[#DCE5DF] hover:bg-[#23322A] disabled:opacity-50"
                          >
                            <Play className="h-3 w-3 text-[#34D399]" />
                            <span>{isBusy ? "조회 중…" : "지금 확인"}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditTargetForm(t)}
                            className="inline-flex items-center gap-1 rounded border border-[#2B3530] bg-[#18201C] px-2.5 py-1 text-[#B5C4BC] hover:text-white"
                          >
                            <SlidersHorizontal className="h-3 w-3" />
                            <span>조건·주기 수정</span>
                          </button>
                          {t.last_alert_hash && (
                            <button
                              type="button"
                              onClick={() => handleResetDedup(t)}
                              className="inline-flex items-center gap-1 rounded border border-[#2B3E4A] bg-[#162229] px-2.5 py-1 text-[#7DD3FC]"
                              title="동일 조건일 때 다시 알림을 받도록 중복 방지 해시를 초기화합니다"
                            >
                              <RotateCcw className="h-3 w-3" />
                              <span>중복방지 해제</span>
                            </button>
                          )}
                          {targets.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleDeleteTarget(t)}
                              className="inline-flex items-center gap-1 rounded border border-[#3B2626] bg-[#211616] px-2 py-1 text-[#FCA5A5] hover:bg-[#2E1D1D]"
                              title="삭제"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* 우측 5컬럼: 수집 결과 이력 & 보안/중복방지 원칙 */}
          <aside className="min-w-0 space-y-5 lg:col-span-5">
            {/* 수집 및 알림 결과 이력 */}
            <div className="rounded-xl border border-[#232D28] bg-[#151B18] p-5">
              <div className="flex items-center justify-between border-b border-[#212B26] pb-3">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-[#38BDF8]" />
                  <h2 className="text-base font-semibold text-[#F3F7F4]">
                    수집 결과 및 알림 이력
                  </h2>
                </div>
                {logs.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearLogs}
                    className="text-xs text-[#88968E] hover:text-[#DCE5DF]"
                  >
                    이력 비우기
                  </button>
                )}
              </div>

              {logs.length === 0 ? (
                <p className="py-8 text-center text-xs text-[#88968E]">
                  아직 기록된 수집 이력이 없습니다.
                </p>
              ) : (
                <div className="mt-3 max-h-[500px] space-y-2.5 overflow-y-auto pr-1">
                  {logs.map(log => {
                    const alertBadge =
                      log.alert_status === "sent"
                        ? { text: "텔레그램 발송됨", cls: "bg-[#065F46] text-[#A7F3D0]" }
                        : log.alert_status === "simulated"
                        ? { text: "알림 기록됨(봇 미설정)", cls: "bg-[#1E3A5F] text-[#93C5FD]" }
                        : log.alert_status === "skipped_duplicate"
                        ? { text: "중복 알림 생략됨", cls: "bg-[#28312C] text-[#9BA8A0]" }
                        : log.alert_status === "failed"
                        ? { text: "알림 발송 실패", cls: "bg-[#451A1A] text-[#FCA5A5]" }
                        : null;

                    return (
                      <div
                        key={log.id}
                        className="rounded-lg border border-[#212B26] bg-[#121714] p-3 text-xs space-y-1.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-1">
                          <span className="font-semibold text-[#E6ECE8]">{log.target_name}</span>
                          <span className="font-mono text-[11px] text-[#7E8D85]">
                            {formatKst(log.created_at)} ({log.duration_ms}ms)
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-[#1B2420] px-2 py-0.5 font-mono text-[11px] text-[#38BDF8]">
                            추출값: {log.extracted_value}
                          </span>
                          {log.condition_met === 1 && (
                            <span className="rounded bg-[#193326] px-2 py-0.5 text-[11px] text-[#6EE7B7]">
                              조건 충족
                            </span>
                          )}
                          {alertBadge && (
                            <span className={`rounded px-2 py-0.5 text-[11px] ${alertBadge.cls}`}>
                              {alertBadge.text}
                            </span>
                          )}
                        </div>

                        <p className="text-[#9BA8A0] leading-relaxed">{log.summary}</p>
                        {log.alert_message && (
                          <pre className="mt-1 whitespace-pre-wrap rounded border border-[#23322A] bg-[#151E19] p-2 font-mono text-[11px] text-[#A7F3D0]">
                            {log.alert_message}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 보안 및 운영 원칙 안내 상자 */}
            <div className="rounded-xl border border-[#232D28] bg-[#151B18] p-5 space-y-3 text-xs">
              <h3 className="text-sm font-semibold text-[#F3F7F4]">
                보안·인증 관리 및 준수 사항
              </h3>
              <ul className="space-y-2 text-[#9BA8A0] leading-relaxed">
                <li>
                  • <strong className="text-[#DCE5DF]">텔레그램 알림 설정:</strong>{" "}
                  <code className="text-[#A7F3D0]">TELEGRAM_BOT_TOKEN</code> 과{" "}
                  <code className="text-[#A7F3D0]">TELEGRAM_CHAT_ID</code> 환경 변수에 저장되며, 화면이나 코드에 노출되지 않습니다.
                </li>
                <li>
                  • <strong className="text-[#DCE5DF]">로그인 정보 안전 관리:</strong>{" "}
                  국립공원 월간 현황 조회는 로그인 없이 작동합니다. 로그인이 필요한 타 사이트를 추가할 때는 비밀번호나 세션 쿠키를 DB에 적지 않고 환경 변수 이름(<code className="text-[#A7F3D0]">SITE_AUTH_COOKIE</code>)만 연결합니다.
                </li>
                <li>
                  • <strong className="text-[#DCE5DF]">CAPTCHA·접근 제한 무우회:</strong>{" "}
                  HTTP 403/429 응답이나 보안문자(CAPTCHA)가 감지되면 우회 시도를 하지 않고 즉시 수집을 멈춘 뒤 현황판에 오류 상태로 표시합니다.
                </li>
              </ul>
              {tgFeedback && (
                <div className="rounded border border-[#2C3E34] bg-[#111714] p-2.5 text-[#A7F3D0]">
                  최근 텔레그램 점검 결과: {tgFeedback}
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
