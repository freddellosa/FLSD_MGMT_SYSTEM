'use client';
import {createContext,useContext} from 'react';import type {DemoAction,DemoState} from '@/lib/demo/store';import type {PilotActor} from '@/lib/pilot/auth';
export type PilotBackend={actor:PilotActor;initialState:DemoState;refresh:()=>Promise<DemoState>;execute:(action:DemoAction,id:string)=>Promise<DemoState>;logout:()=>Promise<void>;request:<T>(path:string,method?:string,data?:unknown)=>Promise<T>};
export const PilotContext=createContext<PilotBackend|null>(null);export const usePilot=()=>useContext(PilotContext);
