const manilaDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function businessDate(now = new Date()): string {
  const parts=manilaDate.formatToParts(now);
  const part=(name: string)=>parts.find(p=>p.type===name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function requireBusinessDate(value: string, label: string): void {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value){
    throw new Error(`${label} must be a valid date`);
  }
}
