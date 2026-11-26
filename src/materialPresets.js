/**
 * Built-in materials. Values are in the panel's units:
 *   density g/m² · bend µN·m (bending modulus D) · stretch kN/m (E·t) · plasticity 0..1 · cd · friction 0..1
 * Bending values are "effective" ones at this mesh resolution (the film cannot show wrinkles smaller
 * than a mesh cell), calibrated so the HDPE bag reproduces the original look; the others keep
 * realistic ratios to it. `look` is optional and only changes the appearance.
 */
export const MATERIAL_PRESETS = [
  {
    id: 'hdpe',
    name: 'Bolsa de supermercado (HDPE)',
    density: 18, bend: 4.9, stretch: 18, plasticity: 0.88, cd: 1.0, friction: 0.3,
    look: { bagColor: '#2d89bd', opacity: 0.68, shine: 0.88, metal: 0 },
  },
  {
    id: 'ldpe',
    name: 'Bolsa gruesa de tienda (LDPE)',
    density: 46, bend: 20, stretch: 12, plasticity: 0.6, cd: 1.0, friction: 0.35,
    look: { bagColor: '#f8fafc', opacity: 0.88, shine: 0.6, metal: 0 },
  },
  {
    id: 'tissue',
    name: 'Papel de seda',
    density: 20, bend: 3, stretch: 60, plasticity: 0.95, cd: 1.1, friction: 0.4,
    look: { bagColor: '#fbcfe8', opacity: 0.9, shine: 0.08, metal: 0 },
  },
  {
    id: 'paper',
    name: 'Papel kraft',
    density: 80, bend: 300, stretch: 150, plasticity: 0.9, cd: 1.1, friction: 0.45,
    look: { bagColor: '#c8a27a', opacity: 1, shine: 0.12, metal: 0 },
  },
  {
    id: 'foil',
    name: 'Papel de aluminio',
    density: 40, bend: 20, stretch: 200, plasticity: 1, cd: 1.0, friction: 0.3,
    look: { bagColor: '#d4d8de', opacity: 1, shine: 0.96, metal: 1 },
  },
  {
    id: 'silk',
    name: 'Seda',
    density: 50, bend: 0.5, stretch: 3, plasticity: 0, cd: 1.0, friction: 0.15,
    look: { bagColor: '#a855f7', opacity: 1, shine: 0.7, metal: 0 },
  },
  {
    id: 'cotton',
    name: 'Algodón',
    density: 150, bend: 15, stretch: 5, plasticity: 0.1, cd: 1.2, friction: 0.6,
    look: { bagColor: '#e7e2d6', opacity: 1, shine: 0.05, metal: 0 },
  },
  {
    id: 'canvas',
    name: 'Lona / vinilo',
    density: 400, bend: 1500, stretch: 100, plasticity: 0.2, cd: 1.2, friction: 0.6,
    look: { bagColor: '#4d7c0f', opacity: 1, shine: 0.3, metal: 0 },
  },
  {
    id: 'latex',
    name: 'Goma fina (látex)',
    density: 300, bend: 0.5, stretch: 0.3, plasticity: 0, cd: 1.0, friction: 0.9,
    look: { bagColor: '#f97316', opacity: 1, shine: 0.5, metal: 0 },
  },
];

/** Panel slider for each material field (all in panel units). */
export const MATERIAL_FIELDS = {
  density: 'sliderDensity',
  bend: 'sliderBend',
  stretch: 'sliderStretch',
  plasticity: 'sliderPlastic',
  cd: 'sliderDrag',
  friction: 'sliderFriction',
};
