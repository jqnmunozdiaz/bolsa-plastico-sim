import { MATERIAL_PRESETS, MATERIAL_FIELDS } from './materialPresets.js';
import { setControlValue, getControlValue } from './panel.js';

/**
 * Material selector: built-in presets, the user's own saved materials (kept in this browser),
 * and JSON export/import to move them between browsers or share them.
 * Applying a material sets the Material-tab sliders (which drive the solver) and, optionally, the look.
 */

const STORE_KEY = 'bolsa-sim.materials';
const CUSTOM = '__custom';
const FIELDS = Object.keys(MATERIAL_FIELDS);

function loadUser() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(list) ? list.filter(isValidMaterial) : [];
  } catch {
    return [];
  }
}

function saveUser(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function isValidMaterial(m) {
  return (
    m && typeof m === 'object' && typeof m.name === 'string' && m.name.trim() !== '' &&
    FIELDS.every((k) => typeof m[k] === 'number' && Number.isFinite(m[k]))
  );
}

/** Keeps only known fields, clamped to the sliders' ranges (log sliders hold log10 values). */
function sanitize(m) {
  const out = { name: String(m.name).trim().slice(0, 60) };
  for (const k of FIELDS) {
    const slider = document.getElementById(MATERIAL_FIELDS[k]);
    const log = slider.dataset.log !== undefined;
    let lo = parseFloat(slider.min), hi = parseFloat(slider.max);
    if (log) { lo = 10 ** lo; hi = 10 ** hi; }
    out[k] = Math.min(hi, Math.max(lo, m[k]));
  }
  if (m.look && typeof m.look === 'object') {
    const L = m.look;
    const hex = /^#[0-9a-f]{6}$/i;
    out.look = {
      bagColor: hex.test(L.bagColor) ? L.bagColor : '#2d89bd',
      opacity: Math.min(1, Math.max(0.2, Number(L.opacity) || 1)),
      shine: Math.min(1, Math.max(0, Number(L.shine) || 0)),
      metal: Number(L.metal) > 0.5 ? 1 : 0,
    };
  }
  return out;
}

function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const n = `${name} (${i})`;
    if (!taken.has(n)) return n;
  }
}

/**
 * @param appearance object returned by setupAppearance (getLook / setLook)
 */
export function setupMaterials(appearance) {
  const $ = (id) => document.getElementById(id);
  const select = $('selMaterial');
  const chkLook = $('chkMaterialLook');
  let user = loadUser();
  let applying = false;

  function currentValues() {
    const m = {};
    for (const k of FIELDS) m[k] = Number(getControlValue(MATERIAL_FIELDS[k]).toPrecision(4));
    return m;
  }

  function rebuild(selected) {
    select.textContent = '';
    const g1 = document.createElement('optgroup');
    g1.label = 'Materiales';
    for (const p of MATERIAL_PRESETS) g1.append(new Option(p.name, `preset:${p.id}`));
    select.append(g1);
    if (user.length) {
      const g2 = document.createElement('optgroup');
      g2.label = 'Mis materiales';
      user.forEach((m, i) => g2.append(new Option(m.name, `user:${i}`)));
      select.append(g2);
    }
    select.append(new Option('Personalizado (valores modificados)', CUSTOM));
    select.value = selected;
    if (select.value !== selected) select.value = CUSTOM;
    $('btnDeleteMaterial').disabled = !select.value.startsWith('user:');
  }

  function find(value) {
    if (value.startsWith('preset:')) return MATERIAL_PRESETS.find((p) => `preset:${p.id}` === value);
    if (value.startsWith('user:')) return user[parseInt(value.slice(5), 10)];
    return null;
  }

  function apply(m) {
    applying = true;
    try {
      for (const k of FIELDS) setControlValue(MATERIAL_FIELDS[k], m[k]);
    } finally {
      applying = false;
    }
    if (chkLook.checked && m.look) appearance.setLook(m.look);
  }

  select.addEventListener('change', () => {
    const m = find(select.value);
    if (m) apply(m);
    $('btnDeleteMaterial').disabled = !select.value.startsWith('user:');
  });

  // Moving any material slider by hand turns the selection into "Personalizado"
  for (const id of Object.values(MATERIAL_FIELDS)) {
    $(id).addEventListener('input', () => {
      if (applying || select.value === CUSTOM) return;
      select.value = CUSTOM;
      $('btnDeleteMaterial').disabled = true;
    });
  }

  $('btnSaveMaterial').addEventListener('click', () => {
    const current = find(select.value);
    const suggestion = current && select.value.startsWith('user:') ? current.name : 'Mi material';
    const name = (window.prompt('Nombre del material:', suggestion) || '').trim();
    if (!name) return;
    const m = { name, ...currentValues() };
    if (chkLook.checked) m.look = appearance.getLook();
    const existing = user.findIndex((u) => u.name === name);
    if (existing >= 0) {
      if (!window.confirm(`Ya existe «${name}». ¿Sobrescribirlo?`)) return;
      user[existing] = sanitize(m);
    } else {
      user.push(sanitize(m));
    }
    if (!saveUser(user)) window.alert('No se pudo guardar en este navegador (almacenamiento bloqueado). Usa «Exportar».');
    rebuild(`user:${user.findIndex((u) => u.name === name)}`);
  });

  $('btnDeleteMaterial').addEventListener('click', () => {
    if (!select.value.startsWith('user:')) return;
    const i = parseInt(select.value.slice(5), 10);
    if (!window.confirm(`¿Eliminar «${user[i].name}» de tus materiales? Los valores actuales no cambian.`)) return;
    user.splice(i, 1);
    saveUser(user);
    rebuild(CUSTOM);
  });

  $('btnExportMaterials').addEventListener('click', () => {
    const materials = user.length ? user : [{ name: 'Material actual', ...currentValues(), look: appearance.getLook() }];
    const blob = new Blob([JSON.stringify({ app: 'bolsa-plastico-sim', version: 1, materials }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'materiales-bolsa.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('btnImportMaterials').addEventListener('click', () => $('fileMaterials').click());
  $('fileMaterials').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      if (file.size > 1e6) throw new Error('archivo demasiado grande');
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data && data.materials;
      if (!Array.isArray(list)) throw new Error('no contiene una lista de materiales');
      const valid = list.filter(isValidMaterial).map(sanitize);
      if (!valid.length) throw new Error('ningún material válido');
      const taken = new Set([...MATERIAL_PRESETS.map((p) => p.name), ...user.map((u) => u.name)]);
      for (const m of valid) {
        m.name = uniqueName(m.name, taken);
        taken.add(m.name);
        user.push(m);
      }
      saveUser(user);
      rebuild(`user:${user.length - valid.length}`);
      apply(user[user.length - valid.length]);
      const skipped = list.length - valid.length;
      window.alert(`Importados ${valid.length} material(es)${skipped ? `; ${skipped} ignorado(s) por datos incompletos` : ''}.`);
    } catch (err) {
      window.alert(`No se pudo importar: ${err.message}`);
    }
  });

  rebuild('preset:hdpe');
}
