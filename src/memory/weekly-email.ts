import { serialize } from '../context-engine/validation.js';
import type { Summary } from './weekly-summary.js';

type Example = Summary['examples'][number];
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric',
  month: 'short', year: 'numeric' });
const MARKER = '--- Evidence (exact JSON, for verification) ---';
const EMPTY = 'No harness runs were recorded this week.';
const NOTE = 'The exact evidence JSON is in the plain-text part of this email.';
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function esc(v: string | number): string {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function weekEnding(dueAt: number): string {
  const p: Record<string, string> = {};
  for (const part of dateFormat.formatToParts(new Date(dueAt))) p[part.type] = part.value;
  return `${p.weekday}, ${p.day} ${p.month} ${p.year}`;
}
function files(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  const more = paths.length > 3 ? `, +${paths.length - 3} more` : '';
  return paths.length === 0 ? '0 files' : `${paths.length} ${paths.length === 1 ? 'file' : 'files'} (${shown}${more})`;
}
/** Examples carry no per-check verdict: "passed" counts the candidate-phase checks recorded, over all checks. */
function checksCell(e: Example): string {
  return `${e.checks.filter(c => c.phase === 'candidate').length}/${e.checks.length}`;
}
function review(e: Example): string { return e.review ? 'pass' : '—'; }
function stopped(s: Summary): [string, number][] {
  return Object.entries(s.authenticated.phases).filter(([, n]) => n > 0);
}

function textPart(s: Summary): string {
  const a = s.authenticated, o = a.outcomes, c = a.checks, r = a.reviews;
  const lines = ['ForgeMind weekly report', 'Week ending ' + weekEnding(s.dueAt), 'Project: ' + s.projectId, ''];
  if (a.runs === 0) lines.push(EMPTY);
  else lines.push(`Runs: ${a.runs}; completed ${o.completed}, failed ${o.failed}, blocked ${o.blocked}, indeterminate ${o.indeterminate}`);
  lines.push('', 'Checks and reviews',
    `Candidate checks passed: ${c.candidatePassed}`, `Candidate checks failed: ${c.candidateFailed}`,
    `Reviews: pass ${r.pass}, revise ${r.revise}, blocked ${r.blocked}, absent ${r.absent}`);
  const ph = stopped(s);
  if (ph.length) lines.push('', 'Where runs stopped', ...ph.map(([k, n]) => `${k}: ${n}`));
  if (s.examples.length) {
    lines.push('', 'Runs', ...s.examples.map(e => `- ${e.taskId}: ${files(e.changedPaths)}; checks ${checksCell(e)}; review ${review(e)}`));
    if (s.omittedExamples > 0) lines.push(`+${s.omittedExamples} more runs not shown`);
  }
  lines.push('', `Summary ${s.id.slice(0, 12)} · Digest ${s.digest.slice(0, 12)}`,
    `Fixture runs excluded: ${s.excludedFixtureCount}`);
  return lines.join('\n') + '\n\n' + MARKER + '\n' + serialize(s);
}

const tile = (n: number, label: string, color: string) =>
  `<td align="center" width="25%" style="padding:14px 4px;background:#ffffff;border:1px solid #e2e8f0">` +
  `<div style="font-size:28px;font-weight:700;color:${color}">${esc(n)}</div>` +
  `<div style="font-size:12px;color:#64748b">${label}</div></td>`;
const row = (label: string, value: string | number) =>
  `<tr><td style="padding:4px 0;color:#475569;font-size:14px">${label}</td>` +
  `<td align="right" style="padding:4px 0;color:#0f172a;font-size:14px;font-weight:600">${esc(value)}</td></tr>`;
const section = (title: string, inner: string) =>
  `<tr><td style="padding:18px 24px 6px"><div style="font-size:16px;font-weight:700;color:#0f172a;padding-bottom:6px">${title}</div>${inner}</td></tr>`;
const cell = (v: string) => `<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;vertical-align:top">${v}</td>`;

function htmlPart(s: Summary): string {
  const a = s.authenticated, o = a.outcomes, c = a.checks, r = a.reviews;
  const parts: string[] = [];
  parts.push(`<tr><td style="background:#0f172a;color:#ffffff;padding:24px">` +
    `<div style="font-size:22px;font-weight:700;color:#ffffff">ForgeMind weekly report</div>` +
    `<div style="font-size:14px;color:#ffffff;padding-top:6px">Week ending ${esc(weekEnding(s.dueAt))}</div>` +
    `<div style="font-size:12px;color:#cbd5e1;padding-top:4px">Project ${esc(s.projectId)}</div></td></tr>`);
  if (a.runs === 0) {
    parts.push(`<tr><td style="padding:28px 24px;text-align:center;color:#475569;font-size:15px">${EMPTY}</td></tr>`);
  } else {
    parts.push(`<tr><td style="padding:18px 20px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
      tile(a.runs, 'Runs', '#0f172a') + tile(o.completed, 'Completed', '#15803d') +
      tile(o.failed, 'Failed', '#b91c1c') + tile(o.blocked, 'Blocked', '#b45309') + `</tr></table></td></tr>`);
  }
  const tbl = (rows: string) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
  parts.push(section('Checks and reviews', tbl(row('Candidate checks passed', c.candidatePassed) +
    row('Candidate checks failed', c.candidateFailed) + row('Reviews pass', r.pass) + row('Reviews revise', r.revise) +
    row('Reviews blocked', r.blocked) + row('Reviews absent', r.absent))));
  const ph = stopped(s);
  if (ph.length) parts.push(section('Where runs stopped', tbl(ph.map(([k, n]) => row(esc(k), n)).join(''))));
  if (s.examples.length) {
    const head = ['Task', 'Files changed', 'Checks', 'Review'].map(h =>
      `<td style="padding:6px 8px;background:#f8fafc;border-bottom:1px solid #cbd5e1;font-size:12px;color:#64748b">${h}</td>`).join('');
    const body = s.examples.map(e => `<tr>${cell(esc(e.taskId))}${cell(esc(files(e.changedPaths)))}${cell(esc(checksCell(e)))}${cell(esc(review(e)))}</tr>`).join('');
    const more = s.omittedExamples > 0
      ? `<div style="padding-top:8px;font-size:13px;color:#64748b">+${esc(s.omittedExamples)} more runs not shown</div>` : '';
    parts.push(section('Runs', tbl(`<tr>${head}</tr>${body}`) + more));
  }
  parts.push(`<tr><td style="padding:20px 24px;font-size:12px;color:#94a3b8">` +
    `<div>Summary ${esc(s.id.slice(0, 12))} · Digest ${esc(s.digest.slice(0, 12))}</div>` +
    `<div>Fixture runs excluded: ${esc(s.excludedFixtureCount)}</div><div>${NOTE}</div></td></tr>`);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>ForgeMind weekly report</title></head><body style="margin:0;background:#f1f5f9">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f5f9" style="background:#f1f5f9"><tr><td align="center" style="padding:16px 8px">' +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;margin:0 auto;background:#ffffff;font-family:${FONT}">` +
    parts.join('') + '</table></td></tr></table></body></html>';
}

export function renderWeeklyEmail(summary: Summary): { text: string; html: string } {
  return { text: textPart(summary), html: htmlPart(summary) };
}
