/* Naajim 서비스 워커 — 하는 일이 딱 하나다: 안드로이드 '공유' 시트로 넘어온 파일 받기.
 *
 * 왜 필요한가: Web Share Target은 파일을 multipart POST로 보내는데, GitHub Pages 같은 정적
 * 호스팅은 POST를 받을 수 없다. 서비스 워커가 그 요청을 가로채 파일을 캐시에 넣고, 앱을 열어
 * 그 키를 넘겨준다. 서버 없이 스트라바·가민 앱 → Naajim로 파일이 바로 건너온다.
 *
 * 일부러 앱을 캐시하지 않는다. 오프라인 캐싱까지 얹으면 배포한 새 버전이 안 뜨는 사고가
 * 나기 쉽고(이 앱은 한 파일이라 통째로 바뀐다), 지금 얻으려는 건 공유 경로 하나뿐이다.
 * fetch 핸들러는 공유 POST가 아니면 아무 것도 하지 않고 그대로 통과시킨다.
 */
"use strict";

const SHARE_BOX = "ridelens-shared";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* ---------------- 알림 ----------------
   서버는 **본문 없는 푸시**를 보낸다. "깨워라"만 말하고 무슨 말을 할지는 모른다.
   문장은 전부 여기서 만든다:
     · 나에 대한 것(주간 요약·스트릭·목표·계획·정비)은 이 기기의 보관함을 직접 읽어서
     · 친구가 보낸 것은 서버에서 **상용구 번호**만 받아 여기서 문장으로 바꿔서
   그래서 서버는 무슨 말이 뜨는지 모르고, 한국어·영어 전환도 이 기기에서 된다.

   보관함이 비어 있거나 못 읽어도 반드시 하나는 띄운다 — 알림을 안 띄우면 브라우저가
   '조용한 푸시'로 보고 권한을 회수한다(userVisibleOnly 계약). */
const DB = "ridelens";
const API = "https://ridelens-api.hongsgo.workers.dev";

function rides(){
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { if (!done){ done = true; res(v); } };
    setTimeout(() => fin([]), 3000);                       // IndexedDB가 안 열리면 그냥 포기한다
    try {
      const rq = indexedDB.open(DB, 2);
      rq.onerror = () => fin([]);
      rq.onsuccess = () => {
        try {
          const db = rq.result;
          if (!db.objectStoreNames.contains("rides")) return fin([]);
          const g = db.transaction("rides").objectStore("rides").getAll();
          g.onsuccess = () => fin(g.result || []);
          g.onerror = () => fin([]);
        } catch (e) { fin([]); }
      };
      // 알림 때문에 스키마를 만들지는 않는다 — 앱을 한 번도 안 쓴 기기면 그냥 비운다
      rq.onupgradeneeded = () => { try { rq.transaction.abort(); } catch (e) {} fin([]); };
    } catch (e) { fin([]); }
  });
}

/* 앱이 남겨 둔 '알림용 요약'. 스트릭·목표·배지·계획 같은 것은 계산에 설정값이 필요한데
   서비스 워커는 localStorage를 못 본다. 그래서 앱이 열릴 때마다 **숫자만** 여기에 적어 두고
   (문장이 아니라 숫자다 — 문장은 언어 전환 때문에 여기서 만든다) 그걸 읽어 쓴다. */
function snapshot(){
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { if (!done){ done = true; res(v); } };
    setTimeout(() => fin(null), 3000);
    try {
      const rq = indexedDB.open(DB, 2);
      rq.onerror = () => fin(null);
      rq.onsuccess = () => {
        try {
          const db = rq.result;
          if (!db.objectStoreNames.contains("kv")) return fin(null);
          const g = db.transaction("kv").objectStore("kv").get("notify");
          g.onsuccess = () => fin(g.result || null);
          g.onerror = () => fin(null);
        } catch (e) { fin(null); }
      };
      rq.onupgradeneeded = () => { try { rq.transaction.abort(); } catch (e) {} fin(null); };
    } catch (e) { fin(null); }
  });
}

/* 친구가 고른 상용구. 서버에는 **번호만** 오간다 — 문장은 여기 있고, 그래서 서버는 무슨 말이
   뜨는지 모르며 받는 사람의 언어로 나온다. 번호는 절대 재배치하지 말 것(이미 큐에 든 것이
   다른 문장으로 바뀐다). 새 문구는 뒤에 추가만 한다. */
