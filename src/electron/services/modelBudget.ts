/** Starting budgets, not measurements of model weights or server KV-cache memory. */
export const DEFAULT_CONTEXT_TOKENS = 40960;
export const DEFAULT_OUTPUT_TOKENS = 16384;

export function automaticContextTarget(ramGB = 24): number {
  return ramGB < 12 ? 8192 : ramGB < 24 ? 32768 : DEFAULT_CONTEXT_TOKENS;
}

export function tokenLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}
