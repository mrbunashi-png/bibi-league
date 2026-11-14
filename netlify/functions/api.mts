import { getStore } from '@netlify/blobs';
import { getUser } from '@netlify/identity';
import * as webpush from 'web-push';
import { BK_COLLS, backups, dumpAll, saveBackup, restoreFrom } from '../lib/backup.mts';

/* ---- الصلاحيات (نفس قواعد النسخة القديمة، لكن تُفرض على السيرفر) ---- */
const READ_ALL = ['matches','gallery','access','config','awards','motm','feed','teams','rsvps','stats','players','reacts','events','profiles','rock'];
const ADMIN_ONLY = new Set(['matches','gallery','access','config','awards','motm','feed','teams','teamsDraft','bans','events','stats','rock','alerts']);
const SELF_WRITE = new Set(['rsvps','players','reacts','votes','inbox','views','push']); // اللاعب يكتب وثيقته فقط، والأدمن يكتب أي وحدة
const MAX_DOC = 400_000;
const MAX_ASSET = 5_800_000;

const admins = () => (process.env.ADMIN_EMAILS || 'mr.bunashi@gmail.com').toLowerCase().split(/[,\s]+/).filter(Boolean);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bad = (m: string, s = 400) => json({ error: m }, s);
const okName = (s: string) => /^[A-Za-z0-9_-]{1,80}$/.test(s);

const docs = () => getStore({ name: 'bibi-docs', consistency: 'strong' });
const key = (c: string) => 'c/' + c;

async function readColl(c: string): Promise<Record<string, any>> {
  const r = await docs().get(key(c), { type: 'json' });
  return (r as Record<string, any>) || {};
}

async function mutate(c: string, fn: (cur: Record<string, any>) => Record<string, any>) {
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
/* الحرمان يغطي أول N مباريات تبدأ بعد وقت فرض العقوبة */
const startMs = (m: any) => (m && m.date ? Date.parse(`${m.date}T${m.time || '00:00'}:00+03:00`) : NaN);
function bannedMatchIds(ban: any, matches: Record<string, any>): Set<string> {
  const out = new Set<string>();
  if (!ban || !(+ban.games > 0)) return out;
  Object.entries(matches).map(([id, m]) => ({ id, t: startMs(m) })).filter((x) => isFinite(x.t) && x.t > (+ban.ts || 0))
    .sort((a, b) => a.t - b.t).slice(0, +ban.games).forEach((x) => out.add(x.id));
  return out;
}
const bump = () => docs().setJSON('rev', { v: Date.now() + '-' + Math.random().toString(36).slice(2, 7) });

/* ---- مفاتيح الإشعارات: تتولد مرة وحدة وتنحفظ على السيرفر فقط ---- */
async function vapid(): Promise<{ publicKey: string; privateKey: string }> {
  const st = docs();
  let k: any = await st.get('vapid', { type: 'json' });
  if (!k) {
    await st.setJSON('vapid', webpush.generateVAPIDKeys(), { onlyIfNew: true });
    k = await st.get('vapid', { type: 'json' });
  }
  return k;
}
async function sendPush(origin: string, uids: string[], payload: { t: string; b: string; u?: string }) {
  const k = await vapid();
  const all = await readColl('push');
  let sent = 0, dead: Array<[string, string]> = [];
  for (const uid of uids) {
    const rec = all[uid];
    if (!rec || !Array.isArray(rec.subs)) continue;
    for (const sub of rec.subs) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 86400, vapidDetails: { subject: origin, publicKey: k.publicKey, privateKey: k.privateKey } });
        sent++;
      } catch (e: any) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push([uid, sub.endpoint]);
      }
    }
  }
  if (dead.length) await mutate('push', (cur) => {
    const n = { ...cur };
    for (const [u, ep] of dead) if (n[u]) n[u] = { ...n[u], subs: (n[u].subs || []).filter((s: any) => s.endpoint !== ep) };
    return n;
  });
  return sent;
}

