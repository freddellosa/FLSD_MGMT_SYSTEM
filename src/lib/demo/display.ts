import { fromCentavos } from '../domain/billing';
/** Display formatting only. Calculations stay in integer centavos. */
export function formatAmount(value:bigint){const [whole,decimal]=fromCentavos(value).split('.');return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${decimal}`;}
export const formatPeso=(value:bigint)=>`₱${formatAmount(value)}`;
