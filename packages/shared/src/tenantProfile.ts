import { z } from 'zod';

/**
 * Brief 2-1b — the tenant profile: what kind of organization a tenant is,
 * which modules it runs, and what it calls things.
 *
 *   businessModel  sets the defaults at tenant creation and is otherwise
 *                  informational (owner's decision 9); the code reads
 *                  `modules` and `terminology`, never the model.
 *   modules        the brief's twelve switches. Payroll itself is always
 *                  on; "payrollSync" means the integrations (decision 6).
 *   terminology    the three nouns (worker, site, manager) in singular and
 *                  plural, and the labels Hugo and the UI use most, in
 *                  EN / ES / TR. Validated JSON on the tenant (decision 7).
 */

export const BUSINESS_MODELS = ['DIRECT_EMPLOYER', 'WORKFORCE_PROVIDER', 'MANAGED_PROGRAM', 'HYBRID'] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];
export const BusinessModelSchema = /* @__PURE__ */ (() => z.enum(BUSINESS_MODELS))();

export const BUSINESS_MODEL_LABEL: Record<BusinessModel, string> = {
  DIRECT_EMPLOYER: 'Direct employer',
  WORKFORCE_PROVIDER: 'Workforce provider',
  MANAGED_PROGRAM: 'Managed program',
  HYBRID: 'Hybrid',
};

export const TENANT_MODULES = [
  'scheduling',
  'time',
  'hrCases',
  'compliance',
  'payrollSync',
  'housingLink',
  'transportation',
  'programs',
  'billRates',
  'clientPortal',
  'robotics',
  'agentBuilder',
  // The talent and perks long tail — corporate-HR surfaces a frontline or
  // seasonal operator may not run. On by default so nothing disappears for
  // an existing tenant; the Organization profile turns them off.
  'talent',
  'perks',
] as const;
export type TenantModule = (typeof TENANT_MODULES)[number];
export const TenantModuleSchema = /* @__PURE__ */ (() => z.enum(TENANT_MODULES))();

export const TENANT_MODULE_LABEL: Record<TenantModule, string> = {
  scheduling: 'Scheduling',
  time: 'Time and attendance',
  hrCases: 'HR cases',
  compliance: 'Compliance',
  payrollSync: 'Payroll sync (integrations)',
  housingLink: 'Housing link',
  transportation: 'Transportation',
  programs: 'Programs',
  billRates: 'Bill rates and margin',
  clientPortal: 'Client portal',
  robotics: 'Robotics',
  agentBuilder: 'Agent builder',
  talent: 'Talent programs (skills, career, mentorship, succession, probation, 30/60/90 plans, pulse)',
  perks: 'Perks (tuition, equity, volunteer match)',
};

export const TenantModulesSchema = /* @__PURE__ */ (() => z.object({
  scheduling: z.boolean(),
  time: z.boolean(),
  hrCases: z.boolean(),
  compliance: z.boolean(),
  payrollSync: z.boolean(),
  housingLink: z.boolean(),
  transportation: z.boolean(),
  programs: z.boolean(),
  billRates: z.boolean(),
  clientPortal: z.boolean(),
  robotics: z.boolean(),
  agentBuilder: z.boolean(),
  talent: z.boolean(),
  perks: z.boolean(),
}))();
export type TenantModules = z.infer<typeof TenantModulesSchema>;

const ALL_ON: TenantModules = {
  scheduling: true,
  time: true,
  hrCases: true,
  compliance: true,
  payrollSync: true,
  housingLink: true,
  transportation: true,
  programs: true,
  billRates: true,
  clientPortal: true,
  robotics: true,
  agentBuilder: true,
  talent: true,
  perks: true,
};

/** The switches a business model starts with. */
export function defaultModulesFor(model: BusinessModel): TenantModules {
  switch (model) {
    case 'DIRECT_EMPLOYER':
      return { ...ALL_ON, housingLink: false, transportation: false, programs: false, billRates: false, clientPortal: false, robotics: false, agentBuilder: false };
    case 'MANAGED_PROGRAM':
      return { ...ALL_ON, billRates: false, robotics: false, agentBuilder: false };
    case 'WORKFORCE_PROVIDER':
    case 'HYBRID':
      return { ...ALL_ON };
  }
}

