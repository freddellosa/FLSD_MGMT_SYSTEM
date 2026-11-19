import {notFound} from 'next/navigation';
import OfficeReceiptForm from '@/components/office-receipt-form';

export const dynamic='force-dynamic';
export default function OfficeReceiptsPage(){
  const mode=process.env.FLSD_BATCH7_OFFICE_QA;
  if(mode!=='fictional-browser-loopback'&&mode!=='fictional-qa-loopback')notFound();
  return <OfficeReceiptForm signInEnabled={mode==='fictional-qa-loopback'}/>;
}
