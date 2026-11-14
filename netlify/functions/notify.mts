import { runJobs } from '../lib/notify.mts';

/* تذكيرات وتنبيهات تلقائية: كل 15 دقيقة */
export default async () => {
  await runJobs();
};

export const config = { schedule: '*/15 * * * *' };
