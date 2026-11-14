import { getStore } from '@netlify/blobs';
import * as webpush from 'web-push';

/* ---- الوصول للبيانات (نفس مخزن api.mts) ---- */
const docs = () => getStore({ name: 'bibi-docs', consistency: 'strong' });
const key = (c: string) => 'c/' + c;
export async function readColl(c: string): Promise<Record<string, any>> {
  return ((await docs().get(key(c), { type: 'json' })) as Record<string, any>) || {};
}
export async function mutate(c: string, fn: (cur: Record<string, any>) => Record<string, any>) {
  const st = docs();
  for (let i = 0; i < 8; i++) {
    const r: any = await st.getWithMetadata(key(c), { type: 'json' });
    const cur = (r && r.data) || {};
    const next = fn(cur);
    const res: any = await st.setJSON(key(c), next, r ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (res && res.modified !== false) return;
    await new Promise((s) => setTimeout(s, 40 + Math.random() * 120));
  }
  throw new Error('conflict');
}
const bump = () => docs().setJSON('rev', { v: Date.now() + '-' + Math.random().toString(36).slice(2, 7) });
export const originUrl = () => process.env.URL || 'https://bibi-league.netlify.app';

async function vapid(): Promise<{ publicKey: string; privateKey: string }> {
  const st = docs();
  let k: any = await st.get('vapid', { type: 'json' });
  if (!k) { await st.setJSON('vapid', webpush.generateVAPIDKeys(), { onlyIfNew: true }); k = await st.get('vapid', { type: 'json' }); }
  return k;
}
async function pushTo(uids: string[], payload: { t: string; b: string; u?: string }) {
  const k = await vapid();
  const all = await readColl('push');
  let reached = 0; const dead: Array<[string, string]> = [];
  for (const uid of uids) {
    const rec = all[uid]; if (!rec || !Array.isArray(rec.subs)) continue;
    let ok = false;
    for (const sub of rec.subs) {
      try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 86400, vapidDetails: { subject: originUrl(), publicKey: k.publicKey, privateKey: k.privateKey } }); ok = true; }
      catch (e: any) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push([uid, sub.endpoint]); }
    }
    if (ok) reached++;
  }
  if (dead.length) await mutate('push', (cur) => { const n = { ...cur }; for (const [u, ep] of dead) if (n[u]) n[u] = { ...n[u], subs: (n[u].subs || []).filter((s: any) => s.endpoint !== ep) }; return n; });
  return reached;
}

/* ---- الوقت (الكويت UTC+3) وساعات الهدوء 11م–7ص ---- */
const KW = 3 * 3600000;
const kwHour = (t: number) => new Date(t + KW).getUTCHours();
const isQuiet = (t: number) => { const h = kwHour(t); return h >= 23 || h < 7; };
const nextOpen = (t: number) => { const d = new Date(t + KW); const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7) - KW; return base > t ? base : base + 86400000; };
export const startMs = (m: any) => (m && m.date ? Date.parse(`${m.date}T${m.time || '00:00'}:00+03:00`) : NaN);
const isFB = (m: any) => !m.sport || m.sport === 'football';
const SPORTS: Record<string, string> = { football: 'كرة قدم', volleyball: 'كرة طائرة', padel: 'بادل', basketball: 'كرة سلة' };
export function titleOf(m: any) {
  const wk = m.date ? new Date(m.date + 'T00:00:00').toLocaleDateString('ar-KW', { weekday: 'long' }) : '';
  const sport = m.sportOther || SPORTS[m.sport] || 'كرة قدم';
  const fmt = m.format ? `${m.format} ضد ${m.format}` : '';
  return ['لعب', sport, wk, fmt].filter(Boolean).join(' ');
}
function time12(t: string) {
  if (!t) return '';
  const [H, M] = t.split(':').map(Number); const h = H % 12 || 12;
  const p = H < 12 ? 'صباحًا' : H < 15 ? 'ظهرًا' : H < 18 ? 'عصرًا' : 'مساءً';
  return h + (M ? ':' + String(M).padStart(2, '0') : '') + ' ' + p;
}

/* ---- منع التكرار ---- */
async function claim(k: string): Promise<boolean> {
  let got = false;
  await mutate('nlog', (cur) => {
    if (cur[k]) { got = false; return cur; }
    got = true;
    const n: Record<string, any> = {}; const old = Date.now() - 90 * 86400000;
    for (const [kk, v] of Object.entries(cur)) if (typeof v !== 'number' || v > old) n[kk] = v;
    n[k] = Date.now(); return n;
  });
  return got;
}

