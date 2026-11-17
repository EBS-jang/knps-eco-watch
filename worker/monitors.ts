import { sha256, type Bindings } from "./lib";

export interface MonitorTargetRow {
  id: number;
  name: string;
  url: string;
  adapter_type: string;
  selector: string;
  interval_min: number;
  condition_op: string;
  condition_val: string;
  enabled: number;
  auth_env_key: string;
  last_status: string;
  last_value: string;
  last_summary: string;
  last_detail_json: string;
  last_alert_hash: string;
  last_checked_at: string;
  last_alerted_at: string;
  last_error: string;
  created_at: string;
}

export interface CollectResult {
  status: "ok" | "matched" | "blocked" | "error";
  extractedValue: string;
  numericValue?: number;
  summary: string;
  detail: Record<string, unknown>;
  errorMessage?: string;
  durationMs: number;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * 보안/접근제한/CAPTCHA 페이지 여부를 판별한다.
 * 감지되면 절대 우회 시도나 재시도를 하지 않고 즉시 멈춘다.
 */
export function detectAccessRestriction(status: number, html: string): string | null {
  if (status === 401 || status === 403 || status === 429) {
    return `원본 서버 접근 제한 응답 (HTTP ${status}) — 우회하지 않고 조회를 중단했어요.`;
  }
  const lower = html.toLowerCase();
  if (
    lower.includes("g-recaptcha") ||
    lower.includes("hcaptcha") ||
    lower.includes("cf-chl-bypass") ||
    lower.includes("자동입력방지") ||
    lower.includes("비정상적인 접근") ||
    lower.includes("접속이 차단")
  ) {
    return "원본 페이지에서 보안문자(CAPTCHA) 또는 접근 제한 안내가 감지되어 우회 없이 즉시 중단했어요.";
  }
  return null;
}

export interface KnpsRoomDetail {
  prdNm: string;
  remain: number;
  maxNopCnt: number;
  rsrvtCnt: number;
  saleOpen: boolean;
}

export interface KnpsDaySlot {
  useDt: string;
  yearMonth: string;
  day: string;
  dayOfWeek: string;
  remainCount: number;
  saleState: string;
  calYn: string;
  rooms?: KnpsRoomDetail[];
}

/**
 * 국립공원공단 생태탐방원 월간 현황 HTML에서 달력 셀(.calendar-cell)을 파싱한다.
 */
export function parseKnpsEcoCalendarHtml(html: string, yearMonth: string): {
  facilityTitle: string;
  slots: KnpsDaySlot[];
} {
  const titleMatch = html.match(/<h4\s+class="title">\s*([^<]+?)\s*<\/h4>/i);
  const facilityTitle = titleMatch ? titleMatch[1].trim() : "국립공원 생태탐방원";

  const slots: KnpsDaySlot[] = [];
  const cellRegex = /<div\s+class="calendar-cell([^"]*)"([\s\S]*?)<\/div>/gi;
  let match: RegExpExecArray | null;

  while ((match = cellRegex.exec(html)) !== null) {
    const classAttr = match[1] || "";
    const innerAndAttrs = match[2] || "";
    if (classAttr.includes("disabled") || classAttr.includes("null")) continue;

    const useDtMatch = innerAndAttrs.match(/data-usedt="([^"]+)"/i);
    if (!useDtMatch) continue;
    const useDt = useDtMatch[1].trim();

    const saleMatch = innerAndAttrs.match(/data-prdsalstcd="([^"]*)"/i);
    const calYnMatch = innerAndAttrs.match(/data-calyn="([^"]*)"/i);
    const dayMatch = innerAndAttrs.match(/<span\s+class="day">\s*([^<]+)\s*<\/span>/i);
    const weekMatch = innerAndAttrs.match(/<span\s+class="week">\s*([^<]+)\s*<\/span>/i);

    let remainCount = 0;
    const liRegex = /<li>([\s\S]*?)<\/li>/gi;
    let liMatch: RegExpExecArray | null;
    while ((liMatch = liRegex.exec(innerAndAttrs)) !== null) {
      const liBody = liMatch[1];
      if (liBody.includes("생활관")) {
        const emMatch = liBody.match(/<em>\s*([0-9]+)\s*<\/em>/i);
        if (emMatch) {
          remainCount = Number.parseInt(emMatch[1], 10) || 0;
        }
      }
    }

    const dayOfWeek = weekMatch
      ? weekMatch[1].trim()
      : classAttr.includes("sat")
      ? "토"
      : classAttr.includes("sun")
      ? "일"
      : "";

    slots.push({
      useDt,
      yearMonth,
      day: dayMatch ? dayMatch[1].trim() : useDt.slice(-2),
      dayOfWeek,
      remainCount,
      saleState: saleMatch ? saleMatch[1].trim() : "",
      calYn: calYnMatch ? calYnMatch[1].trim() : "",
    });
  }

  return { facilityTitle, slots };
}

