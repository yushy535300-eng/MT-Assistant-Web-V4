import { getApiTableId, isMtBaccaratTable } from "./road-live-state";

// MT table lists can be partial. Absence, elapsed time and countdown/end events
// are not removal confirmations. Keep confirmed membership for this page session.
// Start with [] so loading placeholders never become confirmed tables.
export function collectConfirmedMtTableIds(previous: readonly string[], sources: any[]): string[] {
  return [...new Set([
    ...previous,
    ...sources.filter(isMtBaccaratTable).map(getApiTableId).filter(Boolean),
  ])];
}
