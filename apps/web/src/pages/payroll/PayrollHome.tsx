import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { AssociatePayrollView } from './AssociatePayrollView';
import { AdminPayrollView } from './AdminPayrollView';

export function PayrollHome() {
  const { user, can } = useAuth();
  const [params] = useSearchParams();
  if (user?.role === 'ASSOCIATE') {
    return <AssociatePayrollView />;
  }
  // Staff who are paid too (a manager, HR): a link to one of their own
  // paystubs (/payroll?item=…, the paystub email and bell) opens their own
  // pay page, not the payroll desk. ?mine=1 keeps them there once the
  // paystub has opened and the item param is gone.
  const item = params.get('item');
  if (user?.associateId && item && params.get('mine') !== '1') {
    const next = new URLSearchParams(params);
    next.set('mine', '1');
    return <Navigate to={`/payroll?${next.toString()}`} replace />;
  }
  if (user?.associateId && params.get('mine') === '1') {
    return <AssociatePayrollView />;
  }
  return (
    <AdminPayrollView
      canProcess={can('process:payroll')}
      canVoid={can('void:payroll')}
    />
  );
}
