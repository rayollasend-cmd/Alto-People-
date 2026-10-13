import { useQuery } from '@tanstack/react-query';
import { fmtDateTime } from '@/lib/format';
import { listWhatsAppMessages } from '@/lib/whatsappApi';

/** One line on the people record: the last WhatsApp message and its receipt. Quiet for anyone who may not read the record. */
export function WhatsAppStatusLine({ associateId }: { associateId: string }) {
  const q = useQuery({
    queryKey: ['whatsapp', 'admin', 'messages', associateId, 1],
    queryFn: async () => {
      try {
        return await listWhatsAppMessages({ associateId, limit: 1 });
      } catch {
        return null;
      }
    },
    retry: false,
  });
  if (!q.data) return null;
  const last = q.data.messages[0];
  if (!last) return <span className="text-silver">No WhatsApp messages</span>;
  return (
    <span>
      Last message {last.status.toLowerCase()} · {fmtDateTime(last.statusAt ?? last.createdAt)}
    </span>
  );
}
