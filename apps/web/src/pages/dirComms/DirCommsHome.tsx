import { useEffect, useState } from 'react';
import { Mail, Plus, Search, Users } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  createBroadcast,
  createSurvey,
  listBroadcasts,
  listSurveys,
  searchDirectory,
  sendBroadcast,
  type Broadcast,
  type Person,
  type Survey,
} from '@/lib/dirCommsApi';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  Input,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab = 'directory' | 'broadcasts' | 'surveys';

export function DirCommsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:communications') : false;
  const [tab, setTab] = useState<Tab>('directory');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Directory & comms"
        subtitle="Search the people directory, send broadcasts, and run pulse / eNPS surveys."
        breadcrumbs={[{ label: 'Insights' }, { label: 'Directory & comms' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="directory">Directory</TabsTrigger>
          <TabsTrigger value="broadcasts">Broadcasts</TabsTrigger>
          <TabsTrigger value="surveys">Surveys</TabsTrigger>
        </TabsList>
        <TabsContent value="directory"><DirectoryTab /></TabsContent>
        <TabsContent value="broadcasts"><BroadcastsTab canManage={canManage} /></TabsContent>
        <TabsContent value="surveys"><SurveysTab canManage={canManage} /></TabsContent>
      </Tabs>
    </div>
  );
}

function DirectoryTab() {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[] | null>(null);

  const refresh = async (term: string) => {
    setPeople(null);
    try {
      const r = await searchDirectory(term || undefined);
      setPeople(r.people);
    } catch {
      setPeople([]);
    }
  };

  useEffect(() => {
    refresh('');
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          <Search className="h-4 w-4 text-silver" />
          <Input
            placeholder="Name or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && refresh(q)}
          />
          <Button onClick={() => refresh(q)}>Search</Button>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          {people === null ? (
            <div className="p-6"><SkeletonRows count={5} /></div>
          ) : people.length === 0 ? (
            <EmptyState icon={Users} title="No matches" description="Try a different name or email." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Title</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium text-white">{p.name}</TableCell>
                    <TableCell>{p.email}</TableCell>
                    <TableCell>{p.phone ?? '—'}</TableCell>
                    <TableCell>{p.department ?? '—'}</TableCell>
                    <TableCell>{p.jobTitle ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BroadcastsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<Broadcast[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listBroadcasts()
      .then((r) => setRows(r.broadcasts))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onSend = async (id: string) => {
    if (!(await confirm({ title: 'Send this broadcast now?' }))) return;
    try {
      const r = await sendBroadcast(id);
      toast.success(`Sent to ${r.recipientCount} associates.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New broadcast
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="No broadcasts"
              description="Send announcements to everyone, a department, or a single client."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead className="w-32 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium text-white">{b.title}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          b.status === 'SENT'
                            ? 'success'
                            : b.status === 'CANCELLED'
                              ? 'destructive'
                              : 'pending'
                        }
                      >
                        {b.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{b.channels.join(', ')}</TableCell>
                    <TableCell>{b.receiptCount}</TableCell>
                    <TableCell>
                      {b.sentAt ? new Date(b.sentAt).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && b.status !== 'SENT' && b.status !== 'CANCELLED' && (
                        <Button size="sm" onClick={() => onSend(b.id)}>
                          Send
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewBroadcastDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewBroadcastDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!title.trim() || !body.trim()) {
      toast.error('Title and body required.');
      return;
    }
    setSaving(true);
    try {
      await createBroadcast({ title: title.trim(), body: body.trim() });
      toast.success('Broadcast created (DRAFT).');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New broadcast</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Title</Label>
          <Input className="mt-1" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label>Body</Label>
          <Textarea
            className="mt-1 min-h-32"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <div className="text-xs text-silver">
          Targets default to everyone. Add client/department/cost-center filters via API for now.
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save draft'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function SurveysTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Survey[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listSurveys()
      .then((r) => setRows(r.surveys))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New survey
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No surveys"
              description="Run pulse, eNPS, or open-ended polls. Anonymous mode hides respondent IDs."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Anonymous</TableHead>
                  <TableHead>Questions</TableHead>
                  <TableHead>Responses</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium text-white">{s.title}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          s.status === 'CLOSED'
                            ? 'default'
                            : s.status === 'OPEN'
                              ? 'success'
                              : 'pending'
                        }
                      >
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{s.isAnonymous ? 'Yes' : 'No'}</TableCell>
                    <TableCell>{s.questionCount}</TableCell>
                    <TableCell>{s.responseCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewSurveyDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewSurveyDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!title.trim()) {
      toast.error('Title required.');
      return;
    }
    setSaving(true);
    try {
      await createSurvey({
        title: title.trim(),
        description: description.trim() || null,
        isAnonymous,
      });
      toast.success('Survey created (DRAFT). Add questions and OPEN it.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New survey</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Title</Label>
          <Input className="mt-1" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label>Description (optional)</Label>
          <Textarea
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={isAnonymous}
            onChange={(e) => setIsAnonymous(e.target.checked)}
          />
          Anonymous responses
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save draft'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
