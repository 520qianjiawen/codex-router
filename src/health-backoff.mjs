// Startup health polling ran at a flat interval, which is cheap when a service
// comes up in a second and wasteful when it does not. The LiteLLM gateway is
// allowed 300 seconds to cold start, so a flat 200 ms produced up to 1500
// probes for a single boot -- and every gateway probe is an access-log line.
// A crash-looping service under KeepAlive repeats that burst on every restart
// and never reaches the steady state the health cache smooths out.
//
// Backing off keeps the common case fast (the first probes are still 200 ms
// apart, so a service that is already up is detected immediately) while a slow
// or failing boot settles to one probe every couple of seconds.
export const INITIAL_PROBE_DELAY_MS = 200;
export const MAX_PROBE_DELAY_MS = 2_000;

export function probeDelayMs(attempt, options = {}) {
  const {
    initialMs = INITIAL_PROBE_DELAY_MS,
    maxMs = MAX_PROBE_DELAY_MS,
    factor = 1.5,
  } = options;
  // Only genuinely meaningless input falls back. A huge attempt count is not
  // meaningless -- it means this has been retrying for a long time, which is
  // exactly when the cap should apply, so it is left to clamp below.
  if (Number.isNaN(attempt) || attempt < 0) return initialMs;
  const delay = initialMs * factor ** attempt;
  // Never overshoot the caller's remaining budget: a delay longer than the
  // time left would turn a timeout into a longer one.
  return Math.min(maxMs, Math.round(delay));
}
