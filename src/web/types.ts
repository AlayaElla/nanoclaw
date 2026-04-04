export type Lang = 'en' | 'zh';
export type Section =
  | 'overview'
  | 'agent'
  | 'tasks'
  | 'docs'
  | 'usage'
  | 'alerts'
  | 'settings'
  | 'logger';
export const SECTIONS: Section[] = [
  'overview',
  'agent',
  'tasks',
  'docs',
  'usage',
  'alerts',
  'settings',
  'logger',
];