export const TERM_LANGS = ['en', 'es', 'tr'] as const;
export type TermLang = (typeof TERM_LANGS)[number];

export const TermTextSchema = /* @__PURE__ */ (() => z.object({
  en: z.string().trim().min(1).max(60),
  es: z.string().trim().min(1).max(60),
  tr: z.string().trim().min(1).max(60),
}))();
export type TermText = z.infer<typeof TermTextSchema>;

/** The nouns and the labels the profile names. Keys are stable; the UI reads them through useTerm(). */
export const TERM_KEYS = [
  'worker',
  'workers',
  'site',
  'sites',
  'manager',
  'managers',
  'nav.people',
  'nav.scheduling',
  'nav.time',
  'nav.kiosk',
  'nav.hrCases',
  'nav.compliance',
  'nav.documents',
  'nav.payroll',
  'nav.transport',
  'nav.clients',
  'nav.programs',
  'nav.headcount',
  'role.associate',
  'role.shiftSupervisor',
  'role.floorSupervisor',
  'role.manager',
  'role.clientPortal',
  'role.transportationDirector',
  'role.driver',
  'label.client',
  'label.clients',
  'label.shift',
  'label.timesheet',
  'label.paystub',
  'label.supervisor',
  'label.supervisors',
  'label.store',
  'label.stores',
] as const;
export type TermKey = (typeof TERM_KEYS)[number];
export const TermKeySchema = /* @__PURE__ */ (() => z.enum(TERM_KEYS))();

export type Terminology = Record<TermKey, TermText>;
export const TerminologySchema = z
  .record(TermKeySchema, TermTextSchema)
  .refine((t) => TERM_KEYS.every((k) => k in t), { message: 'Every term key must be present.' }) as unknown as z.ZodType<Terminology>;

const t = (en: string, es: string, tr: string): TermText => ({ en, es, tr });

/** The words Alto HR uses today: the WORKFORCE_PROVIDER vocabulary. */
const WORKFORCE_TERMS: Terminology = {
  worker: t('Associate', 'Asociado', 'Çalışan'),
  workers: t('Associates', 'Asociados', 'Çalışanlar'),
  site: t('Store', 'Tienda', 'Mağaza'),
  sites: t('Stores', 'Tiendas', 'Mağazalar'),
  manager: t('Supervisor', 'Supervisor', 'Süpervizör'),
  managers: t('Supervisors', 'Supervisores', 'Süpervizörler'),
  'nav.people': t('People', 'Personas', 'Kişiler'),
  'nav.scheduling': t('Scheduling', 'Horarios', 'Planlama'),
  'nav.time': t('Time', 'Tiempo', 'Zaman'),
  'nav.kiosk': t('Kiosk', 'Kiosco', 'Kiosk'),
  'nav.hrCases': t('HR cases', 'Casos de RR. HH.', 'İK vakaları'),
  'nav.compliance': t('Compliance', 'Cumplimiento', 'Uyum'),
  'nav.documents': t('Documents', 'Documentos', 'Belgeler'),
  'nav.payroll': t('Payroll', 'Nómina', 'Bordro'),
  'nav.transport': t('Transportation', 'Transporte', 'Ulaşım'),
  'nav.clients': t('Clients', 'Clientes', 'Müşteriler'),
  'nav.programs': t('Programs', 'Programas', 'Programlar'),
  'nav.headcount': t('Headcount', 'Plantilla', 'Kadro'),
  'role.associate': t('Associate', 'Asociado', 'Çalışan'),
  'role.shiftSupervisor': t('Shift supervisor', 'Supervisor de turno', 'Vardiya süpervizörü'),
  'role.floorSupervisor': t('Floor supervisor', 'Supervisor de piso', 'Kat süpervizörü'),
  'role.manager': t('Manager', 'Gerente', 'Yönetici'),
  'role.clientPortal': t('Client portal', 'Portal del cliente', 'Müşteri portalı'),
  'role.transportationDirector': t('Transportation director', 'Director de transporte', 'Ulaşım direktörü'),
  'role.driver': t('Driver', 'Conductor', 'Sürücü'),
  'label.client': t('Client', 'Cliente', 'Müşteri'),
  'label.clients': t('Clients', 'Clientes', 'Müşteriler'),
  'label.shift': t('Shift', 'Turno', 'Vardiya'),
  'label.timesheet': t('Timesheet', 'Hoja de horas', 'Puantaj'),
  'label.paystub': t('Paystub', 'Recibo de pago', 'Maaş bordrosu'),
  'label.supervisor': t('Supervisor', 'Supervisor', 'Süpervizör'),
  'label.supervisors': t('Supervisors', 'Supervisores', 'Süpervizörler'),
  'label.store': t('Store', 'Tienda', 'Mağaza'),
  'label.stores': t('Stores', 'Tiendas', 'Mağazalar'),
};

