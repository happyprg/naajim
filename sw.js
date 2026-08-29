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
  { ko: "오늘 한 바퀴 어때요?",            en: "Fancy a session today?" },
  { ko: "요즘 안 보이시네요",              en: "Haven't seen you out lately" },
  { ko: "주말에 같이 갑시다",              en: "Let's go this weekend" },
  { ko: "제가 앞서갑니다 🏆",              en: "I'm pulling ahead 🏆" },
  { ko: "날씨 좋은데 나가시죠",            en: "Weather's perfect — let's go" },
  { ko: "이번 주 목표 잊지 않으셨죠?",     en: "Remember your goal this week?" },
  { ko: "한강 어때요?",                    en: "How about a river loop?" },
  { ko: "장비만 닦고 계신 건 아니죠?",     en: "Not just polishing the gear, right?" }
];
const T = (lang, ko, en) => (lang === "en" ? en : ko);

/* 종목의 말 — **판정은 하지 않는다.** 어느 종목을 하는 사람인지는 앱이 `homeSportK()`로
   정해 스냅샷(`snap.sport`)에 적어 둔다. 여기서 한 번 더 세면 같은 보관함에서 앱과 알림이
   서로 다른 종목을 부르게 된다(잣대는 한 곳, 60번). 값이 없거나 섞어 하는 사람이면 `""`이고
   그때는 종목 중립으로 말한다 — 옛 앱이 적어 둔 스냅샷에도 이 칸이 없으므로 그 길로 온다.
   ⚠️ 여기 문장이 자전거의 말이면 **러너의 잠금 화면에 그대로 뜬다.** 우리는 영영 못 보는
   자리다(52번). 제목 앞의 이모지도 같다 — 여태 무조건 🚴였다. */
const SPORT_W = {
  /* `sub`는 **주격 조사까지 붙인 꼴**이다 — "라이딩이"는 되는데 "달리기이"는 말이 안 된다.
     받침에 따라 이/가가 갈리므로 자리에서 이어 붙이지 않고 통째로 적어 둔다. */
  //     제목 이모지  종목 이름   "…이/가"   "20분만 ~"  "이번 주 ~"   "…km ~"      영문 복수   거리를 m로
  ride: { e:"🚴", ko:"라이딩", en:"ride",    sub:"라이딩이", v:"타도",   p:"타셨어요",   pf:"탔습니다",   n:"rides",    m:false },
  run:  { e:"🏃", ko:"달리기", en:"run",     sub:"달리기가", v:"달려도", p:"달리셨어요", pf:"달렸습니다", n:"runs",     m:false },
  swim: { e:"🏊", ko:"수영",   en:"swim",    sub:"수영이",   v:"해도",   p:"하셨어요",   pf:"했습니다",   n:"swims",    m:true  },
  other:{ e:"🏅", ko:"운동",   en:"workout", sub:"운동이",   v:"해도",   p:"하셨어요",   pf:"했습니다",   n:"sessions", m:false }
};
/* ⚠️ 칸이 **없는 것**과 **비어 있는 것**은 다르다. 옛 앱이 적어 둔 스냅샷에는 이 칸이 아예
   없는데(워커는 이미 뿌려진 옛 앱과 호환을 지킨다), 그걸 '섞어 함'으로 읽으면 여태 라이딩
   문장을 받던 사람이 어느 날 갑자기 「운동」으로 불린다. 없으면 하던 대로 라이딩이고,
   빈 문자열은 앱이 **일부러** 적은 '고루 섞어 한다'는 뜻이다. */
