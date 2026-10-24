import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  CATEGORY_LABELS,
  fileCaseOnBehalf,
  type CaseCategory,
  type CaseChannel,
  type CasePriority,
} from '@/lib/hrCases123Api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Input,
  SegmentedControl,
  Select,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import '@/lib/i18n/en/hrc';

export const CASE_CHANNELS: CaseChannel[] = ['PHONE', 'WALK_IN', 'EMAIL'];

/**
 * HR opens a case for someone (HR walk 13): a complaint that came by phone,
 * at the desk or by email had no way into the system, because filing was
 * associate-only. The case lands on the same desk with the same SLA clock,
 * and records how it came in and who took it.
 */
export function OnBehalfCaseDrawer({
  initialAssociate = null,
  onClose,
  onSaved,
}: {
  /** Pre-picked person (the person record's Cases tab). */
  initialAssociate?: PickedAssociate | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useI18n();
  const [assoc, setAssoc] = useState<PickedAssociate | null>(initialAssociate);
  const [channel, setChannel] = useState<CaseChannel>('PHONE');
  const [category, setCategory] = useState<CaseCategory>('WORKPLACE_CONCERN');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<CasePriority>('MEDIUM');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!assoc) {
      toast.error(t('hrc.onBehalf.pickPerson'));
      return;
    }
    if (!subject.trim() || !description.trim()) {
      toast.error(t('hrc.validationRequired'));
      return;
    }
    setSaving(true);
    try {
      const r = await fileCaseOnBehalf({
        associateId: assoc.id,
        channel,
        category,
        subject: subject.trim(),
        description: description.trim(),
        priority,
      });
      toast.success(t('hrc.onBehalf.filed'));
      onSaved(r.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('hrc.onBehalf.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={true}
      onOpenChange={(o) => !o && onClose()}
      confirmDiscard={() => subject.trim().length > 0 || description.trim().length > 0}
    >
      <DrawerHeader>
        <DrawerTitle>{t('hrc.onBehalf.title')}</DrawerTitle>
        <p className="text-sm text-ink-muted">{t('hrc.onBehalf.desc')}</p>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{t('hrc.onBehalf.who')}</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        <div>
          <Label>{t('hrc.onBehalf.channel')}</Label>
          <div className="mt-1">
            <SegmentedControl
              ariaLabel={t('hrc.onBehalf.channel')}
              value={channel}
              onChange={setChannel}
              options={CASE_CHANNELS.map((c) => ({ value: c, label: t(`hrc.channel.${c}` as MessageKey) }))}
            />
          </div>
        </div>
        <div>
          <Label>{t('hrc.categoryLabel')}</Label>
          <Select className="mt-1" value={category} onChange={(e) => setCategory(e.target.value as CaseCategory)}>
            {(Object.keys(CATEGORY_LABELS) as CaseCategory[]).map((k) => (
              <option key={k} value={k}>
                {t(`hrc.category.${k}` as MessageKey)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t('hrc.subjectLabel')}</Label>
          <Input className="mt-1" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('hrc.subjectPlaceholder')} />
        </div>
        <div>
          <Label>{t('hrc.descriptionLabel')}</Label>
          <Textarea
            className="mt-1 h-40"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('hrc.onBehalf.descriptionPlaceholder')}
          />
        </div>
        <div>
          <Label>{t('hrc.priorityLabel')}</Label>
          <Select className="mt-1" value={priority} onChange={(e) => setPriority(e.target.value as CasePriority)}>
            <option value="LOW">{t('hrc.priority.LOW')}</option>
            <option value="MEDIUM">{t('hrc.priority.MEDIUM')}</option>
            <option value="HIGH">{t('hrc.priority.HIGH')}</option>
            <option value="URGENT">{t('hrc.priority.URGENT')}</option>
          </Select>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('hrc.cancel')}
        </Button>
        <Button onClick={() => void submit()} loading={saving} disabled={saving}>
          {t('hrc.onBehalf.submit')}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
