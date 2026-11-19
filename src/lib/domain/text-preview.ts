/** Display-only truncation; original values remain available in details and exports. */
export function textPreview(value:string,maxCharacters:number):string {
 const points=Array.from(value.replace(/\s+/g,' ').trim());
 return points.length<=maxCharacters?points.join(''):points.slice(0,Math.max(0,maxCharacters-1)).join('')+'…';
}