/** A direct employer such as a hotel: team member / property / property manager. */
const DIRECT_EMPLOYER_TERMS: Terminology = {
  ...WORKFORCE_TERMS,
  worker: t('Team member', 'Miembro del equipo', 'Ekip üyesi'),
  workers: t('Team members', 'Miembros del equipo', 'Ekip üyeleri'),
  site: t('Property', 'Propiedad', 'Tesis'),
  sites: t('Properties', 'Propiedades', 'Tesisler'),
  manager: t('Property manager', 'Gerente de la propiedad', 'Tesis müdürü'),
  managers: t('Property managers', 'Gerentes de la propiedad', 'Tesis müdürleri'),
  'nav.people': t('Team', 'Equipo', 'Ekip'),
  'role.associate': t('Team member', 'Miembro del equipo', 'Ekip üyesi'),
  'role.shiftSupervisor': t('Shift lead', 'Líder de turno', 'Vardiya lideri'),
  'role.floorSupervisor': t('Floor lead', 'Líder de piso', 'Kat lideri'),
  'role.manager': t('Property manager', 'Gerente de la propiedad', 'Tesis müdürü'),
  'label.supervisor': t('Property manager', 'Gerente de la propiedad', 'Tesis müdürü'),
  'label.supervisors': t('Property managers', 'Gerentes de la propiedad', 'Tesis müdürleri'),
  'label.store': t('Property', 'Propiedad', 'Tesis'),
  'label.stores': t('Properties', 'Propiedades', 'Tesisler'),
};

export function defaultTerminologyFor(model: BusinessModel): Terminology {
  return model === 'DIRECT_EMPLOYER' ? { ...DIRECT_EMPLOYER_TERMS } : { ...WORKFORCE_TERMS };
}

export const TenantProfileSchema = /* @__PURE__ */ (() => z.object({
  businessModel: BusinessModelSchema,
  modules: TenantModulesSchema,
  terminology: TerminologySchema,
}))();
export type TenantProfile = z.infer<typeof TenantProfileSchema>;

/** A partial update: switches and terms given replace the stored ones; the rest keep their value. */
export const UpdateTenantProfileInputSchema = /* @__PURE__ */ (() => z.object({
  businessModel: BusinessModelSchema.optional(),
  modules: TenantModulesSchema.partial().strict().optional(),
  terminology: z.record(TermKeySchema, TermTextSchema.partial()).optional(),
  /** Reset modules and terminology to the business model's defaults before applying the rest. */
  resetToDefaults: z.boolean().optional(),
}))();
export type UpdateTenantProfileInput = z.infer<typeof UpdateTenantProfileInputSchema>;

/** The whole profile for a business model, before any override. */
export function defaultTenantProfile(model: BusinessModel): TenantProfile {
  return { businessModel: model, modules: defaultModulesFor(model), terminology: defaultTerminologyFor(model) };
}

/** The terms in one language, for a screen or a message. */
export function termsIn(profile: Pick<TenantProfile, 'terminology'>, lang: string | null | undefined): Record<TermKey, string> {
  const l: TermLang = lang?.toLowerCase().startsWith('es') ? 'es' : lang?.toLowerCase().startsWith('tr') ? 'tr' : 'en';
  return Object.fromEntries(TERM_KEYS.map((k) => [k, profile.terminology[k]?.[l] ?? profile.terminology[k]?.en ?? k])) as Record<TermKey, string>;
}
