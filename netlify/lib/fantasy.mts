import { readColl, mutate } from './notify.mts';

/* Bibi's Fantasy: قواعد اللعبة تُفرض هنا على السيرفر */
export const BUDGET = 60;
const KW = 3 * 3600000; // الكويت UTC+3 بدون توقيت صيفي
export const addDays = (d: string, n: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
/* الجولة تبدأ الجمعة 00:00 بتوقيت الكويت، ومعرّفها تاريخ تلك الجمعة */
export function ridOf(ms: number) {
  const d = new Date(ms + KW); const diff = (d.getUTCDay() - 5 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff); return d.toISOString().slice(0, 10);
}
/* استثناء لهذي الجولة فقط: يقفل تعديل جولة 2026-11-20 الساعة 2 الفجر (الكويت) بدل 00:00 */
export const EXC_LOCK = Date.UTC(2026, 10, 19, 23, 0, 0);
export const nextRid = (ms: number) => (ms < EXC_LOCK ? '2026-11-20' : addDays(ridOf(ms), 7));

const has = (pos: any, u: string, c: string) => Array.isArray(pos && pos[u]) && pos[u].includes(c);
const OUT = ['def', 'mid', 'fwd'];

export async function saveFantasy(uid: string, data: any, now = Date.now()): Promise<{ error?: string }> {
  const [access, fr, all] = await Promise.all([readColl('access'), readColl('fround'), readColl('fantasy')]);
  if (!(access[uid] && access[uid].status === 'ok')) return { error: 'غير مسموح' };
  const keys = Object.keys(fr).sort();
  const cfg: any = keys.length ? fr[keys[keys.length - 1]] : null;
  if (!cfg || !cfg.prices) return { error: 'الأسعار ما تحدثت للحين، انتظر الأدمن يفتح الموقع' };
  const prices: Record<string, number> = cfg.prices, pos = cfg.pos || {};
  const T = nextRid(now);
  if (!data || typeof data !== 'object' || data.t !== T) return { error: 'تغيّرت الجولة، حدّث الصفحة وحاول من جديد' };
  if (data.undo) {
    /* تراجع: يلغي تشكيلة الجولة القادمة قبل الإغلاق فقط (الإغلاق يُفرض بتطابق الجولة T) */
    const cur: any = all[uid];
    if (!cur || !cur.r || !cur.r[T]) return { error: 'ما عندك تشكيلة محفوظة لهذي الجولة' };
    await mutate('fantasy', (c) => { const d: any = { ...(c[uid] || {}) }; const r = { ...(d.r || {}) }; delete r[T]; d.r = r; return { ...c, [uid]: d }; });
    return {};
  }
  const st: string[] = Array.isArray(data.st) ? data.st.map(String) : [], bn: string[] = Array.isArray(data.bn) ? data.bn.map(String) : [];
  if (st.length !== 6 || bn.length !== 2) return { error: 'التشكيلة لازم 6 أساسيين و2 احتياط' };
  const sq = [...st, ...bn];
  if (new Set(sq).size !== 8) return { error: 'لا يمكن تكرار لاعب' };
  for (const u of sq) if (!(u in prices) || typeof prices[u] !== 'number') return { error: 'فيه لاعب غير متاح للاختيار' };
  /* تشكيلة مرنة: حارس + مهاجم + 4 ميدان بحيث 2–3 مدافعين و1–2 وسط */
  if (!has(pos, st[0], 'gk') || !has(pos, st[5], 'fwd')) return { error: 'مراكز الأساسيين غير صحيحة' };
  let okForm = false;
  for (let m = 0; m < 16 && !okForm; m++) {
    const cats = [0, 1, 2, 3].map((j) => ((m >> j) & 1 ? 'def' : 'mid'));
    const d = cats.filter((c) => c === 'def').length;
    if (d >= 2 && d <= 3 && cats.every((c, j) => has(pos, st[j + 1], c))) okForm = true;
  }
  if (!okForm) return { error: 'التشكيلة غير صحيحة: لازم 2–3 مدافعين و1–2 وسط ومهاجم واحد' };
  if (!has(pos, bn[0], 'gk')) return { error: 'الاحتياط الأول لازم حارس' };
  if (!OUT.some((c) => has(pos, bn[1], c))) return { error: 'الاحتياط الثاني لازم لاعب ميدان' };
  const cap = String(data.cap || ''), vc = String(data.vc || '');
  if (!st.includes(cap) || !st.includes(vc) || cap === vc) return { error: 'اختر كابتن ونائب كابتن مختلفين من الأساسيين' };
  const col = /^#[0-9a-fA-F]{6}$/.test(String(data.col || '')) ? String(data.col) : '#2e7d4f';
  const doc: any = all[uid] || { r: {} }; const rs: Record<string, any> = doc.r || {};
  const prev = Object.keys(rs).filter((k) => k < T).sort();
  const base = prev.length ? rs[prev[prev.length - 1]] : null;
  const wc = !!data.wc, bb = !!data.bb;
  if (wc && bb) return { error: 'ما تقدر تستخدم الوايلد كارد وبنش بوست بنفس الجولة' };
  const others = Object.keys(rs).filter((k) => k !== T);
  if (wc) { const l = others.filter((k) => rs[k].wc).sort().pop(); if (l && daysBetween(l, T) < 91) return { error: 'الوايلد كارد مرة كل 3 شهور، آخر استخدام ' + l }; }
  if (bb) { const l = others.filter((k) => rs[k].bb).sort().pop(); if (l && daysBetween(l, T) < 28) return { error: 'بنش بوست مرة بالشهر، آخر استخدام ' + l }; }
  const baseSet: string[] | null = base ? [...base.st, ...base.bn] : null;
  const pp: Record<string, number> = {};
  for (const u of sq) pp[u] = baseSet && !wc && baseSet.includes(u) && base.pp && typeof base.pp[u] === 'number' ? base.pp[u] : prices[u];
  const total = sq.reduce((s, u) => s + pp[u], 0);
  if (total > BUDGET + 1e-6) return { error: 'تجاوزت الميزانية (' + total.toFixed(1) + ' من ' + BUDGET + ')' };
  let used = 0;
  if (baseSet && !wc) {
    used = sq.filter((u) => !baseSet.includes(u)).length;
    /* التبديلات المتاحة: 2 كل جولة + تبديل واحد فقط مما لم يُستعمل */
    let avail = 2;
    for (let k = prev[0]; addDays(k, 7) <= T; k = addDays(k, 7)) avail = 2 + Math.min(1, Math.max(0, avail - ((rs[k] && rs[k].tu) || 0)));
    if (used > avail) return { error: 'تبديلاتك المتاحة هذي الجولة ' + avail + ' وتحاول ' + used };
  }
  const entry: any = { st, bn, cap, vc, pp, tu: used, ts: now };
  if (wc) entry.wc = 1; if (bb) entry.bb = 1;
  await mutate('fantasy', (cur) => ({ ...cur, [uid]: { col, r: { ...((cur[uid] && cur[uid].r) || {}), [T]: entry } } }));
  return {};
}
