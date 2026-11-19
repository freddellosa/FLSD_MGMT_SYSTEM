'use client';
import {useRef, useState} from 'react';
import Link from 'next/link';
import {inspectBrowserBillingReview, type BrowserBillingReview} from '@/lib/migration/browser-billing-review';

const statusLabels = {PENDING: 'Pending review', CONFIRM_CANDIDATE_IDENTITY: 'Identity confirmed',
  REJECT_CANDIDATE: 'Candidate rejected; unresolved', KEEP_UNRESOLVED: 'Reviewed; unresolved', REFERENCE_ONLY: 'Reference only'};
export default function BillingReview() {
  const [files, setFiles] = useState<{packet?: File; decisions?: File}>({});
  const [review, setReview] = useState<BrowserBillingReview | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('outstanding'), [search, setSearch] = useState('');
  const generation = useRef(0), inputs = useRef<(HTMLInputElement | null)[]>([]);
  function choose(kind: 'packet' | 'decisions', file?: File) {
    generation.current++; setBusy(false); setReview(null); setError('');
    setFiles(v => ({...v, [kind]: file}));
  }
  function clear() {
    generation.current++; setBusy(false); setFiles({}); setReview(null); setError(''); setSearch(''); setFilter('outstanding');
    for (const input of inputs.current) if (input) input.value = '';
  }
  async function inspect() {
    if (!files.packet || !files.decisions) return;
    const version = ++generation.current; setBusy(true); setReview(null); setError('');
    try {
      for (const file of [files.packet, files.decisions]) if (!file.name.toLowerCase().endsWith('.json') || file.size > 10 * 1024 * 1024) throw new Error('Choose JSON review files of at most 10 MB each.');
      const decode = async (file: File) => new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer());
      const [packet, decisions] = await Promise.all([decode(files.packet), decode(files.decisions)]);
      const result = await inspectBrowserBillingReview(packet, decisions);
      if (generation.current === version) {setReview(result); setFilter('outstanding'); setSearch('');}
    } catch { if (generation.current === version) setError('Unable to verify these files. Choose UTF-8 JSON files (10 MB maximum) from the same current review revision. Your file selections are retained.'); }
    finally { if (generation.current === version) setBusy(false); }
  }
  const rows = review?.rows.filter(row => {
    if (filter === 'outstanding' && ['CONFIRM_CANDIDATE_IDENTITY', 'REFERENCE_ONLY'].includes(row.decision)) return false;
    if (filter === 'confirmed' && row.decision !== 'CONFIRM_CANDIDATE_IDENTITY') return false;
    if (filter === 'references' && row.decision !== 'REFERENCE_ONLY') return false;
    return [row.soa, row.invoice ?? '', ...row.customerLabels, ...row.trips, row.note].join(' ').toLowerCase().includes(search.trim().toLowerCase());
  }) ?? [];
  return <main className="billing-review">
    <nav aria-label="Billing review navigation"><Link href="/import-preflight">Trip source preflight</Link><Link href="/">Offline demo</Link></nav>
    <header><h1>Historical billing review</h1><p>Inspect the saved mapping packet and recorded decisions. Files stay in this browser; nothing is uploaded, imported or posted.</p></header>
    <section className="panel"><h2>Choose review files</h2><p>Select the generated billing-mapping-proposals.generated.json and the decision file named in that packet. Review notes remain private; clearing this page removes its in-memory view.</p>
      <div className="file-grid">{(['packet', 'decisions'] as const).map((kind, i) => <label key={kind}>{kind === 'packet' ? 'Generated billing review packet' : 'Recorded billing decisions'}<input ref={node => {inputs.current[i] = node;}} type="file" accept=".json,application/json" onChange={e => choose(kind, e.target.files?.[0])}/></label>)}</div>
      <div className="actions"><button className="button primary" disabled={busy || !files.packet || !files.decisions} onClick={() => void inspect()}>{busy ? 'Verifying files...' : 'Review selected files'}</button><button className="button" onClick={clear}>Clear review files</button></div>
      {busy && <p role="status">Checking review evidence...</p>}{error && <p role="alert">{error}</p>}
    </section>
    {review && <>
      <section className="panel" aria-label="Billing decision summary"><h2>Recorded review</h2><p>{review.from} through {review.through}</p><p><strong>{review.counts.pending} pending; {review.counts.confirmed} identity confirmations; {review.counts.rejected} rejected candidates; {review.counts.unresolved} kept unresolved.</strong></p><p>{review.counts.references} partial-export references require no individual approval. {review.counts.sourceCases} source-evidence cases and {review.counts.contractReminders} customer contract reminders remain separate.</p><p>Matching fingerprints detects changed files; it does not authenticate a reviewer or prove the latest CSVs were supplied. Use the local source checker for that. Recorded confirmations never change source records or authorize an import.</p><details><summary>Selected revision</summary><p>Decision filename: {review.decisionFileName}</p><code>{review.evidenceSha256}</code></details></section>
      <section className="panel"><h2>Document evidence</h2><div className="filters"><label>Show cases<select value={filter} onChange={e => setFilter(e.target.value)}><option value="outstanding">Outstanding and unresolved</option><option value="all">All cases</option><option value="confirmed">Confirmed identities</option><option value="references">Partial-export references</option></select></label><label>Search evidence<input type="search" value={search} maxLength={160} onChange={e => setSearch(e.target.value)} placeholder="SOA, invoice, customer or Trip ID"/></label></div><p role="status">{rows.length} matching cases</p>
        <div className="table-scroll"><table aria-label="Billing review cases"><thead><tr><th>SOA / invoice</th><th>Recorded review</th><th>Source customer evidence</th><th>Recorded PHP totals</th><th>Source details</th></tr></thead><tbody>{rows.slice(0, 200).map(row => <tr key={row.id}><td>SOA {row.soa}<br/>Invoice {row.invoice ?? 'Not assigned'}<br/>{row.invoiceStatus}</td><td><strong>{statusLabels[row.decision]}</strong><p>{row.note}</p></td><td>{row.customerLabels.map(c => <p key={c}>{c}</p>)}<p>Original SOA label: {row.originalSoaLabel ?? 'Not supplied'}</p><p>Original invoice label: {row.originalInvoiceLabel ?? 'Not supplied'}</p></td><td>Trip: {row.tripGross ?? 'Unresolved'}<br/>Invoice: {row.invoiceGross ?? 'Unresolved'}<br/>Trip minus invoice: {row.difference ?? 'Not compared'}</td><td><details><summary>Trip locations and review steps</summary>{row.trips.map(t => <p key={t}>{t}</p>)}{row.instructions.map((text, i) => <p key={i}>{text}</p>)}</details></td></tr>)}</tbody></table></div>
        {!rows.length && <p>No cases match this filter.</p>}{rows.length > 200 && <p>First 200 matching cases shown. Narrow the search to inspect remaining cases.</p>}
      </section>
    </>}
    <style jsx>{`
      .billing-review{max-width:1400px;padding:24px;margin:auto;color:#18243b}nav,.actions{display:flex;gap:16px;flex-wrap:wrap}nav{margin-bottom:24px}nav a{text-decoration:underline}h1{font-size:28px;font-weight:750}h2{font-size:18px;font-weight:700}p{line-height:1.5;margin:10px 0;overflow-wrap:anywhere}.panel{padding:20px;margin:20px 0;min-width:0;background:white;border:1px solid #d5dce8;border-radius:10px}.button{padding:10px 14px;border:1px solid #bcc9d9;border-radius:6px;background:white;font-weight:600;cursor:pointer}.button.primary{background:#176757;color:white;border-color:#176757}.button:disabled{opacity:.5;cursor:default}.file-grid,.filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:16px 0}label{display:grid;gap:8px;min-width:0}input,select{max-width:100%;min-height:38px}input[type=search],select{border:1px solid #ccd5e1;border-radius:6px;padding:8px;background:white}input[type=file]{width:100%}.table-scroll{overflow:auto}table{width:100%;min-width:1100px;table-layout:fixed;border-collapse:collapse;font-size:13px}th,td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid #d5dce8;overflow-wrap:anywhere}th{background:#edf2f8}th:nth-child(1){width:12%}th:nth-child(2){width:28%}th:nth-child(3){width:22%}th:nth-child(4){width:16%}th:nth-child(5){width:22%}summary{cursor:pointer;font-weight:650}code{overflow-wrap:anywhere}[role=alert]{color:#a42222}@media(max-width:700px){.billing-review{padding:14px}.file-grid,.filters{grid-template-columns:1fr}.panel{padding:14px}}
    `}</style>
  </main>;
}