/* ---- الإرسال: صندوق التنبيهات + إشعار الجهاز ---- */
type Kind = 'pre' | 'vote' | 'gal' | 'full' | 'teams' | 'cancel';
export async function notifyUsers(o: { uids: string[]; key: string; kind: Kind; h: string; t: string; title: string; mid?: string }) {
  if (!o.uids.length) return 0;
  const [players, access] = await Promise.all([readColl('players'), readColl('access')]);
  const ids = [...new Set(o.uids)].filter((u) => access[u] && access[u].status === 'ok')
    .filter((u) => o.kind === 'cancel' || !(players[u] && players[u].np && players[u].np['s_' + o.kind] === 0));
  if (!ids.length) return 0;
  const ts = Date.now();
  await mutate('inbox', (cur) => {
    const n = { ...cur };
    for (const u of ids) { const k = u + '_' + o.key; if (!n[k]) n[k] = { to: u, k: 'sys', h: o.h, t: o.t, ts, ...(o.mid ? { mid: o.mid } : {}) }; }
    return n;
  });
  await bump();
  if (o.kind !== 'cancel' && isQuiet(ts)) {
    const at = nextOpen(ts);
    await mutate('nlog', (cur) => ({ ...cur, ['q:' + ts + ':' + Math.random().toString(36).slice(2, 6)]: { uids: ids, t: o.title, b: o.t, at } }));
  } else await pushTo(ids, { t: o.title, b: o.t, u: '/' });
  return ids.length;
}
async function flushQueue() {
  const now = Date.now(); const due: Array<[string, any]> = [];
  const log = await readColl('nlog');
  for (const [k, v] of Object.entries(log)) if (k.startsWith('q:') && v && (v as any).at <= now) due.push([k, v]);
  if (!due.length) return;
  await mutate('nlog', (cur) => { const n = { ...cur }; for (const [k] of due) delete n[k]; return n; });
  for (const [, v] of due) await pushTo(v.uids, { t: v.t, b: v.b, u: '/' });
}

/* ---- قوالب النصوص ---- */
const T = {
  pre: (m: any, role: string) => role === 'in' ? `«${titleOf(m)}» تبدأ بعد ساعتين${m.time ? ' (الساعة ' + time12(m.time) + ')' : ''}. نراك على الملعب ⚽`
    : role === 'sub' ? `«${titleOf(m)}» تبدأ بعد ساعتين. أنت في الاحتياط، خلك جاهز إذا انفتح لك مقعد 🪑`
    : `«${titleOf(m)}» تبدأ بعد ساعتين. شرّفنا بحضورك 👀`,
  vote1: (m: any) => `انتهت «${titleOf(m)}»! صوّت لرجل المباراة 🌟 ولصخرة الدفاع 🛡 قبل منتصف الليل`,
  vote2: (m: any, miss: string) => `باقي ساعات على قفل التصويت في «${titleOf(m)}». ما صوّتت لـ ${miss}`,
  gal: (n: number) => `📸 ${n > 1 ? 'انرفعت ملفات جديدة' : 'انرفع ملف جديد'} في الصور والفيديو`,
  full: (m: any, role: string) => role === 'in' ? `✅ اكتمل العدد في «${titleOf(m)}» 🔥` : `✅ اكتمل العدد في «${titleOf(m)}». أنت في الاحتياط وننبهك إذا انفتح مقعد`,
  team: (m: any, side: string) => `📋 انعتمت تشكيلة «${titleOf(m)}»: أنت في الفريق ${side === 'g' ? '🟢' : '🎨'}`,
  cancel: (m: any, r: string) => `🚫 تم إلغاء «${titleOf(m)}»${r ? ' · السبب: ' + r : ''}`,
  back: (m: any) => `✅ رجعت «${titleOf(m)}» وصارت قائمة من جديد، سجّل حضورك`,
};
const regs = (rsvps: Record<string, any>, mid: string, ss: string[]) =>
  Object.entries(rsvps).filter(([, r]: any) => r && r.m && r.m[mid] && ss.includes(r.m[mid].s)).map(([u, r]: any) => [u, r.m[mid]] as [string, any]);

/* ---- أحداث فورية (تُستدعى من api.mts) ---- */
export async function checkFull() {
  const [matches, rsvps, access] = await Promise.all([readColl('matches'), readColl('rsvps'), readColl('access')]);
  const now = Date.now();
  for (const [mid, m] of Object.entries<any>(matches)) {
    if (m.cancelled || !+m.format) continue;
    const st = startMs(m); if (!isFinite(st) || st < now) continue;
    const cap = 2 * +m.format; let used = 0;
    for (const [u, x] of regs(rsvps, mid, ['in'])) if (access[u] && access[u].status === 'ok') used += 1 + (m.guests === false ? 0 : Math.max(0, Math.min(5, +x.g || 0)));
    if (used < cap) continue;
    if (!(await claim('full_' + mid))) continue;
    const g = regs(rsvps, mid, ['in']).map(([u]) => u), s = regs(rsvps, mid, ['sub']).map(([u]) => u);
    await notifyUsers({ uids: g, key: 'f' + mid, kind: 'full', h: '✅ اكتمل العدد', t: T.full(m, 'in'), title: '✅ اكتمل العدد', mid });
    await notifyUsers({ uids: s, key: 'f' + mid, kind: 'full', h: '✅ اكتمل العدد', t: T.full(m, 'sub'), title: '✅ اكتمل العدد', mid });
  }
}
export async function onTeamsPublished(mid: string, data: any) {
  const m: any = (await readColl('matches'))[mid]; if (!m || m.cancelled) return;
  if (!(await claim('teams_' + mid))) return;
  for (const side of ['g', 'c']) {
    const uids = (Array.isArray(data && data[side]) ? data[side] : []).filter((x: any) => typeof x === 'string');
    await notifyUsers({ uids, key: 't' + mid + side, kind: 'teams', h: '📋 التشكيلة', t: T.team(m, side), title: '📋 انعتمت التشكيلة', mid });
  }
}
export async function onCancel(mid: string, m: any, reason: string, cancelled: boolean) {
  const rsvps = await readColl('rsvps');
  const uids = regs(rsvps, mid, ['in', 'sub', 'watch']).map(([u]) => u);
  const k = (cancelled ? 'x' : 'y') + Date.now().toString(36);
  await notifyUsers({ uids, key: k, kind: 'cancel', h: cancelled ? '🚫 إلغاء مباراة' : '✅ رجوع مباراة', t: cancelled ? T.cancel(m, reason) : T.back(m), title: cancelled ? '🚫 تم إلغاء المباراة' : '✅ رجعت المباراة', mid });
}
export async function queueGallery() {
  await mutate('nlog', (cur) => ({ ...cur, 'g:q': { ts: Date.now(), n: ((cur['g:q'] && cur['g:q'].n) || 0) + 1 } }));
}

