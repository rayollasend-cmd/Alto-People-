import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { WhatsAppMeResponse } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { getMyWhatsApp, setWhatsAppConsent } from '@/lib/whatsappApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * WhatsApp updates, on or off (Brief 1C-4). Consent is the associate's own
 * word: the number, the checkbox, the button. STOP by reply works too.
 */
export function WhatsAppCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['whatsapp', 'me'], queryFn: getMyWhatsApp, retry: false });
  const [phone, setPhone] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);

  const consent = useMutation({
    mutationFn: (optIn: boolean) => setWhatsAppConsent(optIn ? { optIn, phone: (phone ?? q.data?.phoneOnFile ?? '').trim() } : { optIn }),
    onSuccess: (data: WhatsAppMeResponse, optIn) => {
      qc.setQueryData(['whatsapp', 'me'], { ...data, phoneOnFile: q.data?.phoneOnFile ?? data.phoneOnFile });
      setAgreed(false);
      toast.success(optIn ? t('settings.whatsapp.optedInDone') : t('settings.whatsapp.optedOutDone'));
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : t('emergency.failed')),
  });

  const on = q.data?.consent?.status === 'OPTED_IN';
  const phoneValue = phone ?? q.data?.phoneOnFile ?? '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-gold" aria-hidden="true" />
          {t('settings.whatsapp.title')}
        </CardTitle>
        <CardDescription>{t('settings.whatsapp.languageNote')}</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-16" />
        ) : q.isError || !q.data ? null : !q.data.configured ? (
          <p className="text-sm text-silver">{t('settings.whatsapp.comingSoon')}</p>
        ) : on ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-white">
              {t('settings.whatsapp.onSince', { phone: `…${q.data.consent!.phone.slice(-4)}`, date: fmtDate(q.data.consent!.optedInAt) })}
            </p>
            <Button variant="outline" onClick={() => consent.mutate(false)} loading={consent.isPending}>
              {t('settings.whatsapp.turnOff')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label={t('settings.whatsapp.phoneLabel')}>
              <Input type="tel" inputMode="tel" value={phoneValue} onChange={(e) => setPhone(e.target.value)} placeholder="(850) 555-0100" className="text-base" />
            </Field>
            <label className="flex items-start gap-2 text-sm text-white">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>{t('settings.whatsapp.consent')}</span>
            </label>
            <Button onClick={() => consent.mutate(true)} loading={consent.isPending} disabled={!agreed || phoneValue.trim().length < 10}>
              {t('settings.whatsapp.turnOn')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
