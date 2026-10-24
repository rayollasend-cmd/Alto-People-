import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  BookOpen,
  MessageSquare,
  Eye,
  Plus,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from '@/components/ui/icons';
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
import { useAssistant } from '@/lib/assistantContext';
import { useConfirm } from '@/lib/confirm';
import { useI18n } from '@/lib/i18n';
import { hasCapability } from '@/lib/roles';
import { statusLabel, statusTone } from '@/lib/status';
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
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { ListTemplate } from '@/components/templates';
import { Label } from '@/components/ui/Label';

/** "How to request PTO?" → "how-to-request-pto". */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function kbStatusLabel(t: ReturnType<typeof useI18n>['t'], s: KbStatus): string {
  switch (s) {
    case 'DRAFT': return t('kb.statusDraft');
    case 'PUBLISHED': return t('kb.statusPublished');
    case 'ARCHIVED': return t('kb.statusArchived');
    default: return statusLabel(s);
  }
}

function RetryBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <ErrorBanner
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t('kb.retry')}
        </Button>
      }
    >
      {message}
    </ErrorBanner>
  );
}

export function KbHome() {
  const { t } = useI18n();
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const assistant = useAssistant();
  const [tab, setTab] = useState<'browse' | 'admin'>('browse');

  // Browse search is debounced ~250ms so each keystroke doesn't fire a
  // request: qInput is what the user types, q is what we query with.
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput), 250);
    return () => clearTimeout(timer);
  }, [qInput]);

  const [category, setCategory] = useState<string>('');
  const [adminStatus, setAdminStatus] = useState<KbStatus | ''>('');
  const [adminSearch, setAdminSearch] = useState('');
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  // ?article=<slug> opens straight onto an article — the help sheet links
  // here. Read once; the query string is not kept in sync afterwards.
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get('article');
    if (slug) setOpenSlug(slug);
  }, []);
  const [editing, setEditing] = useState<KbAdminRow | 'new' | null>(null);
  // One in-flight action at a time — a double-click on Publish/Delete
  // used to fire the write twice.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const act = async (key: string, fn: () => void | Promise<void>) => {
    if (actionKey) return;
    setActionKey(key);
    try {
      await fn();
    } finally {
      setActionKey(null);
    }
  };

  const categoriesQuery = useQuery({ queryKey: ['kb', 'categories'], queryFn: () => getKbCategories() });
  const categories: KbCategoryRow[] = categoriesQuery.data?.categories ?? [];
  const categoriesError = categoriesQuery.error
    ? categoriesQuery.error instanceof ApiError
      ? categoriesQuery.error.message
      : t('kb.categoriesFailed')
    : null;
  const loadCategories = () => void categoriesQuery.refetch();

  const browseQuery = useQuery({
    queryKey: ['kb', 'browse', q.trim(), category],
    queryFn: () => searchKb({ q: q.trim() || undefined, category: category || undefined }),
    enabled: tab === 'browse',
  });
  const articles: KbArticleSummary[] | null = browseQuery.data?.articles ?? null;
  const articlesError = browseQuery.error
    ? browseQuery.error instanceof ApiError
      ? browseQuery.error.message
      : t('kb.articlesFailed')
    : null;

  const adminQuery = useQuery({
    queryKey: ['kb', 'admin', adminStatus],
    queryFn: () => adminListKb(adminStatus || undefined),
    enabled: tab !== 'browse',
  });
  const adminRows: KbAdminRow[] | null = adminQuery.data?.articles ?? null;
  const adminError = adminQuery.error
    ? adminQuery.error instanceof ApiError
      ? adminQuery.error.message
      : t('kb.articlesFailed')
    : null;

  const loadBrowse = () => void browseQuery.refetch();
  const loadAdmin = () => void adminQuery.refetch();
  const refresh = () => {
    if (tab === 'browse') loadBrowse();
    else loadAdmin();
  };

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
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title={t('kb.title')}
        subtitle={t('kb.subtitle')}
    >

      {/* Browse / Manage only for the people who manage articles: a
          one-option switch ("Browse") said nothing to everyone else. The
          trail comes from the nav (Me › Help center), not a hand-written
          "Workforce" crumb. */}
      {canManage && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl
            ariaLabel={t('kb.viewAria')}
            value={tab}
            onChange={(v) => setTab(v)}
            options={[
              { value: 'browse' as const, label: t('kb.tab.browse') },
              { value: 'admin' as const, label: t('kb.tab.admin') },
            ]}
          />
          {tab === 'admin' && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="mr-2 h-4 w-4" /> {t('kb.newArticle')}
            </Button>
          )}
        </div>
      )}

      {tab === 'browse' ? (
        <>
          <SearchInput
            placeholder={t('kb.searchPlaceholder')}
            aria-label={t('kb.searchAria')}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
          {categoriesError ? (
            <RetryBanner message={categoriesError} onRetry={loadCategories} />
          ) : (
            categories.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <FilterChip active={category === ''} onClick={() => setCategory('')}>
                  {t('kb.allCategories')}
                </FilterChip>
                {categories.map((c) => (
                  <FilterChip
                    key={c.category}
                    active={category === c.category}
                    onClick={() => setCategory(c.category)}
                  >
                    {c.category}
                    <span className="ml-1 text-silver/70 tabular-nums">{c.count}</span>
                  </FilterChip>
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
                  title={q ? t('kb.noMatches') : t('kb.noArticlesYet')}
                  description={
                    q
                      ? t('kb.noMatchesDesc')
                      : canManage
                        ? t('kb.writeFirstDesc')
                        : t('kb.noArticlesDesc')
                  }
                  action={
                    q ? undefined : canManage ? (
                      <Button onClick={startCreate}>
                        <Plus className="mr-2 h-4 w-4" /> {t('kb.newArticle')}
                      </Button>
                    ) : (
                      // Nothing published: the next step is a person to ask.
                      <span className="flex flex-wrap justify-center gap-2">
                        {assistant.available && (
                          <Button onClick={() => assistant.setOpen(true)}>
                            <MessageSquare className="mr-2 h-4 w-4" /> {t('kb.askHugo')}
                          </Button>
                        )}
                        <Button asChild variant={assistant.available ? 'outline' : 'primary'}>
                          <Link to="/hr-cases">{t('kb.askHr')}</Link>
                        </Button>
                      </span>
                    )
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
            <SearchInput
              wrapperClassName="flex-1 min-w-48"
              aria-label={t('kb.adminSearchAria')}
              placeholder={t('kb.adminSearchPlaceholder')}
              value={adminSearch}
              onChange={(e) => setAdminSearch(e.target.value)}
            />
            <Select
              size="sm"
              aria-label={t('kb.filterStatusAria')}
              value={adminStatus}
              onChange={(e) => setAdminStatus(e.target.value as KbStatus | '')}
            >
              <option value="">{t('kb.allStatuses')}</option>
              <option value="DRAFT">{t('kb.statusDraft')}</option>
              <option value="PUBLISHED">{t('kb.statusPublished')}</option>
              <option value="ARCHIVED">{t('kb.statusArchived')}</option>
            </Select>
            {filteredAdmin !== null && (
              <span className="text-xs text-silver tabular-nums">
                {filteredAdmin.length === 1
                  ? t('kb.oneArticle')
                  : t('kb.nArticles', { n: filteredAdmin.length })}
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
                  title={t('kb.noArticles')}
                  description={
                    adminSearch || adminStatus
                      ? t('kb.noFilterMatches')
                      : t('kb.createFirst')
                  }
                />
              ) : (
                <DataGrid<(typeof filteredAdmin)[number]>
                  id="kb-articles"
                  caption={t('kb.gridCaption')}
                  rows={filteredAdmin}
                  rowKey={(a) => a.id}
                  search={false}
                  urlState={false}
                  exportCsv={{ filename: 'kb-articles' }}
                  onRowClick={(a) => setEditing(a)}
                  rowActionLabel={(a) => t('kb.editName', { title: a.title })}
                  columns={[
                    {
                      key: 'title',
                      header: t('kb.fieldTitle'),
                      accessor: (a) => a.title,
                      sortable: true,
                      primary: true,
                      cell: (a) => (
                        <>
                          <div className="font-medium text-white">{a.title}</div>
                          <div className="text-xs font-mono text-silver">/{a.slug}</div>
                        </>
                      ),
                    },
                    { key: 'category', header: t('kb.fieldCategory'), accessor: (a) => a.category, sortable: true, cardMeta: true, className: 'text-sm text-silver' },
                    { key: 'status', header: t('kb.colStatus'), accessor: (a) => kbStatusLabel(t, a.status), sortable: true, cell: (a) => <Badge variant={statusTone(a.status)}>{kbStatusLabel(t, a.status)}</Badge> },
                    { key: 'views', header: t('kb.colViews'), accessor: (a) => a.views, sortable: true, searchable: false, align: 'right', className: 'text-sm tabular-nums' },
                    {
                      key: 'helpful',
                      header: t('kb.colHelpful'),
                      accessor: (a) => a.helpful,
                      csv: (a) => (a.notHelpful > 0 ? `${a.helpful} / ${a.notHelpful}` : String(a.helpful)),
                      sortable: true,
                      searchable: false,
                      align: 'right',
                      cardMeta: true,
                      className: 'text-sm text-success tabular-nums',
                      cell: (a) => (
                        <>
                          {a.helpful} {a.notHelpful > 0 && <span className="text-alert">/ {a.notHelpful}</span>}
                        </>
                      ),
                    },
                    {
                      key: 'actions',
                      header: t('kb.colActions'),
                      accessor: () => null,
                      searchable: false,
                      csv: () => '',
                      align: 'right',
                      stopRowClick: true,
                      className: 'space-x-2',
                      cell: (a) => (
                        <>
                          {a.status === 'DRAFT' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={actionKey === `pub-${a.id}`}
                              disabled={actionKey !== null}
                              onClick={() =>
                                void act(`pub-${a.id}`, async () => {
                                  try {
                                    await publishKbArticle(a.id);
                                    toast.success(t('kb.publishedToast'));
                                    refresh();
                                  } catch (err) {
                                    toast.error(err instanceof ApiError ? err.message : t('kb.failed'));
                                  }
                                })
                              }
                            >
                              {t('kb.publish')}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                            {t('kb.edit')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('kb.deleteName', { title: a.title })}
                            className="hover:text-alert"
                            loading={actionKey === `del-${a.id}`}
                            disabled={actionKey !== null}
                            onClick={async () => {
                              if (!(await confirm({ title: t('kb.deleteConfirm', { title: a.title }), destructive: true }))) return;
                              await act(`del-${a.id}`, async () => {
                                try {
                                  await deleteKbArticle(a.id);
                                  toast.success(t('kb.deletedToast'));
                                  refresh();
                                } catch (err) {
                                  toast.error(err instanceof ApiError ? err.message : t('kb.failed'));
                                }
                              });
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      ),
                    },
                  ]}
                />
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
    </ListTemplate>
  );
}

function ArticleDrawer({
  slug,
  onClose,
}: {
  slug: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const articleQuery = useQuery({ queryKey: ['kb', 'article', slug], queryFn: () => getKbArticle(slug) });
  const data: KbArticleDetail | null = articleQuery.data ?? null;
  const error = articleQuery.error
    ? articleQuery.error instanceof ApiError
      ? articleQuery.error.message
      : t('kb.articleFailed')
    : null;
  const refresh = () => void articleQuery.refetch();

  const vote = async (helpful: boolean) => {
    if (!data) return;
    setBusy(true);
    try {
      await voteKbArticle(data.id, helpful);
      toast.success(t('kb.voteThanks'));
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('kb.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.title ?? t('kb.loading')}</DrawerTitle>
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
                {t('kb.wasHelpful')}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={data.myVote?.helpful === true ? 'primary' : 'ghost'}
                  onClick={() => vote(true)}
                  disabled={busy}
                >
                  <ThumbsUp className="mr-1 h-3 w-3" /> {t('kb.voteYes', { n: data.helpful })}
                </Button>
                <Button
                  size="sm"
                  variant={data.myVote?.helpful === false ? 'primary' : 'ghost'}
                  onClick={() => vote(false)}
                  disabled={busy}
                >
                  <ThumbsDown className="mr-1 h-3 w-3" /> {t('kb.voteNo', { n: data.notHelpful })}
                </Button>
              </div>
            </div>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>
          <ArrowLeft className="mr-2 h-4 w-4" /> {t('kb.backToResults')}
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
  const { t } = useI18n();
  const confirm = useConfirm();
  const isNew = article === null;
  const [title, setTitle] = useState(article?.title ?? '');
  const [slug, setSlug] = useState(article?.slug ?? '');
  // Once the user hand-edits the slug, stop mirroring the title into it.
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [category, setCategory] = useState(article?.category ?? 'General');
  const [tags, setTags] = useState<string>((article?.tags ?? []).join(', '));
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  // The body is read through the admin endpoint so DRAFT and ARCHIVED
  // articles hydrate too — the public slug read only serves PUBLISHED and
  // silently produced an empty editor (data loss on save). The editor
  // seeds itself from the read once; typing is local from then on.
  const bodyQuery = useQuery({
    queryKey: ['kb', 'admin-article', article?.id ?? ''],
    queryFn: () => adminGetKbArticle(article!.id),
    enabled: !isNew,
  });
  useEffect(() => {
    if (bodyQuery.data) setBody(bodyQuery.data.article.body);
  }, [bodyQuery.data]);
  const bodyLoading = !isNew && bodyQuery.isPending;
  const loadBody = () => void bodyQuery.refetch();
  const bodyError = bodyQuery.error
    ? bodyQuery.error instanceof ApiError
      ? bodyQuery.error.message
      : t('kb.bodyFailed')
    : null;

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
      toast.error(t('kb.titleBodyRequired'));
      return;
    }
    if (isNew && !slug.match(/^[a-z0-9-]+$/)) {
      toast.error(t('kb.slugInvalid'));
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
        toast.success(t('kb.createdToast'));
      } else if (article) {
        await updateKbArticle(article.id, {
          title: title.trim(),
          body: body.trim(),
          category: category.trim(),
          tags: tagList,
        });
        toast.success(t('kb.updatedToast'));
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('kb.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{isNew ? t('kb.newArticle') : t('kb.editArticle')}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{t('kb.fieldTitle')}</Label>
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
            <Label>{t('kb.fieldSlug')}</Label>
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
            <Label>{t('kb.fieldCategory')}</Label>
            <Input
              className="mt-1"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={t('kb.categoryPlaceholder')}
              list="kb-category-options"
            />
            <datalist id="kb-category-options">
              {categoryOptions.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <Label>{t('kb.fieldTags')}</Label>
            <Input
              className="mt-1"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('kb.tagsPlaceholder')}
            />
          </div>
        </div>
        <div>
          <Label>{t('kb.fieldBody')}</Label>
          {bodyError ? (
            <div className="mt-1">
              <RetryBanner message={bodyError} onRetry={loadBody} />
            </div>
          ) : bodyLoading ? (
            <Skeleton className="mt-1 h-72 w-full" />
          ) : (
            <Textarea
              className="mt-1 h-72 font-mono"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
        </div>
        {!isNew && article && (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={async () => {
              if (!(await confirm({ title: t('kb.archiveConfirm'), destructive: true }))) return;
              if (saving) return;
              setSaving(true);
              try {
                await archiveKbArticle(article.id);
                toast.success(t('kb.archivedToast'));
                onSaved();
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : t('kb.failed'));
              } finally {
                setSaving(false);
              }
            }}
          >
            {t('kb.archive')}
          </Button>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={submit} disabled={saving || bodyLoading || bodyError !== null}>
          {saving ? t('kb.saving') : t('kb.save')}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
