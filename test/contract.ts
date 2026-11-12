/**
 * Vérificateur de contrat : compare chaque réponse réelle de l'API à openapi.yaml.
 *  - la route et la méthode doivent être documentées ;
 *  - le code de statut doit être documenté ;
 *  - le corps doit respecter le schéma (types, champs obligatoires, formats, énumérations) ;
 *  - aucun champ non documenté ne doit apparaître (le contrat reste exact dans les deux sens).
 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const spec: any = parse(readFileSync(join(__dirname, '..', 'openapi.yaml'), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'spec', components: spec.components });

const resolve = (n: any): any => {
  while (n && n.$ref) n = n.$ref.replace('#/', '').split('/').reduce((a: any, k: string) => a[k], spec);
  return n;
};
const rewrite = (o: any): any =>
  Array.isArray(o) ? o.map(rewrite)
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' ? v.replace(/^#\//, 'spec#/') : rewrite(v)]))
  : o;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const ops = Object.entries<any>(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({
    method: m.toUpperCase(), path, op: item[m],
    regex: new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$'),
    literals: path.split('/').filter((s) => s && !s.startsWith('{')).length,
  })),
);

const validators = new Map<string, ReturnType<typeof ajv.compile>>();
const validatorFor = (schema: any) => {
  const key = JSON.stringify(schema);
  let v = validators.get(key);
  if (!v) { v = ajv.compile(rewrite(schema)); validators.set(key, v); }
  return v;
};

function mergedProps(schema: any): { props: Record<string, any>; open: boolean } {
  const s = resolve(schema);
  const props: Record<string, any> = { ...(s.properties ?? {}) };
  let open = s.additionalProperties !== undefined && s.additionalProperties !== false;
  for (const sub of s.allOf ?? []) { const m = mergedProps(sub); Object.assign(props, m.props); open ||= m.open; }
  return { props, open };
}

function walk(schema: any, val: unknown, path: string, errs: string[]) {
  const s = resolve(schema);
  if (Array.isArray(val)) { if (s.items) val.forEach((v, i) => walk(s.items, v, `${path}[${i}]`, errs)); return; }
  if (!val || typeof val !== 'object') return;
  const { props, open } = mergedProps(s);
  const known = Object.keys(props);
  if (!open && known.length) for (const k of Object.keys(val)) if (!known.includes(k)) errs.push(`${path}.${k} : champ non documenté`);
  for (const [k, v] of Object.entries(val)) if (props[k]) walk(props[k], v, `${path}.${k}`, errs);
  if (s.additionalProperties && typeof s.additionalProperties === 'object') for (const [k, v] of Object.entries(val)) if (!props[k]) walk(s.additionalProperties, v, `${path}.${k}`, errs);
}

export function checkContract(method: string, url: string, status: number, rawBody: string): void {
  const path = url.split('?')[0].replace(/^\/api\/v1/, '');
  const candidates = ops.filter((o) => o.method === method.toUpperCase() && o.regex.test(path)).sort((a, b) => b.literals - a.literals);
  const label = `${method} ${path} → ${status}`;
  if (!candidates.length) throw new Error(`Contrat : route non documentée (${label})`);
  const { op } = candidates[0];
  if (process.env.CONTRACT_COVERAGE_FILE) appendFileSync(process.env.CONTRACT_COVERAGE_FILE, `${candidates[0].method} ${candidates[0].path} ${status}\n`);
  if (status >= 500 && status !== 502 && status !== 503) throw new Error(`Contrat : erreur serveur ${label} : ${rawBody.slice(0, 200)}`);
  const response = resolve(op.responses[String(status)] ?? op.responses.default);
  if (!response) throw new Error(`Contrat : statut non documenté (${label}) — documentés : ${Object.keys(op.responses).join(', ')}`);
  const media = response.content?.['application/json'];
  if (!media) { if (rawBody && status !== 200 && status !== 201) throw new Error(`Contrat : corps inattendu pour ${label}`); return; }
  if (!rawBody) throw new Error(`Contrat : corps attendu pour ${label}`);
  const body = JSON.parse(rawBody);
  const validate = validatorFor(media.schema);
  const errs: string[] = [];
  if (!validate(body)) for (const e of validate.errors ?? []) errs.push(`${e.instancePath || '(racine)'} ${e.message}${e.params && 'allowedValues' in e.params ? ` [${(e.params as any).allowedValues}]` : ''}`);
  walk(media.schema, body, '$', errs);
  if (errs.length) throw new Error(`Contrat violé : ${label}\n  - ${errs.slice(0, 8).join('\n  - ')}\n  réponse : ${rawBody.slice(0, 300)}`);
}
