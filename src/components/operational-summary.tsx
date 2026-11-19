'use client';
import {dashboardPercentages} from '@/lib/demo/overview';
import {businessDate} from '@/lib/demo/billing-register';
import type { Role } from '@/lib/security/permissions';
import type { DemoState } from '@/lib/demo/store';
import type { TripFilters } from '@/lib/demo/trip-operations';
export default function OperationalSummary({state,role,onTrips,title='Trip register summary'}:{state:DemoState;role:Role;onTrips:(filters:TripFilters)=>void;title?:string}){
 const p=dashboardPercentages(state,businessDate()),percent=(value:number|null)=>value===null?'No comparison':value.toFixed(2)+'%';
 const cards=[{label:'Total trips',value:state.trips.length,filter:{}},{label:'Direct-pay trips',value:state.trips.filter(t=>t.workflow==='DIRECT').length,filter:{workflow:'DIRECT'}},{label:'Corporate trips',value:state.trips.filter(t=>t.workflow==='CORPORATE').length,filter:{workflow:'CORPORATE'}}];
 return <section className="panel operational-summary" aria-label="Trip register summary"><h2>{title}</h2><div className="operations-kpis three">{cards.map(c=><button className="operation-kpi" key={c.label} onClick={()=>onTrips(c.filter)}><span>{c.label}</span><b>{c.value}</b><small>View register</small></button>)}</div>{role!=='OPERATIONS'&&<details className="percentage-report"><summary>Percentage reports</summary><dl><div><dt>Fully settled trips</dt><dd>{percent(p.settled)}</dd></div><div><dt>Unbilled trips</dt><dd>{percent(p.unbilled)}</dd></div>{role==='OWNER'&&<><div><dt>{p.year} corporate revenue share</dt><dd>{percent(p.corporate)}</dd></div><div><dt>{p.year} direct-pay revenue share</dt><dd>{percent(p.direct)}</dd></div><div><dt>Revenue change vs previous year</dt><dd>{percent(p.growth)}</dd></div></>}</dl><small>Trip shares use all selected trips. Revenue shares use agreed charges by service year, excluding tax-review amounts. Empty bases have no comparison.</small></details>}</section>;
}