function sportW(s){
  const k = s && s.sport;
  if (k === undefined || k === null) return SPORT_W.ride;
  return SPORT_W[k] || SPORT_W.other;
}
// 그 종목의 단위로 적는다 — 수영 1,500m를 "2km"로 반올림하면 레인을 세던 사람의 숫자와 어긋난다
const distW = (w, meters, lang) => w.m
  ? `${Math.round(meters).toLocaleString(lang === "en" ? "en" : "ko")}m`
  : `${Math.round(meters / 1000)}km`;
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
    /* 두 사람 사이를 오가는 글은 **어느 한쪽의 종목도 따를 수 없다** — 보내는 쪽으로 쓰면
       받는 쪽에서 틀리고, 받는 쪽으로 쓰면 고른 말과 도착한 말이 달라진다. 중립이 정답이다. */
    return { title: T(lang, `${who}님이 같이 가자고 합니다`, `${who} wants to go with you`),
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
  const w = sportW(s);
  if (s.kind === "streak" && s.streak && s.streak.n > 0)
    return { title: T(lang, `${s.streak.n}주 연속이 오늘 끊깁니다`, `Your ${s.streak.n}-week streak ends today`),
             body: T(lang, `20분만 ${w.v} 이어집니다 — 기록은 자동으로 쌓입니다.`, "Twenty minutes keeps it alive."),
             open: "./app.html", tag: "ridelens-streak" };
  if (s.kind === "goal" && s.goal && s.goal.left)
    return { title: T(lang, `${s.goal.label} — ${s.goal.left} 남았어요`, `${s.goal.label} — ${s.goal.left} to go`),
             body: T(lang, "한 번이면 됩니다. 기간이 끝나기 전에 채워 보시죠.", "One session should do it — before the period ends."),
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
    return { title: T(lang, `내일 ${s.plan.km}km ${w.ko}`, `Tomorrow: ${s.plan.km} km`),
             body: T(lang, `물 ${s.plan.water || 2}통 · 보급 ${s.plan.stops || 0}회 예정입니다.`,
                          `${s.plan.water || 2} bottles · ${s.plan.stops || 0} resupply stops.`),
             open: s.plan.id ? `./app.html?plan=${s.plan.id}` : "./app.html", tag: "ridelens-plan" };
  if (s.kind === "care" && s.care && s.care.part){
    /* ⚠️ 장비함에는 러닝화·수영 장비도 있고, **무엇으로 닳는지가 종목마다 다르다**
       (자전거·러닝화는 km · 수영은 물에 있던 시간, 교훈 59번). 여기서 늘 "km 탔습니다"로
       적으면 수영 장비의 80시간이 "80km"가 된다. 단위는 앱이 함께 적어 보낸다. */
    const cw = SPORT_W[s.care.k] || w;
    const u = s.care.hr ? T(lang, `${s.care.km}시간 물에 있었습니다`, `${s.care.km} h in the water`)
                        : T(lang, `${s.care.km}km ${cw.pf}`, `${s.care.km} km`);
    return { title: T(lang, `${s.care.part} 관리할 때가 됐습니다`, `Time to service your ${s.care.part}`),
             body: T(lang, `마지막 정비 후 ${u}.`, `${u} since the last service.`),
             open: "./app.html", tag: "ridelens-care" };
  }
  if (s.kind === "anniv" && s.anniv && (s.anniv.m || s.anniv.km)){
    // 그날 한 운동의 종목으로 적는다 — 홈 종목이 아니다(수영 1,500m를 "1km"로 적지 않는다)
    const aw = SPORT_W[s.anniv.k] || w;
    const d = distW(aw, s.anniv.m != null ? s.anniv.m : s.anniv.km * 1000, lang);
    return { title: T(lang, `${s.anniv.years || 1}년 전 오늘, ${d}`, `${s.anniv.years || 1} year ago today: ${d}`),
             body: s.anniv.name || T(lang, "그날의 기록이 보관함에 있습니다.", "That one is still in your library."),
             open: "./app.html", tag: "ridelens-anniv" };
  }
  const m = weeklyMessage(list, lang, w);
  return { title: m.title, body: m.body, open: "./app.html", tag: "ridelens-weekly" };
}

/* ⚠️ 이 넷이 **가장 자주 나가는 문장**이다(다른 후보가 없을 때 늘 이것이 뜬다). 여기가
   자전거의 말이면 달리는 사람은 알림을 켜 놓은 내내 남의 이야기를 듣는다. `w`는 앱이
   적어 준 종목이고(`snap.sport`), 스냅샷을 못 읽었으면 부르는 쪽에서 라이딩을 넘긴다. */
function weeklyMessage(list, lang, w){
  const now = Date.now(), DAY = 86400000;
  const t = (ko, en) => (lang === "en" ? en : ko);
  w = w || SPORT_W.ride;
  const sum = (a) => a.reduce((s, r) => s + (((r.stats || {}).distance) || 0), 0);
  const d = (a) => distW(w, sum(a), lang);
  const inRange = (from, to) => list.filter(r => r.date >= now - from * DAY && r.date < now - to * DAY);
  const thisWeek = inRange(7, 0), lastWeek = inRange(14, 7);
  if (!list.length)
    return { title: t(`이번 주 ${w.ko}, 기록해 두셨나요?`, `Logged a ${w.en} this week?`),
             body: t("파일 하나만 넣으면 3초 뒤에 리포트가 나옵니다.", "Drop one file and the report is ready in 3 seconds.") };
  if (thisWeek.length)
    return { title: t(`이번 주 ${d(thisWeek)} · ${thisWeek.length}회 ${w.p}`, `${d(thisWeek)} over ${thisWeek.length} ${w.n} this week`),
             body: lastWeek.length ? t(`지난주는 ${d(lastWeek)}였습니다. 주간 랭킹도 확인해 보세요.`, `Last week was ${d(lastWeek)}. Check the weekly ranking.`)
                                   : t("주간 랭킹은 월요일에 0으로 초기화됩니다.", "The weekly ranking resets on Monday.") };
  if (lastWeek.length)
    return { title: t(`지난주엔 ${d(lastWeek)} ${w.p}`, `You did ${d(lastWeek)} last week`),
             body: t("이번 주는 아직 기록이 없습니다. 주말에 한 번 나가시죠.", "Nothing logged this week yet — how about the weekend?") };
  const last = list.slice().sort((a, b) => (b.date || 0) - (a.date || 0))[0];
  const days = Math.max(1, Math.round((now - (last.date || now)) / DAY));
  return { title: t(`마지막 ${w.sub} ${days}일 전이었어요`, `Your last ${w.en} was ${days} days ago`),
           body: t("가볍게 한 번 어떠세요. 기록은 그대로 기다리고 있습니다.", "How about an easy one? Your records are waiting.") };
}

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let shown = 0;
    try {
      const [items, snap] = await Promise.all([inbox(), snapshot()]);
      const lang = (snap && snap.lang) === "en" ? "en" : "ko";
      const w = sportW(snap);
      // 친구가 보낸 것이 먼저다 — 사람이 부른 것을 잔소리 뒤에 세우지 않는다
      for (const it of items) {
        const m = friendMessage(it, lang);
        await show(m, w); shown++;
      }
      if (!shown) await show(selfMessage(snap, await rides()), w);
      shown = 1;
    } catch (err) { /* 아래에서 반드시 하나는 띄운다 */ }
    /* 마지막 보루 — 여기까지 왔다는 것은 스냅샷도 보관함도 못 읽었다는 뜻이라 종목을 알 길이
       없다. 알림을 안 띄우면 권한이 회수되므로(userVisibleOnly) 반드시 하나는 띄우되,
       **종목 중립으로** 적는다 — 모르면서 라이딩이라고 단정하지 않는다. */
    if (!shown) await show({ title: "이번 주 운동, 기록해 두셨나요?", body: "파일 하나만 넣으면 3초 뒤에 리포트가 나옵니다.", open: "./app.html", tag: "ridelens-weekly" }, SPORT_W.other);
  })());
});

