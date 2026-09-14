/** a single rate-limit or usage window returned by a provider quota API */
export interface QuotaWindow {
  /** human label, e.g. "5h", "7d", "Sonnet 7d", "Credits" */
  label: string;
  /** percent of the window already consumed (0-100), null when not reported */
  usedPercent: number | null;
  /** iso timestamp when this window resets, null when not reported */
  resetsAt: string | null;
  /** free-form value label for credit-style windows, e.g. "$4.20 remaining" */
  valueLabel: string | null;
  /** optional supporting text, e.g. reset details or provider-specific notes */
  detail?: string | null;
  /**
   * Stable machine key for this window, e.g. "five_hour", "seven_day",
   * "seven_day_sonnet", "seven_day_opus", "extra_usage". Unlike `label`
   * (human-facing, may be reworded), `key` is meant to be matched on by
   * downstream consumers (e.g. the fleet governor). Optional because not
   * every provider/window maps cleanly onto a known key.
   */
  key?: string;
}

/** result for one provider from the quota-windows endpoint */
export interface ProviderQuotaResult {
  /** provider slug, e.g. "anthropic", "openai" */
  provider: string;
  /** source label when the provider reports where the quota data came from */
  source?: string | null;
  /** true when the fetch succeeded and windows is populated */
  ok: boolean;
  /** machine-readable error family when ok is false */
  errorFamily?: string | null;
  /** error message when ok is false */
  error?: string;
  windows: QuotaWindow[];
}
