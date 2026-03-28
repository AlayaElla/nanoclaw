import type { Lang } from './types.js';

export function t(lang: Lang, en: string, zh: string): string {
  return lang === 'zh' ? zh : en;
}

export function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtNum(n: number): string {
  return (n || 0).toLocaleString();
}

export function fmtCompactNum(n: number): string {
  if (!n) return '0';
  if (n < 1000) return n.toString();
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  if (n < 10000000) return (n / 1000000).toFixed(2) + 'M';
  return (n / 1000000).toFixed(1) + 'M';
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function fmtDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.replace('T', ' ').slice(0, 19);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function timeAgo(iso: string, lang: Lang): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t(lang, 'just now', '刚刚');
  if (mins < 60) return `${mins}${t(lang, 'm ago', '分钟前')}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}${t(lang, 'h ago', '小时前')}`;
  return `${Math.floor(hours / 24)}${t(lang, 'd ago', '天前')}`;
}

export function pageHeader(title: string, sub: string): string {
  return `<div class="page-header"><div class="page-title">${esc(title)}</div><div class="page-subtitle">${esc(sub)}</div></div>`;
}

export abstract class Page<T> {
  abstract render(props: T, lang: Lang): string;
}