const POKE = [
  { ko: "오늘 한 바퀴 어때요?",            en: "Fancy a ride today?" },
  { ko: "요즘 안 보이시네요",              en: "Haven't seen you out lately" },
  { ko: "주말에 같이 갑시다",              en: "Let's ride this weekend" },
  { ko: "제가 앞서갑니다 🏆",              en: "I'm pulling ahead 🏆" },
  { ko: "날씨 좋은데 나가시죠",            en: "Weather's perfect — let's go" },
  { ko: "이번 주 목표 잊지 않으셨죠?",     en: "Remember your goal this week?" },
  { ko: "한강 어때요?",                    en: "How about a river loop?" },
  { ko: "장비만 닦고 계신 건 아니죠?",     en: "Not just polishing the bike, right?" }
];
const T = (lang, ko, en) => (lang === "en" ? en : ko);
// 알림을 누르면 어디로 갈지 — 계획 브리핑만 그 계획서로 가고 나머지는 앱 첫 화면이다
const openFor = (s) => (s.kind === "plan" && s.plan && s.plan.id) ? `./app.html?plan=${s.plan.id}` : "./app.html";

/* 서버에서 배달 대기 중인 것을 가져온다(읽는 즉시 서버에서 비워진다).
   실패해도 조용히 빈 배열 — 그 경우 아래의 '나에 대한 알림'이 대신 뜬다. */
async function inbox(){
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return [];
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`${API}/api/push/inbox`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }), signal: ctl.signal
    });
    clearTimeout(t);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.items) ? j.items.slice(0, 3) : [];
  } catch (e) { return []; }
}

// 친구가 보낸 것 한 건 → 알림 한 장. 계획 초대는 누르면 그 계획서가 열린다.
function friendMessage(it, lang){
  const who = it.frm || T(lang, "친구", "A friend");
  if (it.kind === "plan")
    return { title: T(lang, `${who}님이 같이 타자고 합니다`, `${who} wants to ride with you`),
             body: T(lang, "계획서를 열어 코스·휴식·보급을 확인해 보세요.", "Open the plan to see the route, stops and supplies."),
             open: it.ref ? `./app.html?plan=${it.ref}` : "./app.html", tag: "ridelens-plan-" + (it.ref || "") };
  const line = POKE[it.tpl] || POKE[0];
  return { title: T(lang, `${who}님이 콕 찔렀습니다`, `${who} poked you`),
           body: T(lang, line.ko, line.en), open: "./app.html", tag: "ridelens-poke" };
}

/* 나에 대한 알림. 앱이 "지금 이걸 알릴 만하다"고 골라 둔 종류(kind)를 그대로 쓴다 —
   무엇이 급한지는 설정·목표를 다 아는 앱이 판단하는 편이 정확하다. 종류가 없으면 주간 요약. */
function selfMessage(snap, list){
  const lang = (snap && snap.lang) === "en" ? "en" : "ko";
  const s = snap || {};
  /* AI 코치 키를 넣어 둔 사람은 그 코치가 미리 써 둔 문장으로 나간다(앱이 열려 있을 때 받아
     둔다 — 여기서는 키를 읽을 수도, LLM을 기다릴 수도 없다). 상황이 그 사이 바뀌었으면
     (aiKind !== kind) 쓰지 않는다 — 지난주 문장이 이번 주에 뜨는 것이 제일 나쁘다. */
  if (s.ai && s.ai.title && s.aiKind === s.kind)
    return { title: s.ai.title, body: s.ai.body || "", open: openFor(s), tag: "ridelens-" + s.kind };
  if (s.kind === "streak" && s.streak && s.streak.n > 0)
    return { title: T(lang, `${s.streak.n}주 연속이 오늘 끊깁니다`, `Your ${s.streak.n}-week streak ends today`),
             body: T(lang, "20분만 타도 이어집니다 — 기록은 자동으로 쌓입니다.", "Twenty minutes keeps it alive."),
             open: "./app.html", tag: "ridelens-streak" };
  if (s.kind === "goal" && s.goal && s.goal.left)
    return { title: T(lang, `${s.goal.label} — ${s.goal.left} 남았어요`, `${s.goal.label} — ${s.goal.left} to go`),
             body: T(lang, "한 번이면 됩니다. 기간이 끝나기 전에 채워 보시죠.", "One ride should do it — before the period ends."),
             open: "./app.html", tag: "ridelens-goal" };
  if (s.kind === "quest" && s.quest && s.quest.left > 0)
    return { title: T(lang, `이번 주 퀘스트 — ${s.quest.left}${s.quest.unit || "km"} 남았습니다`, `Weekly quest — ${s.quest.left}${s.quest.unit || "km"} to go`),
             body: T(lang, `${s.quest.name} · 일요일 자정에 마감됩니다.`, `${s.quest.name} · ends at midnight Sunday.`),
             open: "./app.html", tag: "ridelens-quest" };
  if (s.kind === "rank" && s.rank && s.rank.n)
    return { title: T(lang, `주간 랭킹 ${s.rank.n}위 — 월요일에 0으로 초기화됩니다`, `You're #${s.rank.n} — the board resets on Monday`),
             body: s.rank.gap > 0 ? T(lang, `바로 위까지 ${s.rank.gap}km 남았어요. 한 번만 더 타면 넘습니다.`, `${s.rank.gap} km behind the rider above — one more ride does it.`)
                                  : T(lang, "지금 순위로 이번 주가 마감됩니다.", "This is where you finish the week."),
             open: "./app.html", tag: "ridelens-rank" };
  if (s.kind === "badge" && s.badge && s.badge.name)
    return { title: T(lang, `🏅 ${s.badge.name} 배지가 코앞입니다`, `🏅 Almost got the ${s.badge.name} badge`),
             body: s.badge.need || T(lang, "한 번만 더 타면 됩니다.", "One more ride to go."),
             open: "./app.html", tag: "ridelens-badge" };
  if (s.kind === "plan" && s.plan && s.plan.km)
    return { title: T(lang, `내일 ${s.plan.km}km 라이딩`, `Tomorrow: ${s.plan.km} km`),
             body: T(lang, `물 ${s.plan.water || 2}통 · 보급 ${s.plan.stops || 0}회 예정입니다.`,
                          `${s.plan.water || 2} bottles · ${s.plan.stops || 0} resupply stops.`),
             open: s.plan.id ? `./app.html?plan=${s.plan.id}` : "./app.html", tag: "ridelens-plan" };
  if (s.kind === "care" && s.care && s.care.part)
    return { title: T(lang, `${s.care.part} 관리할 때가 됐습니다`, `Time to service your ${s.care.part}`),
             body: T(lang, `마지막 정비 후 ${s.care.km}km 탔습니다.`, `${s.care.km} km since the last service.`),
             open: "./app.html", tag: "ridelens-care" };
  if (s.kind === "anniv" && s.anniv && s.anniv.km)
    return { title: T(lang, `${s.anniv.years || 1}년 전 오늘, ${s.anniv.km}km`, `${s.anniv.years || 1} year ago today: ${s.anniv.km} km`),
             body: s.anniv.name || T(lang, "그날의 기록이 보관함에 있습니다.", "That ride is still in your library."),
             open: "./app.html", tag: "ridelens-anniv" };
  const m = weeklyMessage(list, lang);
  return { title: m.title, body: m.body, open: "./app.html", tag: "ridelens-weekly" };
}