/**
 * selector 문자열에서 감시할 요일 목록을 파싱한다.
 * 예: "요일:금,토 | 생활관 잔여 수" 또는 기존 "토요일 생활관" 등
 */
export function parseTargetDays(selector: string): string[] {
  const match = selector.match(/요일\s*:\s*([월화수목금토일,\s]+)/);
  if (match) {
    const days = match[1]
      .split(",")
      .map(s => s.trim())
      .filter(s => ["월", "화", "수", "목", "금", "토", "일"].includes(s));
    if (days.length > 0) return days;
  }
  const cleaned = selector.replace(/\([^)]*\)/g, " ");
  if (cleaned.includes("평일") || cleaned.includes("전체") || cleaned.includes("day=all")) {
    return ["월", "화", "수", "목", "금", "토", "일"];
  }
  const found: string[] = [];
  if (cleaned.includes("금요일") || cleaned.includes("금·")) found.push("금");
  if (cleaned.includes("토요일") || cleaned.includes("·토") || cleaned.includes("토·")) found.push("토");
  if (cleaned.includes("일요일") || cleaned.includes("·일")) found.push("일");
  return found.length > 0 ? found : ["토"];
}

/**
 * 국립공원 생태탐방원 전용 어댑터 (knps-eco)
 * 당월 및 익월 달력을 조회하고, 선택된 요일(금·토·일 복수 선택 가능) 생활관 잔여 수를 집계하며
 * 예약 열림 상태인 대상 요일의 객실 타입별 잔여 상세 API까지 함께 조회한다.
 */
