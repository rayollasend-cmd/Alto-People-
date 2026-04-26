import { useAuth } from '@/lib/auth';
import { AssociatePayrollView } from './AssociatePayrollView';
import { AdminPayrollView } from './AdminPayrollView';

export function PayrollHome() {
  const { user, can } = useAuth();
  if (user?.role === 'ASSOCIATE') {
    return <AssociatePayrollView />;
  }
  return <AdminPayrollView canProcess={can('process:payroll')} />;
}
