/** Session-only workspace preferences and directories; never authentication. */
import {validatePaymentTerm,type PaymentTerm} from '../domain/payment-terms';
import { roles,type Role } from '../security/permissions';
export const widgetSpecs=[
 ['charges','Agreed charges / revenue',3],['collections','Customer collections',3],['outstanding','Remaining settlement',3],['driver-cash','Driver-held cash',3],
 ['operations','Trip operations',12],['office-actions','Keep the day moving',12],['unbilled','Unbilled trips',2],['overdue','Overdue invoices',10],['customer-invoices','Unsettled invoices per customer',6],['expected','Expected collections by date',6],
 ['monthly-current','Monthly revenue - current year',4],['share-current','Customer revenue share - current year',4],['workflow-current','Corporate vs direct - current year',4],
 ['monthly-previous','Monthly revenue - previous year',4],['share-previous','Customer revenue share - previous year',4],['workflow-previous','Corporate vs direct - previous year',4],
] as const;
export type WidgetId=typeof widgetSpecs[number][0];
export type DashboardWidget={id:WidgetId;title:string;visible:boolean;span:2|3|4|6|8|9|10|12};
export type DashboardConfig={version:number;density:'compact'|'comfortable';widgets:DashboardWidget[]};
export const defaultDashboard=():DashboardConfig=>({version:1,density:'compact',widgets:widgetSpecs.map(([id,,span])=>({id,span,title:'',visible:true}))});
export function validateDashboard(config:DashboardConfig) {
 if(!Number.isSafeInteger(config.version)||config.version<1||!['compact','comfortable'].includes(config.density))throw new Error('Invalid dashboard settings');
 if(!Array.isArray(config.widgets)||config.widgets.length!==widgetSpecs.length||new Set(config.widgets.map(w=>w.id)).size!==widgetSpecs.length)throw new Error('Dashboard must contain each widget exactly once');
 for(const w of config.widgets)if(!widgetSpecs.some(([id])=>id===w.id)||![2,3,4,6,8,9,10,12].includes(w.span)||typeof w.visible!=='boolean'||typeof w.title!=='string'||w.title.length>80)throw new Error('Invalid dashboard widget');
}
export function moveWidget(config:DashboardConfig,source:string,target:string):DashboardConfig {
 const from=config.widgets.findIndex(w=>w.id===source),to=config.widgets.findIndex(w=>w.id===target);
 if(from<0||to<0||from===to)return config;
 const widgets=[...config.widgets];const [item]=widgets.splice(from,1);widgets.splice(to,0,item);return {...config,widgets};
}
export type CustomerVatStatus='UNREVIEWED'|'VAT'|'NON_VAT';
export type DemoCustomer={id:string;version:number;active?:boolean;name:string;contact:string;email:string;phone:string;address:string;tin?:string;invoiceFormatId?:string;vatStatus?:CustomerVatStatus;paymentTerm?:PaymentTerm};
export type DemoUser={id:string;version:number;name:string;email:string;role:Role;active:boolean};
export type CustomerInput=Omit<DemoCustomer,'id'|'version'>;
export type UserInput=Omit<DemoUser,'id'|'version'>;
const bounded=(value:string,label:string,max=200)=>{if(typeof value!=='string'||value.length>max)throw new Error(`${label} exceeds allowed length`);return value.trim();};
export function customerInput(input:CustomerInput,previousTin?:string):CustomerInput {
 const name=bounded(input.name,'Customer name');if(!name)throw new Error('Customer name required');
 const email=bounded(input.email,'Customer email');if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Invalid customer email');
 if(input.vatStatus!==undefined&&!['UNREVIEWED','VAT','NON_VAT'].includes(input.vatStatus))throw new Error('Choose VAT, Non-VAT or Not reviewed');
 const tin=input.tin===undefined||input.tin===previousTin?previousTin??'':bounded(input.tin,'TIN',40);
 if(tin&&tin!==previousTin&& !/^(?:\d{9}(?:\d{3,5})?|\d{3}-\d{3}-\d{3}(?:-\d{3,5})?)$/.test(tin)){
  throw new Error('Enter a 9-digit TIN, optionally followed by its branch code');
 }
 return {name,email,tin,contact:bounded(input.contact,'Contact'),phone:bounded(input.phone,'Phone',50),address:bounded(input.address,'Address',500),...(input.vatStatus===undefined?{}:{vatStatus:input.vatStatus}),...(input.paymentTerm===undefined?{}:{paymentTerm:validatePaymentTerm(input.paymentTerm)})};
}
export function userInput(input:UserInput):UserInput {
 const name=bounded(input.name,'User name'),email=bounded(input.email,'User email').toLowerCase();
 if(!name||!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('User name and valid email required');
 if(!roles.includes(input.role)||typeof input.active!=='boolean')throw new Error('Choose an existing role and valid user status');
 return {name,email,role:input.role,active:input.active};
}
export const seedDemoUsers=():DemoUser[]=>roles.map((role,i)=>({id:`demo-user-${i+1}`,version:1,name:`Demo ${role.toLowerCase()}`,email:`${role.toLowerCase()}@example.test`,role,active:true}));
