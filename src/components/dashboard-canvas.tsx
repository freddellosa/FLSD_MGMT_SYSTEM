'use client';
import type { ReactNode } from 'react';
import { moveWidget,widgetSpecs,type DashboardConfig,type DashboardWidget } from '@/lib/demo/workspace-settings';
import type { Role } from '@/lib/security/permissions';
export default function DashboardCanvas({config,role,editing,onSave,render}:{config:DashboardConfig;role:Role;editing:boolean;onSave:(config:DashboardConfig)=>void;render:(widget:DashboardWidget)=>ReactNode}) {
 const edit=editing&&role==='OWNER';
 function move(source:string,target:string){if(!edit)return;const next=moveWidget(config,source,target);if(next!==config)onSave(next);}
 const displayed=config.widgets.map(w=>({...w,node:w.visible?render(w):null})).filter(w=>w.node);
 return <div className={`dashboard-canvas density-${config.density} ${edit?'layout-editing':''}`} aria-label="Overview dashboard">
 {displayed.map((w,index)=>{const label=w.title||widgetSpecs.find(([id])=>id===w.id)![1];return <div key={w.id} className="dashboard-widget" data-widget-id={w.id} style={{gridColumn:`span ${w.span}`}} draggable={edit} onDragStart={e=>{if(edit){e.dataTransfer.setData('text/plain',w.id);e.dataTransfer.effectAllowed='move';}}} onDragOver={e=>{if(edit)e.preventDefault();}} onDrop={e=>{if(edit){e.preventDefault();e.stopPropagation();move(e.dataTransfer.getData('text/plain'),w.id);}}}>
 {edit&&<div className="widget-edit-tools"><span>Drag: {label}</span><button aria-label={`Move ${label} up`} disabled={index===0} onClick={()=>move(w.id,displayed[index-1].id)}>↑</button><button aria-label={`Move ${label} down`} disabled={index===displayed.length-1} onClick={()=>move(w.id,displayed[index+1].id)}>↓</button></div>}{w.node}</div>;})}
 </div>;
}
