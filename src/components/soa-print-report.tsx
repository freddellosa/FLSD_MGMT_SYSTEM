'use client';
import {useRef} from 'react';
import {renderSoaHtml} from '@/lib/demo/soa-renderer';
import type {DemoDocument,DemoState} from '@/lib/demo/store';
export default function SoaPrintReport({soa,state,onClose}:{soa:DemoDocument;state:DemoState;onClose:()=>void}){const frame=useRef<HTMLIFrameElement>(null),html=renderSoaHtml(soa,state);
 return <dialog className="demo-modal trip-modal" aria-label="SOA print preview" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={onClose}><header><h2>SOA print preview - {soa.id}</h2><button className="button" onClick={onClose}>Close SOA print preview</button></header><div className="modal-content"><iframe title="SOA print document" ref={frame} srcDoc={html} sandbox="allow-same-origin allow-modals" style={{width:'100%',height:'65vh',background:'white'}}/><button className="button primary" onClick={()=>{frame.current?.contentWindow?.focus();frame.current?.contentWindow?.print();}}>Print demo SOA</button></div></dialog>;}