export async function collectKnpsEco(
  target: MonitorTargetRow,
  authHeaderCookie?: string
): Promise<CollectResult> {
  const started = Date.now();
  try {
    const parsedUrl = new URL(target.url);
    const deptId = parsedUrl.searchParams.get("deptId") || "B971002";

    const targetDays = parseTargetDays(target.selector);
    const targetDow = targetDays.length === 7 ? "전체" : targetDays.join("·");

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
    };
    if (authHeaderCookie) {
      headers.Cookie = authHeaderCookie;
    }

    // 1. 기본 페이지(당월) GET 조회
    const firstResp = await fetch(
      `https://res.knps.or.kr/eco/searchEcoMonthReservation.do?deptId=${encodeURIComponent(deptId)}`,
      { method: "GET", headers }
    );
    const firstHtml = await firstResp.text();
    const restricted = detectAccessRestriction(firstResp.status, firstHtml);
    if (restricted) {
      return {
        status: "blocked",
        extractedValue: "접근 제한",
        summary: restricted,
        detail: { httpStatus: firstResp.status, deptId },
        errorMessage: restricted,
        durationMs: Date.now() - started,
      };
    }
    if (!firstResp.ok) {
      return {
        status: "error",
        extractedValue: `HTTP ${firstResp.status}`,
        summary: `국립공원 예약 페이지 응답 오류 (HTTP ${firstResp.status})`,
        detail: { httpStatus: firstResp.status, deptId },
        errorMessage: `HTTP ${firstResp.status}`,
        durationMs: Date.now() - started,
      };
    }

    // 현재 달력 연/월 파악
    const yearInputMatch = firstHtml.match(/name="year"\s+id="year"\s+value="([0-9]{4})"/i);
    const monthInputMatch = firstHtml.match(/name="month"\s+id="month"\s+value="([0-9]{1,2})"/i);
    const curYear = yearInputMatch ? Number.parseInt(yearInputMatch[1], 10) : new Date().getFullYear();
    const curMonth = monthInputMatch ? Number.parseInt(monthInputMatch[1], 10) : new Date().getMonth() + 1;
    const curYm = `${curYear}-${String(curMonth).padStart(2, "0")}`;

    const firstParsed = parseKnpsEcoCalendarHtml(firstHtml, curYm);
    const allSlots: KnpsDaySlot[] = [...firstParsed.slots];

    // 2. 익월 달력도 함께 POST 조회하여 월말/익월 일정까지 놓치지 않고 감시
    const nextYear = curMonth === 12 ? curYear + 1 : curYear;
    const nextMonth = curMonth === 12 ? 1 : curMonth + 1;
    const nextYm = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;

    try {
      const nextBody = new URLSearchParams({
        deptId,
        year: String(nextYear),
        month: String(nextMonth).padStart(2, "0"),
        ctgType: "01",
      });
      const nextResp = await fetch("https://res.knps.or.kr/eco/searchEcoMonthReservation.do", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: nextBody.toString(),
      });
      if (nextResp.ok) {
        const nextHtml = await nextResp.text();
        if (!detectAccessRestriction(nextResp.status, nextHtml)) {
          const nextParsed = parseKnpsEcoCalendarHtml(nextHtml, nextYm);
          for (const s of nextParsed.slots) {
            if (!allSlots.some(existing => existing.useDt === s.useDt)) {
              allSlots.push(s);
            }
          }
        }
      }
    } catch {
      // 익월 조회 실패 시 당월 데이터만으로도 정상 처리
    }

    // 예약 가능 기간(calYn === 'Y') 및 선택 요일 필터링
    const activeSlots = allSlots.filter(s => s.calYn === "Y");
    const targetSlots = activeSlots.filter(s =>
      targetDays.length === 7 ? true : targetDays.includes(s.dayOfWeek)
    );

    // 대상 요일 중 잔여석이 있는 날짜 우선으로 최대 3개 날짜 상세 호실 현황 조회
    const detailCandidates = targetSlots
      .filter(s => s.remainCount > 0)
      .concat(targetSlots.filter(s => s.remainCount === 0))
      .slice(0, 3);

    await Promise.all(
      detailCandidates.map(async slot => {
        try {
          const body = new URLSearchParams({
            deptId,
            useDt: slot.useDt,
            ctgType: "01",
          });
          const dResp = await fetch(
            "https://res.knps.or.kr/eco/searchEcoMonthReservationDetail.do",
            {
              method: "POST",
              headers: {
                ...headers,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                Accept: "application/json, text/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
              },
              body: body.toString(),
            }
          );
          if (dResp.ok) {
            const dJson = (await dResp.json()) as {
              livingRoom?: Array<{
                prdNm: string;
                maxNopCnt: number;
                rsrvtCnt: number;
                prdSalStcd: string;
                calYn: string;
              }>;
              lodgeRoom?: Array<{
                prdNm: string;
                maxNopCnt: number;
                rsrvtCnt: number;
                prdSalStcd: string;
                calYn: string;
              }>;
            };
            const list = [...(dJson.livingRoom ?? []), ...(dJson.lodgeRoom ?? [])];
            slot.rooms = list.map(r => {
              const saleOpen = r.prdSalStcd === "N" && r.calYn === "Y";
              const remain = saleOpen ? Math.max(0, (r.maxNopCnt || 0) - (r.rsrvtCnt || 0)) : 0;
              return {
                prdNm: r.prdNm,
                remain,
                maxNopCnt: r.maxNopCnt || 0,
                rsrvtCnt: r.rsrvtCnt || 0,
                saleOpen,
              };
            });
          }
        } catch {
          // 상세 호실 조회 실패는 무시
        }
      })
    );

    const totalTargetRemain = targetSlots.reduce((sum, s) => sum + s.remainCount, 0);
    const availableTargetSlots = targetSlots.filter(s => s.remainCount > 0);
    const totalAnyDayRemain = activeSlots.reduce((sum, s) => sum + s.remainCount, 0);

    const dowLabel = targetDays.length === 7 ? "전체 요일" : `${targetDow}요일`;
    const slotBrief = targetSlots
      .slice(0, 8)
      .map(s => `${s.useDt.slice(5)}(${s.dayOfWeek}) ${s.remainCount}개`)
      .join(", ");

    const summary =
      availableTargetSlots.length > 0
        ? `[${firstParsed.facilityTitle}] 예약 가능한 ${dowLabel} 생활관 잔여 총 ${totalTargetRemain}개 발견! (${availableTargetSlots
            .slice(0, 6)
            .map(s => `${s.useDt.slice(5)}(${s.dayOfWeek}) ${s.remainCount}개`)
            .join(", ")})`
        : `[${firstParsed.facilityTitle}] 조회된 ${dowLabel} ${targetSlots.length}일 모두 잔여 0개 (${slotBrief || "열린 일정 없음"}) · 참고로 전체 요일 잔여는 총 ${totalAnyDayRemain}개`;

    return {
      status: "ok",
      extractedValue: String(totalTargetRemain),
      numericValue: totalTargetRemain,
      summary,
      detail: {
        adapter: "knps-eco",
        deptId,
        facilityTitle: firstParsed.facilityTitle,
        targetDow,
        targetDays,
        checkedMonths: [curYm, nextYm],
        totalTargetRemain,
        totalAnyDayRemain,
        targetSlots,
        availableAnyDaySample: activeSlots
          .filter(s => s.remainCount > 0)
          .slice(0, 8)
          .map(s => ({ useDt: s.useDt, dayOfWeek: s.dayOfWeek, remainCount: s.remainCount })),
      },
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      extractedValue: "오류",
      summary: `국립공원 페이지 조회 중 네트워크/파싱 오류: ${msg}`,
      detail: {},
      errorMessage: msg,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * 일반 웹페이지 공통 수집기 (generic-html) 및 JSON API 수집기 (json-api)
 */
export async function collectGenericPage(
  target: MonitorTargetRow,
  authHeaderCookie?: string
): Promise<CollectResult> {
  const started = Date.now();
  try {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept:
        target.adapter_type === "json-api"
          ? "application/json,text/plain,*/*"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
    };
    if (authHeaderCookie) {
      if (authHeaderCookie.toLowerCase().startsWith("bearer ")) {
        headers.Authorization = authHeaderCookie;
      } else {
        headers.Cookie = authHeaderCookie;
      }
    }

    const resp = await fetch(target.url, { method: "GET", headers });
    const rawText = await resp.text();

    const restricted = detectAccessRestriction(resp.status, rawText);
    if (restricted) {
      return {
        status: "blocked",
        extractedValue: "접근 제한",
        summary: restricted,
        detail: { httpStatus: resp.status, url: target.url },
        errorMessage: restricted,
        durationMs: Date.now() - started,
      };
    }

    if (!resp.ok) {
      return {
        status: "error",
        extractedValue: `HTTP ${resp.status}`,
        summary: `웹페이지 응답 오류 (HTTP ${resp.status})`,
        detail: { httpStatus: resp.status, url: target.url },
        errorMessage: `HTTP ${resp.status}`,
        durationMs: Date.now() - started,
      };
    }

    if (target.adapter_type === "json-api") {
      const data = JSON.parse(rawText) as Record<string, unknown>;
      const pathKeys = target.selector
        .split(".")
        .map(k => k.trim())
        .filter(Boolean);
      let current: unknown = data;
      for (const k of pathKeys) {
        if (current && typeof current === "object" && k in (current as Record<string, unknown>)) {
          current = (current as Record<string, unknown>)[k];
        } else {
          current = undefined;
          break;
        }
      }
      const valStr =
        current === undefined
          ? JSON.stringify(data).slice(0, 120)
          : typeof current === "object"
          ? JSON.stringify(current)
          : String(current);
      const num = Number(valStr.replace(/[^0-9.-]/g, ""));
      return {
        status: "ok",
        extractedValue: valStr.slice(0, 200),
        numericValue: Number.isFinite(num) && valStr.trim() !== "" ? num : undefined,
        summary: `JSON 경로 [${target.selector || "전체"}] 추출값: ${valStr.slice(0, 120)}`,
        detail: {
          adapter: "json-api",
          selector: target.selector,
          extracted: valStr,
        },
        durationMs: Date.now() - started,
      };
    }

    // generic-html: HTMLRewriter 또는 정규식으로 태그/텍스트 추출
    const selector = target.selector.trim() || "title";
    const collectedChunks: string[] = [];

    if (typeof HTMLRewriter !== "undefined") {
      let currentText = "";
      const rewriter = new HTMLRewriter().on(selector, {
        element() {
          if (currentText.trim()) {
            collectedChunks.push(currentText.trim());
            currentText = "";
          }
        },
        text(text) {
          currentText += text.text;
          if (text.lastInTextNode && currentText.trim()) {
            collectedChunks.push(currentText.trim());
            currentText = "";
          }
        },
      });
      await rewriter.transform(new Response(rawText)).text();
      if (currentText.trim()) collectedChunks.push(currentText.trim());
    }

    let extracted = collectedChunks.join(" | ").replace(/\s+/g, " ").trim();
    if (!extracted) {
      // 정규식 폴백 (키워드 주변 또는 title)
      const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const plain = rawText
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const idx = plain.indexOf(selector);
      if (idx >= 0) {
        extracted = plain.slice(Math.max(0, idx - 20), idx + 100);
      } else if (titleMatch) {
        extracted = titleMatch[1].replace(/\s+/g, " ").trim();
      } else {
        extracted = plain.slice(0, 120);
      }
    }

    const firstNumMatch = extracted.match(/-?\d+(\.\d+)?/);
    const numericValue = firstNumMatch ? Number(firstNumMatch[0]) : undefined;

    return {
      status: "ok",
      extractedValue: extracted.slice(0, 200),
      numericValue,
      summary: `선택자 [${selector}] 수집 완료: "${extracted.slice(0, 100)}"`,
      detail: {
        adapter: "generic-html",
        selector,
        matchCount: collectedChunks.length || 1,
        preview: extracted.slice(0, 240),
      },
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      extractedValue: "오류",
      summary: `페이지 수집 실패: ${msg}`,
      detail: {},
      errorMessage: msg,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * 수집된 값과 사용자의 알림 조건을 비교한다.
 */
export function evaluateCondition(
  op: string,
  targetVal: string,
  result: CollectResult,
  previousValue: string
): boolean {
  if (result.status !== "ok") return false;
  const numActual =
    result.numericValue !== undefined
      ? result.numericValue
      : Number(result.extractedValue.replace(/[^0-9.-]/g, ""));
  const numExpected = Number(targetVal);

  switch (op) {
    case "gte":
      return Number.isFinite(numActual) && Number.isFinite(numExpected) && numActual >= numExpected;
    case "gt":
      return Number.isFinite(numActual) && Number.isFinite(numExpected) && numActual > numExpected;
    case "eq":
      if (Number.isFinite(numActual) && Number.isFinite(numExpected) && targetVal.trim() !== "") {
        return numActual === numExpected;
      }
      return result.extractedValue.trim() === targetVal.trim();
    case "contains":
      return (
        result.extractedValue.includes(targetVal) || result.summary.includes(targetVal)
      );
    case "changed":
      return Boolean(previousValue) && previousValue !== result.extractedValue;
    default:
      return false;
  }
}

/**
 * 텔레그램 메시지 발송
 */
export async function sendTelegramAlert(
  botToken: string | undefined,
  chatId: string | undefined,
  message: string
): Promise<{ ok: boolean; status: "sent" | "simulated" | "failed"; detail: string }> {
  const cleanToken = (botToken ?? "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^bot/i, "");
  let cleanChatId = (chatId ?? "").trim().replace(/^['"]|['"]$/g, "");

  if (!cleanToken) {
    return {
      ok: true,
      status: "simulated",
      detail: "텔레그램 봇 토큰이 아직 등록되지 않아 관제소 알림 이력에만 기록했어요.",
    };
  }
  try {
    // 만약 채팅 ID가 비어 있거나 숫자가 아니면 getUpdates 로 가장 최근에 말을 건 대화방 ID를 자동 탐색
    if (!cleanChatId || !/^-?\d+$/.test(cleanChatId)) {
      const upResp = await fetch(`https://api.telegram.org/bot${cleanToken}/getUpdates`);
      if (upResp.ok) {
        const upJson = (await upResp.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: Array<{
            message?: { chat?: { id?: number } };
            my_chat_member?: { chat?: { id?: number } };
            channel_post?: { chat?: { id?: number } };
          }>;
        };
        const updates = upJson.result ?? [];
        for (let i = updates.length - 1; i >= 0; i--) {
          const foundId =
            updates[i].message?.chat?.id ??
            updates[i].my_chat_member?.chat?.id ??
            updates[i].channel_post?.chat?.id;
          if (foundId) {
            cleanChatId = String(foundId);
            break;
          }
        }
      }
    }

    if (!cleanChatId) {
      return {
        ok: false,
        status: "failed",
        detail: "채팅 ID를 찾을 수 없어요. 텔레그램에서 봇(@res_KANP_bot)에게 먼저 아무 메시지나 한 번 보내 주세요.",
      };
    }

    let resp = await fetch(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cleanChatId,
        text: message,
        disable_web_page_preview: false,
      }),
    });
    let data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      error_code?: number;
    };

    // 만약 입력된 채팅 ID로 실패(400 chat not found)했다면 getUpdates 의 실제 채팅 ID로 한 번 더 시도
    if ((!resp.ok || !data.ok) && data.error_code === 400) {
      const upResp = await fetch(`https://api.telegram.org/bot${cleanToken}/getUpdates`);
      if (upResp.ok) {
        const upJson = (await upResp.json().catch(() => ({}))) as {
          result?: Array<{ message?: { chat?: { id?: number } } }>;
        };
        const updates = upJson.result ?? [];
        const fallbackId = updates[updates.length - 1]?.message?.chat?.id;
        if (fallbackId && String(fallbackId) !== cleanChatId) {
          resp = await fetch(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: String(fallbackId),
              text: message,
              disable_web_page_preview: false,
            }),
          });
          data = (await resp.json().catch(() => ({}))) as {
            ok?: boolean;
            description?: string;
            error_code?: number;
          };
        }
      }
    }

    if (resp.ok && data.ok) {
      return { ok: true, status: "sent", detail: "텔레그램 발송 완료 (@res_KANP_bot)" };
    }
    const hint =
      data.error_code === 404
        ? "텔레그램 봇 토큰을 확인해 주세요."
        : data.error_code === 400
        ? "봇에게 먼저 말을 걸어(/start) 대화방을 활성화해 주세요."
        : "";
    return {
      ok: false,
      status: "failed",
      detail: `${data.description || `Telegram HTTP ${resp.status}`}${hint ? ` — ${hint}` : ""}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 단일 감시 대상을 실제로 실행하고 DB 상태/이력 및 중복 방지 해시를 갱신한다.
 */
export async function runMonitorTarget(
  env: Bindings,
  target: MonitorTargetRow,
  options?: { forceAlertTest?: boolean; simulateAlertOnly?: boolean }
) {
  const authCookie =
    target.auth_env_key && typeof env[target.auth_env_key] === "string"
      ? (env[target.auth_env_key] as string)
      : undefined;

  const result =
    target.adapter_type === "knps-eco"
      ? await collectKnpsEco(target, authCookie)
      : await collectGenericPage(target, authCookie);

  // 조회하는 사이에 다른 요청이 이미 상태를 바꿨을 수 있으므로 최신 해시를 DB에서 다시 읽는다.
  const latestRow = await env.DB.prepare(
    "SELECT last_alert_hash, last_alerted_at FROM monitor_targets WHERE id = ?"
  )
    .bind(target.id)
    .first<{ last_alert_hash: string; last_alerted_at: string }>();
  const latestAlertHash = latestRow?.last_alert_hash ?? target.last_alert_hash;
  const latestAlertedAt = latestRow?.last_alerted_at ?? target.last_alerted_at;

  const conditionMet =
    options?.forceAlertTest ||
    evaluateCondition(target.condition_op, target.condition_val, result, target.last_value);

  const finalStatus =
    result.status === "blocked" || result.status === "error"
      ? result.status
      : conditionMet
      ? "matched"
      : "ok";

  // 중복 알림 방지를 위한 상태 고유 해시 계산 (대상ID + 추출값 + 조건충족된 세부 슬롯 요약)
  const slotSignature =
    target.adapter_type === "knps-eco" && Array.isArray(result.detail.targetSlots)
      ? (result.detail.targetSlots as KnpsDaySlot[])
          .filter(s => s.remainCount > 0)
          .map(s => `${s.useDt}:${s.remainCount}`)
          .join(",")
      : result.extractedValue;

  const currentAlertHash = await sha256(`${target.id}|${result.extractedValue}|${slotSignature}`);

  let alertStatus: "none" | "sent" | "skipped_duplicate" | "simulated" | "failed" = "none";
  let alertMessage = "";
  const nowIso = new Date().toISOString();

  if (conditionMet) {
    if (!options?.forceAlertTest && latestAlertHash === currentAlertHash) {
      alertStatus = "skipped_duplicate";
      alertMessage = "직전 알림과 동일한 잔여/추출 상태여서 중복 알림을 방지했어요.";
    } else if (options?.simulateAlertOnly && !options?.forceAlertTest) {
      alertStatus = "simulated";
      alertMessage = [
        `[미리보기 중복발송 차단됨 · 실제 발송은 배포 사이트가 전담]`,
        `🔔 [파수꾼 감지 알림] ${target.name}`,
        `• 상태: 조건 충족 (${target.condition_op} ${target.condition_val})`,
        `• 현재 수집값: ${result.extractedValue}`,
        `• 요약: ${result.summary}`,
      ].join("\n");
    } else {
      alertMessage = [
        `🔔 [파수꾼 감지 알림] ${target.name}`,
        `• 상태: 조건 충족 (${target.condition_op} ${target.condition_val})`,
        `• 현재 수집값: ${result.extractedValue}`,
        `• 요약: ${result.summary}`,
        `• 바로가기: ${target.url}`,
      ].join("\n");

      const tg = await sendTelegramAlert(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, alertMessage);
      alertStatus = tg.status;
      if (tg.status === "failed") {
        alertMessage = `${alertMessage}\n(발송 실패 사유: ${tg.detail})`;
      }
    }
  }

  // 조건이 해제(미충족)되면 다음에 다시 조건이 충족될 때 알림이 가도록 해시를 비운다.
  const nextAlertHash = conditionMet
    ? alertStatus === "sent" || alertStatus === "simulated" || alertStatus === "skipped_duplicate"
      ? currentAlertHash
      : latestAlertHash
    : "";

  const nextAlertedAt =
    alertStatus === "sent" || alertStatus === "simulated" ? nowIso : latestAlertedAt;

  await env.DB.prepare(
    `UPDATE monitor_targets
     SET last_status = ?,
         last_value = ?,
         last_summary = ?,
         last_detail_json = ?,
         last_alert_hash = ?,
         last_checked_at = ?,
         last_alerted_at = ?,
         last_error = ?
     WHERE id = ?`
  )
    .bind(
      finalStatus,
      result.extractedValue,
      result.summary,
      JSON.stringify(result.detail),
      nextAlertHash,
      nowIso,
      nextAlertedAt,
      result.errorMessage || "",
      target.id
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO monitor_logs (
       target_id, target_name, status, extracted_value, summary, detail_json,
       condition_met, alert_status, alert_message, error_message, duration_ms, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      target.id,
      target.name,
      finalStatus,
      result.extractedValue,
      result.summary,
      JSON.stringify(result.detail),
      conditionMet ? 1 : 0,
      alertStatus,
      alertMessage,
      result.errorMessage || "",
      result.durationMs,
      nowIso
    )
    .run();

  const updatedTarget = await env.DB.prepare("SELECT * FROM monitor_targets WHERE id = ?")
    .bind(target.id)
    .first<MonitorTargetRow>();

  return {
    target: updatedTarget,
    result,
    conditionMet,
    alertStatus,
    alertMessage,
  };
}
