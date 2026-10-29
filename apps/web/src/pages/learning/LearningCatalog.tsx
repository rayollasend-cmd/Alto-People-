import { AlertTriangle, BookOpen, GraduationCap } from '@/components/ui/icons';
import { useAuth, useTerm } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { hasCapability } from '@/lib/roles';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { ListTemplate } from '@/components/templates';
import { useUrlParam } from '@/lib/useUrlState';
import { LEARNING_RELATED, LearningSummary } from './LearningSummary';
import { CoursesTab, EnrollmentsTab, ExpiringTab, TABS, type Tab } from './LearningHome';
import '@/lib/i18n/en/learning';

/**
 * /learning/catalog — the course catalog: courses, enrollments, expiring
 * certifications (PEOPLE-19). It used to render at /learning, under the Me
 * door with a "Me" breadcrumb, beside "My learning"; it is People ›
 * Courses & training now.
 */
export function LearningCatalog() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  // The tab lives in the URL (?tab=expiring), so the tiles and Back land on it.
  const [tab, setTab] = useUrlParam<Tab>('tab', 'courses', TABS, { history: 'push' });
  const { t } = useI18n();
  const term = useTerm();

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title={t('learning.catalogTitle')}
      subtitle={t('learning.subtitle')}
      breadcrumbs={[{ label: term('nav.people'), to: '/people' }, { label: t('learning.catalogTitle') }]}
      related={LEARNING_RELATED}
    >
      <LearningSummary />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="courses">
            <BookOpen className="mr-2 h-4 w-4" /> {t('learning.courses')}
          </TabsTrigger>
          <TabsTrigger value="enrollments">
            <GraduationCap className="mr-2 h-4 w-4" /> {t('learning.enrollments')}
          </TabsTrigger>
          <TabsTrigger value="expiring">
            <AlertTriangle className="mr-2 h-4 w-4" /> {t('learning.expiring')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="courses"><CoursesTab canManage={canManage} /></TabsContent>
        <TabsContent value="enrollments"><EnrollmentsTab canManage={canManage} /></TabsContent>
        <TabsContent value="expiring"><ExpiringTab /></TabsContent>
      </Tabs>
    </ListTemplate>
  );
}
