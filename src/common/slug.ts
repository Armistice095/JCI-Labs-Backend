import { randomBytes } from 'node:crypto';

export function slugify(input: string, max = 60): string {
  const s = input
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'evenement';
}

export function randomSuffix(len = 4): string {
  return randomBytes(len).toString('hex').slice(0, len);
}
