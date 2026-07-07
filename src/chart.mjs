// Генерация графиков: JSON-спецификация -> matplotlib (scripts/chart.py) -> PNG.
// Питон ищем в ./pyenv (venv с matplotlib), иначе системный python3.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'chart.py');

export function pythonBin() {
  const venv = join(ROOT, 'pyenv', 'bin', 'python3');
  if (existsSync(venv)) return venv;
  if (process.env.CHART_PYTHON && existsSync(process.env.CHART_PYTHON)) return process.env.CHART_PYTHON;
  return 'python3';
}

export function chartAvailable() {
  try {
    const r = spawnSync(pythonBin(), ['-c', 'import matplotlib'], { timeout: 15000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// spec: { type, title, xlabel, ylabel, labels[], series:[{name, values[]}] }
// Возвращает Buffer PNG или бросает ошибку.
export function renderChart(spec) {
  if (!spec || !Array.isArray(spec.labels) || !Array.isArray(spec.series) || !spec.series.length) {
    throw new Error('пустая спецификация графика');
  }
  const out = join(tmpdir(), `chart-${process.pid}-${Math.floor(Math.random() * 1e9)}.png`);
  try {
    const r = spawnSync(pythonBin(), [SCRIPT, out], {
      input: JSON.stringify(spec),
      timeout: 60000,
    });
    if (r.status !== 0) {
      throw new Error(`chart.py: ${String(r.stderr || '').slice(0, 300) || 'exit ' + r.status}`);
    }
    return readFileSync(out);
  } finally {
    rmSync(out, { force: true });
  }
}
