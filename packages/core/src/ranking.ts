export interface UserCreditUsage {
  userId: string;
  creditsUsed: number;
}

export function rankHeavyUsers<T extends UserCreditUsage>(users: readonly T[]): T[] {
  return [...users].sort((a, b) => b.creditsUsed - a.creditsUsed || a.userId.localeCompare(b.userId));
}
