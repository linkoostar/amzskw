import cron from 'node-cron';
import { getSetting, getSettingNum } from './db.js';
import { startRun } from './crawler.js';
import { randInt, sleep } from './util.js';

let scheduledTask: cron.ScheduledTask | null = null;
let activeRunId: number | null = null;

export function schedulerStatus(): { cron: string; active: boolean; activeRunId: number | null } {
  return { cron: getSetting('cron'), active: scheduledTask !== null, activeRunId };
}

export function startScheduler(): void {
  reloadScheduler();
}

/** (Re)schedule from settings. Call after cron setting changes. */
export function reloadScheduler(): void {
  const expr = getSetting('cron') || '0 3 * * 1';
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (!cron.validate(expr)) {
    console.warn(`[scheduler] invalid cron expression "${expr}", scheduler disabled`);
    return;
  }
  scheduledTask = cron.schedule(expr, () => {
    void onScheduledFire();
  });
  console.log(`[scheduler] weekly harvest scheduled: "${expr}"`);
}

async function onScheduledFire(): Promise<void> {
  if (activeRunId !== null) {
    console.warn('[scheduler] previous run still active, skipping');
    return;
  }
  // random start delay to avoid firing at exactly the same minute every week
  const jitterMax = getSettingNum('start_jitter_max_ms');
  if (jitterMax > 0) {
    const delay = randInt(0, jitterMax);
    console.log(`[scheduler] weekly run starting in ${Math.round(delay / 60000)} min (random jitter)`);
    await sleep(delay);
  }
  try {
    activeRunId = startRun('weekly');
    console.log(`[scheduler] weekly run started, id=${activeRunId}`);
  } catch (e) {
    console.error('[scheduler] failed to start weekly run:', (e as Error).message);
  }
}