function weeklyMessage(list, lang){
  const now = Date.now(), DAY = 86400000;
  const t = (ko, en) => (lang === "en" ? en : ko);
  const km = (a) => Math.round(a.reduce((s, r) => s + (((r.stats || {}).distance) || 0), 0) / 1000);
  const inRange = (from, to) => list.filter(r => r.date >= now - from * DAY && r.date < now - to * DAY);
  const thisWeek = inRange(7, 0), lastWeek = inRange(14, 7);
  if (!list.length)
    return { title: t("이번 주 라이딩, 기록해 두셨나요?", "Logged a ride this week?"),
             body: t("파일 하나만 넣으면 3초 뒤에 리포트가 나옵니다.", "Drop one file and the report is ready in 3 seconds.") };
  if (thisWeek.length)
    return { title: t(`이번 주 ${km(thisWeek)}km · ${thisWeek.length}회 타셨어요`, `${km(thisWeek)} km over ${thisWeek.length} rides this week`),
             body: lastWeek.length ? t(`지난주는 ${km(lastWeek)}km였습니다. 주간 랭킹도 확인해 보세요.`, `Last week was ${km(lastWeek)} km. Check the weekly ranking.`)
                                   : t("주간 랭킹은 월요일에 0으로 초기화됩니다.", "The weekly ranking resets on Monday.") };
  if (lastWeek.length)
    return { title: t(`지난주엔 ${km(lastWeek)}km 타셨네요`, `You rode ${km(lastWeek)} km last week`),
             body: t("이번 주는 아직 기록이 없습니다. 주말에 한 번 나가시죠.", "Nothing logged this week yet — how about the weekend?") };
  const last = list.slice().sort((a, b) => (b.date || 0) - (a.date || 0))[0];
  const days = Math.max(1, Math.round((now - (last.date || now)) / DAY));
  return { title: t(`마지막 라이딩이 ${days}일 전이었어요`, `Your last ride was ${days} days ago`),
           body: t("가볍게 한 바퀴 어떠세요. 기록은 그대로 기다리고 있습니다.", "How about an easy loop? Your records are waiting.") };
}

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let shown = 0;
    try {
      const [items, snap] = await Promise.all([inbox(), snapshot()]);
      const lang = (snap && snap.lang) === "en" ? "en" : "ko";
      // 친구가 보낸 것이 먼저다 — 사람이 부른 것을 잔소리 뒤에 세우지 않는다
      for (const it of items) {
        const m = friendMessage(it, lang);
        await show(m); shown++;
      }
      if (!shown) await show(selfMessage(snap, await rides()));
      shown = 1;
    } catch (err) { /* 아래에서 반드시 하나는 띄운다 */ }
    if (!shown) await show({ title: "이번 주 라이딩, 기록해 두셨나요?", body: "파일 하나만 넣으면 3초 뒤에 리포트가 나옵니다.", open: "./app.html", tag: "ridelens-weekly" });
  })());
});

