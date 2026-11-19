import {randomBytes,scrypt,timingSafeEqual,createHash} from 'node:crypto';
export const tokenHash=(v:string)=>createHash('sha256').update(v).digest('hex');
const derive=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,{N:16384,r:8,p:1},(e,v)=>e?reject(e):resolve(v)));
export function validPassword(v:unknown):asserts v is string{if(typeof v!=='string'||v.length<12||v.length>128)throw new Error('Use a password with 12 to 128 characters');}
export async function hashPassword(password:string){validPassword(password);const salt=randomBytes(16).toString('hex');return 'scrypt$'+salt+'$'+(await derive(password,salt)).toString('hex');}
export async function verifyPassword(password:string,stored:string){if(typeof password!=='string'||password.length>128)return false;const parts=stored.split('$');if(parts.length!==3||parts[0]!=='scrypt'||!/^[a-f0-9]{32}$/.test(parts[1])||!/^[a-f0-9]{128}$/.test(parts[2]))return false;const found=await derive(password,parts[1]);return timingSafeEqual(found,Buffer.from(parts[2],'hex'));}
