'use client';
import { fromCentavos } from '@/lib/domain/billing';
export { formatPeso as chartMoney } from '@/lib/demo/display';
import { formatPeso as chartMoney } from '@/lib/demo/display';
const colors=['#176757','#4389ba','#d69a35','#9568b0','#d76761','#6f8a3c','#697f95'];
type Entry={label:string;value:bigint;colorIndex?:number};
export function RevenueBars({title,rows}:{title:string;rows:Entry[]}) {
 const max=rows.reduce((n,r)=>r.value>n?r.value:n,0n);
 return <section className="panel revenue-chart"><h3>{title}</h3><div className="vertical-bars" role="img" aria-label={`${title}: ${rows.map(r=>`${r.label} ${chartMoney(r.value)}`).join(', ')}`}>{rows.map(r=><div className="vertical-bar-column" key={r.label} title={`${r.label}: ${chartMoney(r.value)}`}><div className="vertical-bar-track"><div style={{height:`${max===0n?0:Number(r.value*10000n/max)/100}%`}}/></div><span>{r.label}</span></div>)}</div></section>;
}
export function RevenuePie({title,rows}:{title:string;rows:Entry[]}) {
 const total=rows.reduce((n,r)=>n+r.value,0n);let cumulative=0n;
 const slices=rows.map((r,i)=>{const start=total===0n?0:Number(cumulative*10000n/total)/100;cumulative+=r.value;const end=total===0n?0:Number(cumulative*10000n/total)/100;return {...r,color:colors[(r.colorIndex??i)%colors.length],start,end,share:total===0n?'0.00':fromCentavos(r.value*10000n/total)};});
 const label=`${title}: ${total===0n?'No revenue':slices.map(r=>`${r.label}, ${r.share}%, ${chartMoney(r.value)}`).join('; ')}`;
 return <section className="panel revenue-chart"><h3>{title}</h3><div className="revenue-pie-layout"><div className="revenue-pie" role="img" aria-label={label} style={{background:total===0n?'#e5eae7':`conic-gradient(${slices.map(r=>`${r.color} ${r.start}% ${r.end}%`).join(',')})`}}/><div className="pie-legend">{total===0n?<span>No revenue in this year</span>:slices.map(r=><div key={r.label} title={`${r.label}: ${chartMoney(r.value)} (${r.share}%)`}><i style={{background:r.color}}/><span>{r.label}</span><b>{r.share}%</b></div>)}</div></div></section>;
}