/* 어떤 종류가 실제로 먹히는지 익명으로 센다 — 띄운 수(notifs-)와 눌린 수(notifc-)를 함께 봐야
   클릭률이 나온다. 감으로 알림 종류를 늘리지 않기 위한 것이다. 보내는 것은 종류 이름뿐이고,
   기존 기능 통계와 같은 경로를 쓴다(쓰기 예산 가드도 그대로 적용된다). */
function tally(kind){
  try { fetch(`${API}/api/event`, { method: "POST", body: kind, keepalive: true }).catch(() => {}); } catch (e) {}
}
const kindOf = (tag) => String(tag || "").replace(/^ridelens-?/, "").replace(/[^a-z]/g, "") || "other";

function show(m){
  const tag = m.tag || "ridelens";
  tally("notifs-" + kindOf(tag));
  return self.registration.showNotification("🚴 " + m.title, {
    body: m.body, tag, renotify: false,
    icon: "./logo-icon.png", badge: "./logo-icon.png", data: { open: m.open || "./app.html", kind: kindOf(tag) }
  });
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  tally("notifc-" + ((e.notification.data && e.notification.data.kind) || "other"));
  const to = (e.notification.data && e.notification.data.open) || "./app.html";
  e.waitUntil((async () => {
    const url = new URL(to, self.registration.scope).href;
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (!w.url.startsWith(self.registration.scope) || !("focus" in w)) continue;
      /* 이미 열린 창이 있으면 그걸 앞으로 — 새 탭을 계속 쌓지 않는다. 다만 계획 초대처럼
         **열어야 할 곳이 따로 있는** 알림은 창을 앞으로만 가져오면 아무 일도 안 일어난 것처럼
         보인다(친구가 부른 계획서가 아니라 원래 보던 화면이 뜬다). 그때는 그 주소로 옮긴다. */
      if (url !== w.url && new URL(url).search && "navigate" in w) { try { await w.navigate(url); } catch (e) {} }
      return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  /* 공유로 들어온 POST만 처리한다 — 그 외의 요청은 건드리지 않는다(캐시도, 변형도 없음).
     ⚠ **출처를 반드시 볼 것** (2026-08-04) — 예전에는 경로만 보고 `/share`로 끝나는 POST를
     전부 잡았다. 그래서 앱이 공유 링크를 만들려고 부르는 우리 API(`…workers.dev/api/share`)까지
     이 핸들러가 삼켰고, 여기서 돌려주는 건 303 리다이렉트라 **내비게이션이 아닌 fetch는 통째로
     실패한다**(브라우저가 "Failed to fetch"). 결과는 서비스 워커가 붙은 기기 전부 — 즉 두 번째
     방문부터 모든 사용자 — 에서 **공유 링크 생성이 안 되는** 것이었고, 라이브에서 대조 실험으로
     확인했다(제어 전 200 `{id}` / 제어 후 Failed to fetch).
     share_target 의 action 은 언제나 **같은 출처의 /share** 다(build-deploy.js). 남의 출처와
     `/api/` 아래는 우리 것이 아니므로 손대지 않는다. */
  if (e.request.method !== "POST") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/") || !/\/share\/?$/.test(url.pathname)) return;

  e.respondWith((async () => {
    const to = new URL("app.html", url);
    try {
      const fd = await e.request.formData();
      // 매니페스트의 params.files.name 과 같은 이름. 이름이 달라 오는 클라이언트도 있어 전부 훑는다.
      let files = fd.getAll("file");
      if (!files.length) for (const v of fd.values()) if (v && typeof v === "object" && v.size) files.push(v);
      files = files.filter(f => f && f.size);
      if (!files.length) throw new Error("no files");

      const box = await caches.open(SHARE_BOX);
      const keys = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const name = (f.name || "shared.fit").replace(/[^\w.\-가-힣]/g, "_");
        // 캐시 키는 실제로 존재하지 않아도 되는 경로다 — 앱이 이 키로 다시 꺼낸다
        const key = new URL(`__shared__/${Date.now()}-${i}`, url).href;
        await box.put(key, new Response(f, { headers: { "x-rl-name": encodeURIComponent(name) } }));
        keys.push(key);
      }
      to.searchParams.set("shared", keys.join("|"));
    } catch (err) {
      to.searchParams.set("shared", "err");
    }
    // 303이라야 브라우저가 POST를 GET으로 바꿔 앱을 연다
    return Response.redirect(to.href, 303);
  })());
});