/* ---- الوظيفة المجدولة كل 15 دقيقة ---- */
export async function runJobs() {
  const now = Date.now();
  const [matches, rsvps, access, votes] = await Promise.all([readColl('matches'), readColl('rsvps'), readColl('access'), readColl('votes')]);
  const ok = (u: string) => !!(access[u] && access[u].status === 'ok');
  for (const [mid, m] of Object.entries<any>(matches)) {
    if (m.cancelled) continue;
    const st = startMs(m); if (!isFinite(st)) continue;
    /* تذكير قبل المباراة بساعتين */
    if (st > now + 20 * 60000 && st - now <= 120 * 60000 && (await claim('pre_' + mid + '_' + st))) {
      for (const role of ['in', 'sub', 'watch']) {
        const uids = regs(rsvps, mid, [role]).map(([u]) => u).filter(ok);
        await notifyUsers({ uids, key: 'p' + mid + role, kind: 'pre', h: '⏰ تذكير', t: T.pre(m, role), title: '⏰ المباراة بعد ساعتين', mid });
      }
    }
    /* التصويت */
    if (isFB(m)) {
      const open = st + 60 * 60000;
      const d = new Date(open + KW); const close = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - KW;
      if (now >= open && now < close) {
        const going = regs(rsvps, mid, ['in']).map(([u]) => u).filter(ok);
        if (await claim('vote1_' + mid)) await notifyUsers({ uids: going, key: 'v1' + mid, kind: 'vote', h: '🌟 التصويت مفتوح', t: T.vote1(m), title: '🌟 صوّت الحين', mid });
        if (now >= open + 2 * 3600000 && close - now <= 3 * 3600000 && (await claim('vote2_' + mid))) {
          for (const u of going) {
            const v = votes[u] || {}; const a = !(v.o && v.o[mid]), b = !(v.r && v.r[mid]);
            if (!a && !b) continue;
            const miss = a && b ? 'رجل المباراة وصخرة الدفاع' : a ? 'رجل المباراة' : 'صخرة الدفاع';
            await notifyUsers({ uids: [u], key: 'v2' + mid, kind: 'vote', h: '⏳ قرب قفل التصويت', t: T.vote2(m, miss), title: '⏳ قرب قفل التصويت', mid });
          }
        }
      }
    }
  }
  /* المعرض: إشعار مجمّع بعد 10 دقائق من آخر رفع */
  const log = await readColl('nlog'); const gq = log['g:q'];
  if (gq && now - gq.ts >= 10 * 60000) {
    let n = 0; await mutate('nlog', (cur) => { const q = cur['g:q']; n = q ? q.n : 0; const x = { ...cur }; delete x['g:q']; return x; });
    if (n > 0) await notifyUsers({ uids: Object.keys(access).filter(ok), key: 'g' + now.toString(36), kind: 'gal', h: '📸 المعرض', t: T.gal(n), title: '📸 جديد في المعرض' });
  }
  await checkFull();
  await flushQueue();
}

/* ---- تجربة الأدمن على نفسه ---- */
export async function sendTests(uid: string) {
  const m = { date: '2026-12-04', time: '21:00', format: '7', sport: 'football' };
  const L: Array<[string, string]> = [['⏰ المباراة بعد ساعتين', T.pre(m, 'in')], ['🌟 صوّت الحين', T.vote1(m)], ['⏳ قرب قفل التصويت', T.vote2(m, 'رجل المباراة')], ['📸 جديد في المعرض', T.gal(2)], ['✅ اكتمل العدد', T.full(m, 'in')], ['📋 انعتمت التشكيلة', T.team(m, 'g')], ['🚫 تم إلغاء المباراة', T.cancel(m, 'الطقس')]];
  let reached = 0;
  for (const [t, b] of L) reached += await pushTo([uid], { t: '🧪 ' + t, b, u: '/' });
  return { sent: L.length, reached };
}
