export interface CopilotSeat {
  assignee: { login: string; id: number; type: 'User' };
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  last_activity_editor: string | null;
  plan_type: 'business' | 'enterprise';
}

const SEAT_COUNT = 35;

export const SEATS: CopilotSeat[] = Array.from({ length: SEAT_COUNT }, (_, i) => {
  const n = i + 1;
  return {
    assignee: { login: `user-${String(n).padStart(2, '0')}`, id: 1000 + n, type: 'User' },
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    last_activity_at: '2026-06-14T10:00:00Z',
    last_activity_editor: 'vscode/1.100.0',
    plan_type: 'enterprise',
  };
});
