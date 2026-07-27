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
  adminGetKbArticle,
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
  ErrorBanner,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const STATUS_VARIANT: Record<KbStatus, 'pending' | 'success' | 'outline'> = {
  DRAFT: 'pending',
  PUBLISHED: 'success',
  ARCHIVED: 'outline',
};

/** "How to request PTO?" → "how-to-request-pto". */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function RetryBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <ErrorBanner>
      <div className="flex items-center justify-between gap-3">
        <span>{message}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </ErrorBanner>
  );
}

export function KbHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const [tab, setTab] = useState<'browse' | 'admin'>('browse');

  // Browse search is debounced ~250ms so each keystroke doesn't fire a
  // request: qInput is what the user types, q is what we query with.
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 250);
    return () => clearTimeout(t);
  }, [qInput]);

  const [category, setCategory] = useState<string>('');
  const [articles, setArticles] = useState<KbArticleSummary[] | null>(null);
  const [articlesError, setArticlesError] = useState<string | null>(null);
  const [categories, setCategories] = useState<KbCategoryRow[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [adminRows, setAdminRows] = useState<KbAdminRow[] | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminStatus, setAdminStatus] = useState<KbStatus | ''>('');
  const [adminSearch, setAdminSearch] = useState('');
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [editing, setEditing] = useState<KbAdminRow | 'new' | null>(null);

  const loadCategories = () => {
    setCategoriesError(null);
    getKbCategories()
      .then((r) => setCategories(r.categories))
      .catch((err) =>
        setCategoriesError(
          err instanceof ApiError ? err.message : 'Could not load categories.',
        ),
      );
  };

  const loadBrowse = () => {
    setArticles(null);
    setArticlesError(null);
    searchKb({ q: q.trim() || undefined, category: category || undefined })
      .then((r) => setArticles(r.articles))
      .catch((err) =>
        setArticlesError(
          err instanceof ApiError ? err.message : 'Could not load articles.',
        ),
      );
  };

  const loadAdmin = () => {
    setAdminRows(null);
    setAdminError(null);
    adminListKb(adminStatus || undefined)
      .then((r) => setAdminRows(r.articles))
      .catch((err) =>
        setAdminError(
          err instanceof ApiError ? err.message : 'Could not load articles.',
        ),
      );
  };

  const refresh = () => {
    if (tab === 'browse') {
      loadBrowse();
    } else {
      loadAdmin();
    }
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, category, adminStatus]);
  useEffect(() => {
    loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Client-side search over the (server-filtered) admin slice.
  const filteredAdmin = useMemo(() => {
    if (adminRows === null) return null;
    const term = adminSearch.trim().toLowerCase();
    if (!term) return adminRows;
    return adminRows.filter(
      (a) =>
        a.title.toLowerCase().includes(term) ||
        a.slug.toLowerCase().includes(term) ||
        a.category.toLowerCase().includes(term),
    );
  }, [adminRows, adminSearch]);

  const startCreate = () => {
    setTab('admin');
    setEditing('new');
  };

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
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </div>
          {categoriesError ? (
            <RetryBanner message={categoriesError} onRetry={loadCategories} />
          ) : (
            categories.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant={category === '' ? 'secondary' : 'outline'}
                  size="xs"
                  onClick={() => setCategory('')}
                  aria-pressed={category === ''}
                >
                  All
                </Button>
                {categories.map((c) => (
                  <Button
                    key={c.category}
                    variant={category === c.category ? 'secondary' : 'outline'}
                    size="xs"
                    onClick={() => setCategory(c.category)}
                    aria-pressed={category === c.category}
                  >
                    {c.category}
                    <span className="ml-1 text-silver/70 tabular-nums">{c.count}</span>
                  </Button>
                ))}
              </div>
            )
          )}
          {articlesError && (
            <RetryBanner message={articlesError} onRetry={loadBrowse} />
          )}
          <Card>
            <CardContent className="p-0">
              {articlesError ? null : articles === null ? (
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
                      : canManage
                        ? 'Write the first article — policies, benefits, how-tos.'
                        : 'HR hasn’t published any articles yet.'
                  }
                  action={
                    !q && canManage ? (
                      <Button onClick={startCreate}>
                        <Plus className="mr-2 h-4 w-4" /> New article
                      </Button>
                    ) : undefined
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
                          <span className="flex items-center gap-1 text-success">
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
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-silver" />
              <Input
                className="pl-9"
                aria-label="Search title, slug, or category"
                placeholder="Search title, slug, or category…"
                value={adminSearch}
                onChange={(e) => setAdminSearch(e.target.value)}
              />
            </div>
            <Select
              size="sm"
              aria-label="Filter by status"
              value={adminStatus}
              onChange={(e) => setAdminStatus(e.target.value as KbStatus | '')}
            >
              <option value="">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="PUBLISHED">Published</option>
              <option value="ARCHIVED">Archived</option>
            </Select>
            {filteredAdmin !== null && (
              <span className="text-xs text-silver tabular-nums">
                {filteredAdmin.length}{' '}
                {filteredAdmin.length === 1 ? 'article' : 'articles'}
              </span>
            )}
          </div>
          {adminError && <RetryBanner message={adminError} onRetry={loadAdmin} />}
          <Card>
            <CardContent className="p-0">
              {adminError ? null : filteredAdmin === null ? (
                <div className="p-6">
                  <SkeletonRows count={4} />
                </div>
              ) : filteredAdmin.length === 0 ? (
                <EmptyState
                  icon={BookOpen}
                  title="No articles"
                  description={
                    adminSearch || adminStatus
                      ? 'Nothing matches this filter.'
                      : 'Create the first article.'
                  }
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead className="hidden sm:table-cell">Category</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden lg:table-cell">Views</TableHead>
                      <TableHead className="hidden md:table-cell">Helpful</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAdmin.map((a) => (
                      <TableRow key={a.id} className="group">
                        <TableCell>
                          <div className="font-medium text-white">{a.title}</div>
                          <div className="text-xs font-mono text-silver">
                            /{a.slug}
                          </div>
                          <div className="md:hidden text-[11px] text-silver/70 truncate">
                            <span className="sm:hidden">
                              {a.category}
                              {' · '}
                            </span>
                            <span className="tabular-nums">{a.helpful}</span> helpful
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-silver hidden sm:table-cell">
                          {a.category}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[a.status]}>
                            {a.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm hidden lg:table-cell">{a.views}</TableCell>
                        <TableCell className="text-sm text-success hidden md:table-cell">
                          {a.helpful}{' '}
                          {a.notHelpful > 0 && (
                            <span className="text-alert">/ {a.notHelpful}</span>
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
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete ${a.title}`}
                            className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-alert"
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
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
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
          categoryOptions={categories.map((c) => c.category)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
            loadCategories();
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setData(null);
    setError(null);
    getKbArticle(slug)
      .then(setData)
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load the article.',
        ),
      );
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        {error ? (
          <RetryBanner message={error} onRetry={refresh} />
        ) : !data ? (
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
  categoryOptions,
  onClose,
  onSaved,
}: {
  article: KbAdminRow | null;
  categoryOptions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const isNew = article === null;
  const [title, setTitle] = useState(article?.title ?? '');
  const [slug, setSlug] = useState(article?.slug ?? '');
  // Once the user hand-edits the slug, stop mirroring the title into it.
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [category, setCategory] = useState(article?.category ?? 'General');
  const [tags, setTags] = useState<string>((article?.tags ?? []).join(', '));
  const [body, setBody] = useState('');
  const [bodyLoading, setBodyLoading] = useState(!isNew);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the body through the admin endpoint so DRAFT and ARCHIVED
  // articles hydrate too — the public slug fetch only serves PUBLISHED
  // and silently produced an empty editor (data loss on save).
  const loadBody = () => {
    if (!article) return;
    setBodyLoading(true);
    setBodyError(null);
    adminGetKbArticle(article.id)
      .then((r) => setBody(r.article.body))
      .catch((err) =>
        setBodyError(
          err instanceof ApiError
            ? err.message
            : 'Could not load the article body.',
        ),
      )
      .finally(() => setBodyLoading(false));
  };
  useEffect(() => {
    loadBody();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            onChange={(e) => {
              setTitle(e.target.value);
              if (isNew && !slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </div>
        {isNew && (
          <div>
            <Label>Slug (URL-safe, auto-generated from the title)</Label>
            <Input
              className="mt-1 font-mono text-xs"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
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
              list="kb-category-options"
            />
            <datalist id="kb-category-options">
              {categoryOptions.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
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
          <Label>Body (plain text)</Label>
          {bodyError ? (
            <div className="mt-1">
              <RetryBanner message={bodyError} onRetry={loadBody} />
            </div>
          ) : (
            <Textarea
              className="mt-1 h-72 font-mono"
              value={bodyLoading ? 'Loading…' : body}
              disabled={bodyLoading}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
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
        <Button onClick={submit} disabled={saving || bodyLoading || bodyError !== null}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
