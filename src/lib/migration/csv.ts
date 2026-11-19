/** RFC4180-style CSV reader. Browser-only preflight; no upload or database writes. */
export function parseCsv(input: string, options: {strictQuotes?: boolean} = {}): Record<string,string>[] {
  return parseCsvTable(input, options).rows;
}
/** Retains the header contract even when an export has no data rows. */
export function parseCsvTable(input: string, options: {strictQuotes?: boolean} = {}): {headers: string[]; rows: Record<string,string>[]} {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closedQuote = false;
  const text = input.replace(/^\uFEFF/, '');
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) {
      if (ch==='"' && text[i+1]==='"') { field+='"'; i++; }
      else if (ch==='"') { quoted=false; closedQuote=true; }
      else field+=ch;
    } else if (options.strictQuotes && closedQuote && ch!==',' && ch!=='\n' && ch!=='\r') {
      throw new Error('Unexpected character after CSV closing quote');
    } else if (ch==='"') {
      if (field.length) throw new Error('Invalid quote in CSV');
      quoted=true;
    } else if (ch===',') { row.push(field); field=''; closedQuote=false; }
    else if (ch==='\n' || ch==='\r') {
      if (ch==='\r' && text[i+1]==='\n') i++;
      row.push(field); field=''; closedQuote=false;
      if (row.some(v=>v.trim()!=='')) rows.push(row);
      row=[];
    } else field+=ch;
  }
  if (quoted) throw new Error('Unclosed CSV quoted field');
  if (field.length || row.length) { row.push(field); if (row.some(v=>v.trim()!=='')) rows.push(row); }
  if (!rows.length) return {headers: [], rows: []};
  const header=rows.shift()!.map(s=>s.trim());
  if (header.some(h=>!h) || new Set(header).size!==header.length) throw new Error('Missing or duplicate CSV header');
  return {headers: header, rows: rows.map((cells,i)=>{
    if (cells.length!==header.length) throw new Error(`CSV row ${i+2} has ${cells.length} columns; expected ${header.length}`);
    return Object.fromEntries(header.map((h,j)=>[h,cells[j]]));
  })};
}
