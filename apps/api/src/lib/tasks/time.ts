/** "2:00 PM" in a site's zone, for the reasons a supervisor reads. */
export function fmtTimeInZone(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}
