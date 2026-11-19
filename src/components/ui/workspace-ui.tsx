'use client';
import type { ReactNode } from 'react';
import { Inbox,LoaderCircle } from 'lucide-react';
export function EmptyState({title,children,action}:{title:string;children?:ReactNode;action?:ReactNode}){return <div className="saas-empty"><Inbox size={25}/><h3>{title}</h3>{children&&<p>{children}</p>}{action}</div>;}
export function StatusBadge({children,tone='neutral'}:{children:ReactNode;tone?:'neutral'|'success'|'warning'|'danger'|'info'}){return <span className={'status-badge '+tone}>{children}</span>;}
export function LoadingState({label='Loading records…'}:{label?:string}){return <div role="status" className="loading-state"><LoaderCircle size={18}/>{label}</div>;}
export function PaymentProgress({amount,applied,label}:{amount:bigint;applied:bigint;label:string}){const percent=amount>0n?Number(applied*10000n/amount)/100:0;return <div className="payment-progress"><div><span>{label}</span><b>{percent.toFixed(0)}%</b></div><meter min={0} max={100} value={percent} aria-label={label}/></div>;}
