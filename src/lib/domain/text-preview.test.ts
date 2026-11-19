import { describe, expect, it } from 'vitest';
import { textPreview } from './text-preview';
describe('Bounded one-line previews',()=>{
 it('limits itinerary to 40 characters including ellipsis',()=>expect(Array.from(textPreview('A'.repeat(60),40))).toHaveLength(40));
 it('limits charge location to 15 characters and preserves short text',()=>{expect(textPreview('A'.repeat(30),15)).toBe('A'.repeat(14)+'…');expect(textPreview('SITE-A',15)).toBe('SITE-A');});
 it('normalizes line breaks without splitting Unicode characters',()=>{expect(textPreview('Pickup\nStop\nReturn',40)).toBe('Pickup Stop Return');expect(textPreview('🚐'.repeat(50),40)).toBe('🚐'.repeat(39)+'…');});
});
