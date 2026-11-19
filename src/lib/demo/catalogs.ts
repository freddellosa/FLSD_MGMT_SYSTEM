import type { DemoState } from './store';
export type DemoVehicle={id:string;version:number;active?:boolean;label:string;color?:string;model:string;plate:string;capacity:string;notes:string};
export type DemoDriver={id:string;version:number;active?:boolean;label:string;name:string;phone:string;license:string;notes:string};
export type VehicleInput=Pick<DemoVehicle,'model'|'plate'|'capacity'|'notes'|'color'>;
export type DriverInput=Pick<DemoDriver,'name'|'phone'|'license'|'notes'>;
const field=(v:string,name:string,max=200)=>{if(typeof v!=='string'||v.length>max)throw new Error(`${name} exceeds allowed length`);return v.trim();};
export function vehicleInput(v:VehicleInput){const model=field(v.model,'Vehicle model'),plate=field(v.plate,'Plate',30).toUpperCase();if(!model||!plate)throw new Error('Vehicle model and plate required');const capacity=field(v.capacity,'Capacity',3);if(capacity&&!/^\d{1,3}$/.test(capacity))throw new Error('Capacity must be whole seats');return {model,plate,capacity,color:field(v.color??'','Color',80),notes:field(v.notes,'Notes',500)};}
export function driverInput(v:DriverInput){const name=field(v.name,'Driver name');if(!name)throw new Error('Driver name required');return {name,phone:field(v.phone,'Phone',50),license:field(v.license,'License reference',80),notes:field(v.notes,'Notes',500)};}
export const vehicleName=(s:DemoState,key:string)=>{const v=s.vehicles.find(v=>v.label===key);return v?`${v.model} · ${v.plate}`:key||'Unassigned';};
export const driverName=(s:DemoState,key:string)=>s.drivers.find(v=>v.label===key)?.name||key||'Unassigned';