/* 어떤 종류가 실제로 먹히는지 익명으로 센다 — 띄운 수(notifs-)와 눌린 수(notifc-)를 함께 봐야
   클릭률이 나온다. 감으로 알림 종류를 늘리지 않기 위한 것이다. 보내는 것은 종류 이름뿐이고,
   기존 기능 통계와 같은 경로를 쓴다(쓰기 예산 가드도 그대로 적용된다). */
function tally(kind){
  try { fetch(`${API}/api/event`, { method: "POST", body: kind, keepalive: true }).catch(() => {}); } catch (e) {}
}
const kindOf = (tag) => String(tag || "").replace(/^ridelens-?/, "").replace(/[^a-z]/g, "") || "other";

/* 제목 앞 한 글자 — 여태 무조건 🚴였다. 잠금 화면에서 제일 먼저 눈에 들어오는 자리인데,
   달리기만 하는 사람의 폰에도 자전거가 떴다(52번: 밖으로 나가는 글은 우리가 못 보는 자리다).
   **받는 사람의** 종목을 쓴다 — 친구가 보낸 것도 마찬가지다(폰을 보는 쪽이 그 사람이다).
   스냅샷을 못 읽었으면 하던 대로 🚴다. */
function show(m, w){
  const tag = m.tag || "ridelens";
  tally("notifs-" + kindOf(tag));
  return self.registration.showNotification(((w && w.e) || "🚴") + " " + m.title, {
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
