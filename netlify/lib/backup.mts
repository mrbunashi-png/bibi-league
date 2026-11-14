import { getStore } from '@netlify/blobs';

/* كل مجموعات البيانات اللي تدخل النسخة الاحتياطية (بدون اشتراكات الإشعارات لأنها حساسة وتنعاد بسهولة) */
export const BK_COLLS = ['matches','gallery','access','config','awards','motm','feed','teams','teamsDraft','bans','rsvps','stats','players','reacts','events','votes','inbox','views','profiles','suggestions','rock','alerts'];
const docs = () => getStore({ name: 'bibi-docs', consistency: 'strong' });
export const backups = () => getStore({ name: 'bibi-backups', consistency: 'strong' });

export async function dumpAll() {
  const st = docs();
  const out: Record<string, any> = {};
  await Promise.all(BK_COLLS.map(async (c) => { out[c] = (await st.get('c/' + c, { type: 'json' })) || {}; }));
  return { app: 'bibi-league', exportedAt: new Date().toISOString(), data: out };
}

export async function saveBackup(prefix: string, keep = 8) {
  const bk = backups();
  const d = await dumpAll();
  const key = prefix + new Date().toISOString().replace(/[:.]/g, '-');
  await bk.setJSON(key, d);
  const { blobs } = await bk.list({ prefix });
  const old = blobs.map((b: any) => b.key).sort().reverse().slice(keep);
  for (const k of old) await bk.delete(k);
  return key;
}

export async function restoreFrom(data: Record<string, any>) {
  const st = docs();
  for (const c of BK_COLLS) {
    if (c === 'profiles') continue; // الأسماء تنكتب تلقائيًا عند دخول كل لاعب
    if (data && data[c] && typeof data[c] === 'object') await st.setJSON('c/' + c, data[c]);
  }
  await st.setJSON('rev', { v: Date.now() + '-r' });
}
