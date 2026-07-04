export type AllowanceEdition = 'business' | 'enterprise';

export interface AllowanceBasis {
  edition: AllowanceEdition;
  existingCustomer: boolean;
}

// Promo window: 1 Jun 2026 00:00 UTC (inclusive) - 1 Sep 2026 00:00 UTC (exclusive, the cliff).
const PROMO_WINDOW_START = Date.UTC(2026, 5, 1, 0, 0, 0, 0);
const PROMO_WINDOW_END = Date.UTC(2026, 8, 1, 0, 0, 0, 0);

const STANDARD_PER_SEAT: Record<AllowanceEdition, number> = {
  business: 1900,
  enterprise: 3900,
};

const PROMO_PER_SEAT: Record<AllowanceEdition, number> = {
  business: 3000,
  enterprise: 7000,
};

function isPromoActive(asOfDate: Date, existingCustomer: boolean): boolean {
  if (!existingCustomer) return false;
  const t = asOfDate.getTime();
  return t >= PROMO_WINDOW_START && t < PROMO_WINDOW_END;
}

export function poolAllowanceCredits(licenseCount: number, asOfDate: Date, allowanceBasis: AllowanceBasis): number {
  const perSeat = isPromoActive(asOfDate, allowanceBasis.existingCustomer)
    ? PROMO_PER_SEAT[allowanceBasis.edition]
    : STANDARD_PER_SEAT[allowanceBasis.edition];

  return licenseCount * perSeat;
}
