/**
 * Control panel behaviour, layered on top of plain HTML controls:
 *  - Tabs (remembers the last one per browser).
 *  - (i) buttons that unfold each control's explanation (the row's data-info text).
 *  - A typed number field next to every slider, kept in sync both ways.
 *  - A reset button (↺) that appears when a slider is away from its default value.
 *
 * Sliders keep their ids and still fire 'input' events, so the simulation code listens to them as before.
 * Setting a value from code: setControlValue(id, value) updates the slider, the number and the reset button.
 */

const TAB_KEY = 'bolsa-sim.tab';

function decimalsOf(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const isLog = (slider) => slider.dataset.log !== undefined;

/**
 * Value of a slider in its real units. Sliders marked data-log store log10 of the value,
 * so a wide range (e.g. 0.1 to 3000) gets the same resolution everywhere.
 */
export function getControlValue(id) {
  const slider = document.getElementById(id);
  const v = parseFloat(slider.value);
  return isLog(slider) ? 10 ** v : v;
}

/** Sets a slider (in real units) from code and notifies every listener. */
export function setControlValue(id, value) {
  const slider = document.getElementById(id);
  slider.value = String(isLog(slider) ? Math.log10(value) : value);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 3 significant digits, without exponent notation (for log-scale values). */
function fmtSig(v) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

function setupTabs(root) {
  const tabs = [...root.querySelectorAll('.tabs [data-tab]')];
  const panes = [...root.querySelectorAll('.tab-pane[data-tab]')];
  const show = (name) => {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of panes) p.hidden = p.dataset.tab !== name;
    try {
      localStorage.setItem(TAB_KEY, name);
    } catch {
      /* storage unavailable: the tab just isn't remembered */
    }
  };
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab));
  let saved = null;
  try {
    saved = localStorage.getItem(TAB_KEY);
  } catch {
    saved = null;
  }
  show(tabs.some((t) => t.dataset.tab === saved) ? saved : tabs[0].dataset.tab);
}

/** Adds the (i) button and the hidden explanation box to a row with data-info. */
function setupInfo(row) {
  const text = row.dataset.info;
  if (!text) return;
  const head = row.querySelector('.ctl-head') ?? row;
  const label = head.querySelector('label, .ctl-name');
  const btn = el('button', 'info-btn', { type: 'button', 'aria-expanded': 'false', title: 'Qué es esto' });
  btn.textContent = 'i';
  const name = label ? label.textContent.trim() : 'este control';
  btn.setAttribute('aria-label', `Información: ${name}`);
  (label ?? head).after(btn);

  const box = el('div', 'ctl-info');
  box.innerHTML = text; // trusted, authored in index.html
  box.hidden = true;
  head.after(box);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation(); // a click inside a <label> would otherwise also toggle its checkbox
    box.hidden = !box.hidden;
    btn.classList.toggle('open', !box.hidden);
    btn.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
  });
}

/** Adds the typed number field, unit and reset button to a slider row. */
function setupSlider(row) {
  const slider = row.querySelector('input[type="range"]');
  if (!slider || slider.dataset.plain !== undefined) return;
  const head = row.querySelector('.ctl-head');
  const log = isLog(slider);
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const step = slider.step === 'any' ? 0 : parseFloat(slider.step) || 1; // 0 = continuous
  const dec = step ? decimalsOf(slider.step || 1) : 2;
  const def = parseFloat(slider.defaultValue); // in slider units (log10 for log sliders)
  const toReal = (v) => (log ? 10 ** v : v);
  const toSlider = (r) => (log ? Math.log10(r) : r);
  const fmt = (v) => (log ? fmtSig(toReal(v)) : v.toFixed(dec)); // v in slider units

  const right = el('span', 'ctl-right');
  const num = el('input', 'ctl-num', {
    type: 'number',
    min: log ? fmtSig(toReal(min)) : slider.min,
    max: log ? fmtSig(toReal(max)) : slider.max,
    step: step ? slider.step : 'any',
    inputmode: 'decimal',
    'aria-label': head.querySelector('label')?.textContent.trim() ?? slider.id,
  });
  num.value = fmt(parseFloat(slider.value));
  right.append(num);
  if (slider.dataset.unit) {
    const unit = el('span', 'ctl-unit');
    unit.textContent = slider.dataset.unit;
    right.append(unit);
  }
  const reset = el('button', 'reset-btn', { type: 'button', title: `Volver al valor por defecto (${fmt(def)})` });
  reset.textContent = '↺';
  reset.setAttribute('aria-label', 'Restablecer valor por defecto');
  right.append(reset);
  head.append(right);

  const refresh = () => {
    const v = parseFloat(slider.value);
    if (document.activeElement !== num) num.value = fmt(v);
    reset.classList.toggle('visible', Math.abs(v - def) > (step ? step / 2 : 1e-4));
  };
  slider.addEventListener('input', refresh);

  const commit = () => {
    const typed = parseFloat(num.value);
    if (!Number.isFinite(typed) || (log && typed <= 0)) {
      num.value = fmt(parseFloat(slider.value));
      return;
    }
    let v = toSlider(typed);
    v = Math.min(max, Math.max(min, v));
    if (step) v = min + Math.round((v - min) / step) * step; // snap to the slider's grid
    num.value = fmt(v);
    if (Math.abs(v - parseFloat(slider.value)) > (step ? step / 4 : 1e-9)) {
      slider.value = String(v);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  num.addEventListener('change', commit);
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      num.blur();
    }
    e.stopPropagation(); // typing must not trigger the Space pause shortcut
  });
  num.addEventListener('blur', () => {
    num.value = fmt(parseFloat(slider.value));
  });
  reset.addEventListener('click', () => {
    slider.value = String(def);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  refresh();
}

export function setupPanel(root = document.getElementById('hudPanel')) {
  setupTabs(root);
  for (const row of root.querySelectorAll('.ctl')) {
    setupSlider(row);
    setupInfo(row);
  }
}