async function notifyAdmins(origin: string, t: string, b: string) {
  try {
    const au: any = (await docs().get('adminuids', { type: 'json' })) || {};
    await sendPush(origin, Object.keys(au), { t, b, u: '/' });
  } catch {}
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '');
  const user: any = await getUser();
  if (!user) return bad('unauthorized', 401);
  const uid: string = user.id;
  const email: string = (user.email || '').toLowerCase();
  const admin = admins().includes(email);

  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) return bad('bad origin', 403);
  }

  /* ---- لقطة البيانات ---- */
  if (path === 'snapshot' && req.method === 'GET') {
    const revDoc: any = await docs().get('rev', { type: 'json' });
    const rev = (revDoc && revDoc.v) || '0';
    if (admin) { const au: any = (await docs().get('adminuids', { type: 'json' })) || {}; if (!au[uid]) { au[uid] = Date.now(); await docs().setJSON('adminuids', au); } }
    const me = { uid, admin, name: user.name || '', pic: user.pictureUrl || '' };
    // سجّل الاسم/الصورة العامة مرة وحدة
    let profiles: Record<string, any> = await readColl('profiles');
    const p = profiles[uid];
    if (!p || p.name !== (user.name || '') || p.pic !== (user.pictureUrl || '')) {
      await mutate('profiles', (cur) => ({ ...cur, [uid]: { name: user.name || '', pic: user.pictureUrl || '' } }));
      profiles = await readColl('profiles');
      await bump();
    }
    if (url.searchParams.get('rev') === rev && rev !== '0') return json({ same: true, rev, me });
    const colls: Record<string, any> = { profiles };
    const names = READ_ALL.filter((c) => c !== 'profiles').concat(admin ? ['teamsDraft', 'votes', 'bans', 'inbox', 'views', 'suggestions', 'alerts'] : []);
    const got = await Promise.all(names.map((c) => readColl(c)));
    names.forEach((c, i) => (colls[c] = got[i]));
    if (!admin) {
      const v = await readColl('votes');
      colls.votes = v[uid] ? { [uid]: v[uid] } : {};
      const bn = await readColl('bans');
      colls.bans = bn[uid] ? { [uid]: bn[uid] } : {};
      const vw = await readColl('views');
      colls.views = vw[uid] ? { [uid]: vw[uid] } : {};
      const ib = await readColl('inbox');
      colls.inbox = Object.fromEntries(Object.entries(ib).filter(([k]) => k.startsWith(uid + '_')));
    }
    return json({ rev, me, colls });
  }

  /* ---- كتابة ---- */
  if (path === 'write' && req.method === 'POST') {
    const raw = await req.text();
    if (raw.length > MAX_DOC) return bad('too large', 413);
    let body: any;
    try { body = JSON.parse(raw); } catch { return bad('bad json'); }
    const ops: any[] = Array.isArray(body.ops) ? body.ops.slice(0, 20) : [];
    const out: any[] = [];
    for (const o of ops) {
      const [c, idIn] = String(o.path || '').split('/');
      if (!okName(c || '') || (idIn && !okName(idIn))) return bad('bad path');
      if (c === 'profiles') return bad('forbidden', 403);
      if (c === 'suggestions' && !admin) {
        /* اللاعب يرسل فقط، ما يقرا ولا يعدل. الحد 500 حرف و5 باليوم */
        if (o.op !== 'set' || !idIn || !idIn.startsWith(uid + '_')) return bad('forbidden', 403);
        const text = String((o.data && o.data.text) || '').trim().slice(0, 500);
        if (!text) return bad('empty');
        const cur = await readColl('suggestions');
        if (cur[idIn]) return bad('exists', 409);
        const day = Date.now() - 86400000;
        if (Object.entries(cur).filter(([k, v]: any) => k.startsWith(uid + '_') && (v.ts || 0) > day).length >= 5) return bad('limit', 429);
        await mutate('suggestions', (c0) => ({ ...c0, [idIn]: { uid, text, ts: Date.now(), st: 'new' } }));
        await bump();
        await notifyAdmins(url.origin, '📬 اقتراح جديد', text.slice(0, 120));
        out.push({ path: 'suggestions/' + idIn });
        continue;
      }
      if (c === 'alerts' && !admin) {
        /* تنبيه انسحاب متأخر: اللاعب ينشئه عن نفسه فقط، والسيرفر يتحقق من الوقت والحالة */
        if (o.op !== 'set' || !idIn || !idIn.startsWith(uid + '_late_')) return bad('forbidden', 403);
        const mid = idIn.slice((uid + '_late_').length);
        const mt: any = (await readColl('matches'))[mid];
        if (!mt || !mt.date) return bad('no match', 404);
        const st = Date.parse(mt.date + 'T' + (mt.time || '00:00') + ':00+03:00');
        const now = Date.now();
        if (!isFinite(st) || now < st - 3 * 3600000 || now > st + 6 * 3600000) return bad('window', 403);
        const rr: any = ((await readColl('rsvps'))[uid] || {}).m;
        if (!rr || !rr[mid] || rr[mid].s !== 'out') return bad('not out', 403);
        const curA = await readColl('alerts');
        if (curA[idIn]) return json({ ok: true, out: [{ path: 'alerts/' + idIn }] });
        await mutate('alerts', (c0) => ({ ...c0, [idIn]: { type: 'late', uid, mid, ts: now, st: 'new' } }));
        await bump();
        const pn: any = (await readColl('players'))[uid];
        await notifyAdmins(url.origin, '⏰ انسحاب متأخر', (pn && pn.name ? pn.name : 'لاعب') + ' انسحب قبل المباراة بأقل من 3 ساعات');
        out.push({ path: 'alerts/' + idIn });
        continue;
      }
      if (c === 'suggestions' && admin && o.op === 'add') return bad('forbidden', 403);
      if (c === 'push' && o.op === 'set' && idIn === uid) {
        const subs = o.data && Array.isArray(o.data.subs) ? o.data.subs.slice(0, 5) : [];
        if (!subs.length || !subs.every((s: any) => s && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') && s.keys && s.keys.p256dh && s.keys.auth)) return bad('bad sub');
        const old: any = (await readColl('push'))[uid];
        const mine = subs.map((s: any) => ({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }));
        const eps = new Set(mine.map((s: any) => s.endpoint));
        const merged = [...mine, ...((old && Array.isArray(old.subs)) ? old.subs : []).filter((s: any) => s && !eps.has(s.endpoint))].slice(0, 5);
        o.data = { subs: merged, ts: Date.now() };
      } else if (c === 'push' && !admin) return bad('forbidden', 403);
      const id = idIn || (o.op === 'add' ? crypto.randomUUID().replace(/-/g, '').slice(0, 20) : '');
      if (!id) return bad('no id');
      if (!admin) {
        if (ADMIN_ONLY.has(c)) return bad('forbidden', 403);
        if (!SELF_WRITE.has(c)) return bad('forbidden', 403);
        if (c === 'inbox' ? !id.startsWith(uid + '_') : id !== uid) return bad('forbidden', 403);
      } else if (!ADMIN_ONLY.has(c) && !SELF_WRITE.has(c) && c !== 'suggestions') return bad('forbidden', 403);
      if (!admin && c === 'rsvps' && o.op !== 'delete') {
        const mm0 = (o.data && o.data.m) || {};
        const mAll = await readColl('matches');
        for (const k of Object.keys(mm0)) if (mAll[k] && mAll[k].guests === false && +(mm0[k] && mm0[k].g) > 0) return bad('guests closed', 403);
        const ban = (await readColl('bans'))[uid];
        if (ban) {
          const ids = bannedMatchIds(ban, await readColl('matches'));
          const mm = (o.data && o.data.m) || {};
          for (const k of Object.keys(mm)) if (ids.has(k) && (mm[k].s === 'in' || mm[k].s === 'sub')) return bad('banned', 403);
        }
      }
      if (o.op === 'delete') await mutate(c, (cur) => { const n = { ...cur }; delete n[id]; return n; });
      else if (o.op === 'update') await mutate(c, (cur) => ({ ...cur, [id]: { ...(cur[id] || {}), ...(o.data || {}) } }));
      else if (o.op === 'set' || o.op === 'add') {
        if (!o.data || typeof o.data !== 'object') return bad('bad data');
        await mutate(c, (cur) => ({ ...cur, [id]: o.data }));
      } else return bad('bad op');
      out.push({ path: c + '/' + id });
    }
    await bump();
    return json({ ok: true, out });
  }

  /* ---- الإشعارات ---- */
  if (path === 'pushkey' && req.method === 'GET') return json({ key: (await vapid()).publicKey });
  if (path === 'push' && req.method === 'POST') {
    if (!admin) return bad('forbidden', 403);
    let b: any; try { b = JSON.parse(await req.text()); } catch { return bad('bad json'); }
    const to: string[] = Array.isArray(b.to) ? b.to.filter((x: any) => typeof x === 'string').slice(0, 100) : [];
    const sent = await sendPush(url.origin, to, { t: String(b.t || '').slice(0, 80), b: String(b.b || '').slice(0, 220), u: typeof b.u === 'string' ? b.u.slice(0, 200) : '/' });
    return json({ ok: true, sent });
  }

  /* ---- النسخ الاحتياطي (للأدمن فقط) ---- */
  if (path === 'backup' && req.method === 'GET') {
    if (!admin) return bad('forbidden', 403);
    return json(await dumpAll());
  }
  if (path === 'backups' && req.method === 'GET') {
    if (!admin) return bad('forbidden', 403);
    const { blobs } = await backups().list();
    return json({ list: blobs.map((x: any) => x.key).sort().reverse() });
  }
  if (path === 'backups' && req.method === 'POST') {
    if (!admin) return bad('forbidden', 403);
    return json({ ok: true, key: await saveBackup('manual-', 8) });
  }
  if (path === 'restore' && req.method === 'POST') {
    if (!admin) return bad('forbidden', 403);
    let b: any; try { b = JSON.parse(await req.text()); } catch { return bad('bad json'); }
    if (b.confirm !== 'RESTORE') return bad('no confirm');
    await saveBackup('prerestore-', 3);
    if (b.key) {
      if (!/^[A-Za-z0-9_.-]{1,120}$/.test(String(b.key))) return bad('bad key');
      const d: any = await backups().get(String(b.key), { type: 'json' });
      if (!d || !d.data) return bad('not found', 404);
      await restoreFrom(d.data);
    } else if (b.data && typeof b.data === 'object') {
      const st = docs();
      for (const c of Object.keys(b.data)) if (BK_COLLS.includes(c) && c !== 'profiles' && b.data[c] && typeof b.data[c] === 'object') await st.setJSON(key(c), b.data[c]);
      await bump();
    } else return bad('nothing');
    return json({ ok: true });
  }

  /* ---- الملفات (صور) ---- */
  if (path === 'asset' && req.method === 'POST') {
    if (!admin) return bad('forbidden', 403);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_ASSET) return bad('too large', 413);
    const id = crypto.randomUUID().replace(/-/g, '');
    const type = (req.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    if (!/^(image|video)\//.test(type)) return bad('type');
    await getStore('bibi-assets').set(id, buf, { metadata: { type } });
    return json({ id });
  }
  if (path.startsWith('asset/')) {
    const id = path.slice(6);
    if (!okName(id)) return bad('bad id');
    const st = getStore('bibi-assets');
    if (req.method === 'DELETE') {
      if (!admin) return bad('forbidden', 403);
      await st.delete(id);
      return json({ ok: true });
    }
    const r: any = await st.getWithMetadata(id, { type: 'arrayBuffer' });
    if (!r) return bad('not found', 404);
    return new Response(r.data, { headers: { 'content-type': (r.metadata && r.metadata.type) || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' } });
  }
  return bad('not found', 404);
};

export const config = { path: ['/api/*'] };
