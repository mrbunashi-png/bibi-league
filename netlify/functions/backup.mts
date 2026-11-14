import { saveBackup } from '../lib/backup.mts';

/* نسخة احتياطية أسبوعية تلقائية، نحتفظ بآخر 8 */
export default async () => {
  await saveBackup('auto-', 8);
};

export const config = { schedule: '0 2 * * 0' };
