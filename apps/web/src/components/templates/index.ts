/**
 * The five page templates (design system step 1, docs/design-system.md §4).
 * Every page names the template it is built on; the design walk groups its
 * screenshots by template so a reviewer compares like with like.
 *
 *   HomeTemplate      a role's home: hero, decisions, what changed, ways in
 *   ListTemplate      a list of records: header, filter row, grid, drawer
 *   RecordTemplate    one record: header with identity and status, tabs, timeline
 *   SettingsTemplate  an area of settings: left rail, sections with status
 *   DeskTemplate      a queue someone works: items, the open item, action, closure
 */
export { HomeTemplate, type HomeTemplateProps } from './HomeTemplate';
export { ListTemplate, type ListTemplateProps } from './ListTemplate';
export { RecordTemplate, type RecordTemplateProps, type RecordTab } from './RecordTemplate';
export { SettingsTemplate, type SettingsTemplateProps, type SettingsRailItem, SettingsSection, type SettingsSectionProps } from './SettingsTemplate';
export { DeskTemplate, type DeskTemplateProps } from './DeskTemplate';
