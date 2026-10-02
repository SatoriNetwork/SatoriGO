// Re-export: the date maths moved to services/moneroDates.ts so the main bundle
// can use it without the Monero engine.
export { MONERO_GENESIS_DATE, localIsoDate, restoreHeightFromDate } from '../../moneroDates';
export type { RestoreDateResult } from '../../moneroDates';
