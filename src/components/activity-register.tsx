'use client';

import { useState } from 'react';
import type { DemoDocument, DemoEvent } from '@/lib/demo/store';
import { usePilot } from './pilot-context';

type AuditValue = string | number | boolean | null | AuditValue[] | { [key: string]: AuditValue };

const manilaTime = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  dateStyle: 'medium',
  timeStyle: 'medium',
});

function readDetail(detail: string): AuditValue {
  try {
    return JSON.parse(detail) as AuditValue;
  } catch {
    return detail;
  }
}

function auditLabel(key: string) {
  const label = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function AuditDetail({ value }: { value: AuditValue }) {
  if (value === null || value === '') return <span>None recorded</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value !== 'object') return <span>{value}</span>;
  if (Array.isArray(value)) {
    return value.length
      ? <ul>{value.map((item, index) => <li key={index}><AuditDetail value={item} /></li>)}</ul>
      : <span>None recorded</span>;
  }
  const entries = Object.entries(value);
  return entries.length ? (
    <dl className="activity-details">
      {entries.map(([key, item]) => (
        <div key={key}>
          <dt>{auditLabel(key)}</dt>
          <dd><AuditDetail value={item} /></dd>
        </div>
      ))}
    </dl>
  ) : <span>None recorded</span>;
}

function ActivityTime({ value }: { value?: string }) {
  if (!value) return <>—</>;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? <>{value}</> : (
    <time dateTime={value}>{manilaTime.format(date)}</time>
  );
}

export default function ActivityRegister({ events, documents }: { events: DemoEvent[]; documents: DemoDocument[] }) {
  const pilot = usePilot();
  const [selected, setSelected] = useState<DemoEvent | null>(null);

  function record(event: DemoEvent) {
    if (event.action === 'SAVE_USER' || event.action === 'SAVE_DEMO_USER') {
      const detail = readDetail(event.detail);
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const user = detail.user;
        const name = detail.name ?? (user && typeof user === 'object' && !Array.isArray(user) ? user.name : undefined);
        if (typeof name === 'string' && name.trim()) return name;
      }
    }
    return documents.find(d => d.id === event.entityId)?.invoiceNumber ?? event.entityId;
  }

  return (
    <section className="panel">
      <div className="section-head">
        <h2>{pilot ? 'Activity and audit trail' : 'Simulated audit trail'}</h2>
        <span className="badge neutral">{pilot ? 'Attributed, database saved' : 'Append-only in session'}</span>
      </div>
      <div className="table-wrap compact-register">
        <table aria-label="Activity register">
          <thead><tr><th>Event</th><th>Action</th><th>Actor role</th><th>Record</th><th>Manila time</th><th>Details</th></tr></thead>
          <tbody>
            {[...events].reverse().map(event => (
              <tr key={event.id}>
                <td>{event.id}</td>
                <td>{event.action.replaceAll('_', ' ')}</td>
                <td>{event.actorName ? event.actorName + ' / ' + event.actor : event.actor}</td>
                <td>{record(event)}</td>
                <td><ActivityTime value={event.occurredAt} /></td>
                <td><button className="text-link" onClick={() => setSelected(event)}>View {event.id}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <dialog className="demo-modal trip-modal" aria-label="Activity details"
          ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setSelected(null)}>
          <header>
            <h2>{selected.id} · {selected.action.replaceAll('_', ' ')}</h2>
            <button className="button" onClick={() => setSelected(null)}>Close activity details</button>
          </header>
          <div className="modal-content">
            <p>{selected.actorName ? selected.actorName + ' / ' : ''}{selected.actor} · {record(selected)}</p>
            {selected.occurredAt && <p>Manila time <ActivityTime value={selected.occurredAt} /></p>}
            <AuditDetail value={readDetail(selected.detail)} />
          </div>
        </dialog>
      )}
    </section>
  );
}
