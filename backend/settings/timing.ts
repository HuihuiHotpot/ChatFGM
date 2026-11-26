import type { Logger } from '../platform/log';

/** Durations only: never record configuration, credentials or service replies. */
export function detectionTiming(logger: Logger, kind: string) {
  const started = performance.now();
  let previous = started;
  return (stage: string) => {
    const now = performance.now();
    logger.info('settings-detection-stage', {
      kind, stage, elapsedMs: Math.round(now - previous),
      totalMs: Math.round(now - started),
    });
    previous = now;
  };
}
