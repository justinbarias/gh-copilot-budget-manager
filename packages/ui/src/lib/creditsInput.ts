// Shared raw-digits credits parser + comma-separated recipients parser.
// Extracted (Task 4.11) once a 3rd consumer needed it: Controls.tsx and
// NewUlbModal.tsx each carried an identical, deliberately-duplicated copy
// (NewUlbModal.tsx's own comment explains why -- avoiding a circular module
// reference back when Controls.tsx was the only other user); the Users
// screen's Set/Bulk ULB modals make a 3rd and 4th consumer, past the point
// duplication stays cheaper than a shared util. Both existing call sites now
// import from here instead of defining their own copy.
export function parseCredits(raw: string): number {
  const digits = raw.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number.parseInt(digits, 10);
}

export function parseRecipients(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
