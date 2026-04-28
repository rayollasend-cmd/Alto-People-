import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Eye,
  Plus,
  Search,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  adminListKb,
  archiveKbArticle,
  createKbArticle,
  deleteKbArticle,
  getKbArticle,
  getKbCategories,
  publishKbArticle,
  searchKb,
  type KbAdminRow,
  type KbArticleDetail,
  type KbArticleSummary,
  type KbCategoryRow,
  type KbStatus,
  updateKbArticle,
  voteKbArticle,
} from '@/lib/kb124Api';
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const STATUS_VARIANT: Record<KbStatus, 'pending' | 'success' | 'outline'> = {
  DRAFT: 'pending',
  PUBLISHED: 'success',
  ARCHIVED: 'outline',
};

export function KbHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const [tab, setTab] = useState<'browse' | 'admin'>('browse');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string>('');
  const [articles, setArticles] = useState<KbArticleSummary[] | null>(null);
  const [categories, setCategories] = useState<KbCategoryRow[]>([]);
  const [adminRows, setAdminRows] = useState<KbAdminRow[] | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [editing, setEditing] = useState<KbAdminRow | 'new' | null>(null);

  const refresh = () => {
    if (tab === 'browse') {
      setArticles(null);
      searchKb({ q: q.trim() || undefined, category: category || undefined })
        .then((r) => setArticles(r.articles))
        .catch(() => setArticles([]));
      getKbCategories()
        .then((r) => setCategories(r.categories))
        .catch(() => setCategories([]));
    } else {
      setAdminRows(null);
      adminListKb()
        .then((r) => setAdminRows(r.articles))
        .catch(() => setAdminRows([]));
    }
  };
  useEffect(() => {
    refresh();
  }, [tab, q, category]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Help center"
        subtitle="Search company policies, benefits, and how-tos. Try searching before filing an HR case."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Help center' }]}
      />

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tab === 'browse' ? 'primary' : 'ghost'}
            onClick={() => setTab('browse')}
          >
            Browse
          </Button>
          {canManage && (
            <Button
              size="sm"
              variant={tab === 'admin' ? 'primary' : 'ghost'}
              onClick={() => setTab('admin')}
            >
              Admin
            </Button>
          )}
        </div>
        {canManage && tab === 'admin' && (
          <Button onClick={() => setEditing('new')}>
            <Plus className="mr-2 h-4 w-4" /> New article
          </Button>
        )}
      </div>

      {tab === 'browse' ? (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver" />
            <Input
              className="pl-9"
              placeholder="Search articles…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setCategory('')}
                className={`text-xs px-2 py-1 rounded border ${
                  category === ''
                    ? 'bg-navy-tertiary border-blue-400 text-white'
                    : 'border-navy-secondary text-silver hover:text-white'
                }`}
              >
                All
              </button>
              {categories.map((c) => (
                <button
                  key={c.category}
                  onClick={() => setCategory(c.category)}
                  className={`text-xs px-2 py-1 rounded border ${
                    category === c.category
                      ? 'bg-navy-tertiary border-blue-400 text-white'
                      : 'border-navy-secondary text-silver hover:text-white'
                  }`}
                >
                  {c.category} <span className="text-silver">{c.count}</span>
                </button>
              ))}
            </div>
          )}
          <Card>
            <CardContent className="p-0">
              {articles === null ? (
                <div className="p-6">
                  <SkeletonRows count={4} />
                </div>
              ) : articles.length === 0 ? (
                <EmptyState
                  icon={BookOpen}
                  title={q ? 'No matches' : 'No articles yet'}
                  description={
                    q
                      ? 'Try different keywords or browse by category.'
                      : 'HR hasn’t published any articles yet.'
                  }
                />
              ) : (
                <div className="divide-y divide-navy-secondary">
                  {articles.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setOpenSlug(a.slug)}
                      className="w-full p-4 text-left hover:bg-navy-tertiary transition"
                    >
                      <div className="text-sm font-medium text-white">
                        {a.title}
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap text-xs text-silver">
                        <Badge variant="outline">{a.category}</Badge>
                        {a.tags.slice(0, 4).map((t) => (
                          <span key={t}>#{t}</span>
                        ))}
                        <span className="flex items-center gap-1">
                          <Eye className="h-3 w-3" /> {a.views}
                        </span>
                        {a.helpful > 0 && (
                          <span className="flex items-center gap-1 text-green-400">
                            <ThumbsUp className="h-3 w-3" /> {a.helpful}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="p-0">
            {adminRows === null ? (
              <div className="p-6">
                <SkeletonRows count={4} />
              </div>
            ) : adminRows.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No articles"
                description="Create the first article."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Views</TableHead>
                    <TableHead>Helpful</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {adminRows.map((a) => (
                    <TableRow key={a.id} className="group">
                      <TableCell>
                        <div className="font-medium text-white">{a.title}</div>
                        <div className="text-xs font-mono text-silver">
                          /{a.slug}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-silver">
                        {a.category}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[a.status]}>
                          {a.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{a.views}</TableCell>
                      <TableCell className="text-sm text-green-400">
                        {a.helpful}{' '}
                        {a.notHelpful > 0 && (
                          <span className="text-destructive">/ {a.notHelpful}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        {a.status === 'DRAFT' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              try {
                                await publishKbArticle(a.id);
                                toast.success('Published.');
                                refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError
                                    ? err.message
                                    : 'Failed.',
                                );
                              }
                            }}
                          >
                            Publish
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(a)}
                        >
                          Edit
                        </Button>
                        <button
                          onClick={async () => {
                            if (!(await confirm({ title: `Delete "${a.title}"?`, destructive: true }))) return;
                            try {
                              await deleteKbArticle(a.id);
                              refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof ApiError
                                  ? err.message
                                  : 'Failed.',
                              );
                            }
                          }}
                          className="text-silver hover:text-destructive opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="h-4 w-4 inline" />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {openSlug && (
        <ArticleDrawer
          slug={openSlug}
          onClose={() => setOpenSlug(null)}
        />
      )}
      {editing && (
        <EditDrawer
          article={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ArticleDrawer({
  slug,
  onClose,
}: {
  slug: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<KbArticleDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setData(null);
    getKbArticle(slug)
      .then(setData)
      .catch(() => setData(null));
  };
  useEffect(() => {
    refresh();
  }, [slug]);

  const vote = async (helpful: boolean) => {
    if (!data) return;
    setBusy(true);
    try {
      await voteKbArticle(data.id, helpful);
      toast.success('Thanks for the feedback.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.title ?? 'Loading…'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!data ? (
          <SkeletonRows count={4} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-silver">
              <Badge variant="outline">{data.category}</Badge>
              {data.tags.map((t) => (
                <span key={t}>#{t}</span>
              ))}
              <span className="flex items-center gap-1">
                <Eye className="h-3 w-3" /> {data.views}
              </span>
            </div>
            <div className="prose prose-invert text-sm whitespace-pre-wrap text-white">
              {data.body}
            </div>
            <div className="pt-3 border-t border-navy-secondary space-y-2">
              <div className="text-xs uppercase tracking-wider text-silver">
                Was this helpful?
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={data.myVote?.helpful === true ? 'primary' : 'ghost'}
                  onClick={() => vote(true)}
                  disabled={busy}
                >
                  <ThumbsUp className="mr-1 h-3 w-3" /> Yes ({data.helpful})
                </Button>
                <Button
                  size="sm"
                  variant={data.myVote?.helpful === false ? 'primary' : 'ghost'}
                  onClick={() => vote(false)}
                  disabled={busy}
                >
                  <ThumbsDown className="mr-1 h-3 w-3" /> No ({data.notHelpful})
                </Button>
              </div>
            </div>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to results
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function EditDrawer({
  article,
  onClose,
  onSaved,
}: {
  article: KbAdminRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const isNew = article === null;
  const [title, setTitle] = useState(article?.title ?? '');
  const [slug, setSlug] = useState(article?.slug ?? '');
  const [category, setCategory] = useState(article?.category ?? 'General');
  const [tags, setTags] = useState<string>((article?.tags ?? []).join(', '));
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  // For edit, fetch the full body lazily.
  useEffect(() => {
    if (!article) return;
    if (article.status === 'PUBLISHED') {
      getKbArticle(article.slug)
        .then((d) => setBody(d.body))
        .catch(() => setBody(''));
    }
  }, [article]);

  const tagList = useMemo(
    () =>
      tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    [tags],
  );

  const submit = async () => {
    if (!title.trim() || !body.trim()) {
      toast.error('Title and body required.');
      return;
    }
    if (isNew && !slug.match(/^[a-z0-9-]+$/)) {
      toast.error('Slug: lowercase letters, digits, hyphens only.');
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        await createKbArticle({
          title: title.trim(),
          slug: slug.trim(),
          body: body.trim(),
          category: category.trim(),
          tags: tagList,
        });
        toast.success('Created.');
      } else if (article) {
        await updateKbArticle(article.id, {
          title: title.trim(),
          body: body.trim(),
          category: category.trim(),
          tags: tagList,
        });
        toast.success('Updated.');
      }
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
        <DrawerTitle>{isNew ? 'New article' : 'Edit article'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Title</Label>
          <Input
            className="mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {isNew && (
          <div>
            <Label>Slug (URL-safe)</Label>
            <Input
              className="mt-1 font-mono text-xs"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="how-to-request-pto"
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Category</Label>
            <Input
              className="mt-1"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Benefits"
            />
          </div>
          <div>
            <Label>Tags (comma-separated)</Label>
            <Input
              className="mt-1"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="benefits, 401k, enrollment"
            />
          </div>
        </div>
        <div>
          <Label>Body (markdown)</Label>
          <textarea
            className="mt-1 w-full h-72 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm font-mono"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        {!isNew && article && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (!(await confirm({ title: 'Archive this article?', destructive: true }))) return;
              try {
                await archiveKbArticle(article.id);
                toast.success('Archived.');
                onSaved();
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Failed.');
              }
            }}
          >
            Archive
          </Button>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
