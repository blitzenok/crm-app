// infra 2026-10-01 ship48: ESM entry for the shared lower-48 rule (source of truth: ./ship-region.cjs, also used by products-api).
import sr from "./ship-region.cjs";
export const { checkShipRegion, shipRegionErrorBody, SHIP_REGION_MESSAGE, LOWER48_STATES } = sr;
