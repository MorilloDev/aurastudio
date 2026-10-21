"use strict";

// Atlas: the tile sheets as the game uses them. Cells are selected, moved, swapped, copied and emptied right on the PNG,
// and every move takes the sheet's normal maps along (_n, _d…) and rewrites the [x, y] of every tile JSON that points
// at those cells, so sprites, maps and data never disagree. The inspector edits the tiles themselves (form or raw JSON),
// creates new ones on a cell, and receives what the Crear tab sends ("Enviar al Atlas"). One undo history covers pixels
// and JSON together; Ctrl+S writes only the files that changed, with a backup to put them back.
(function (Aura) {
  const { h, clear, rafThrottle } = Aura.dom;
  const { History } = Aura.history;
  const { Viewport } = Aura.viewport;
  const { prefs } = Aura.storage;
  const { readText, writeHandle, writeInDir, stripExt } = Aura.fs;
  const { section, select, segmented } = Aura.controls;
  const { listSheets } = Aura.sheetFiles;
  const { addToMgcb } = Aura.mgcb;
  const { COMPANIONS, SheetImage } = Aura.atlasLayers;
  const T = Aura.atlasTiles;
  const Tint = Aura.tint;
  const TP = Aura.tintPanel;

  const ck = (x, y) => x + "," + y;
  const pk = (key) => key.split(",").map(Number);
  const sortCells = (cells) => cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const TINT_TAG = "biome_tinted";
  const isTinted = (tile) => Array.isArray(tile?.tags) && tile.tags.some((t) => String(t).toLowerCase() === TINT_TAG);

  // Starting points for "Nuevo tile": the keys a fresh tile of that kind needs, nothing the game already defaults.
  const TILE_KINDS = [
    ["block", "Bloque", { type: "solid", hardness: 1 }],
    ["plant", "Planta", { type: "solid", hardness: 0, collision: "none", shaderEffect: "wind" }],
    ["art", "Solo arte", {}],
  ];

  const FORM_FIELDS = [
    { key: "name", label: "Nombre", kind: "text" },
    { key: "id", label: "Id", kind: "text", hint: "del nombre" },
    { key: "type", label: "Tipo", kind: "select", options: ["", "solid", "liquid", "air"] },
    { key: "hardness", label: "Dureza", kind: "number", hint: "-1 = irrompible" },
    { key: "tags", label: "Etiquetas", kind: "tags", hint: "wood, flammable…" },
    { key: "shaderEffect", label: "Efecto", kind: "select", options: ["", "none", "wind", "wind_tall", "water", "glass"] },
    { key: "collision", label: "Colisión", kind: "select", options: ["", "none", "full"] },
    { key: "luminosity", label: "Luz", kind: "number", hint: "0" },
  ];

  // Every key TileInfo reads from a tile (TileData.ParseTileList), grouped like the game thinks of them. "path" is the key,
  // dotted for objects ("placement.on"); a value equal to "def" is left out of the file, as the game falls back to it.
  // kinds: text · number · check · select · tags · list (strings) · color · range ([a, b]) · vec3 · attach · drops ·
  // collision · json (the rare structured keys: layers, flow, colour variants, snowfall).
  const KNOWN_TAGS = ["fragile", "stackable", "transparent", "see_through", "no_collision", "liquid", "requires_solid_ground",
    "leaf", "log", "slab", "flammable", "biome_tinted", "herb", "wood", "snow", "flicker", "needs_pickaxe", "needs_axe",
    "needs_shovel", "gravity", "anchor", "heat", "danger"];
  const TILE_GROUPS = [
    { id: "basic", title: "Básico", open: true, fields: [
      { path: "name", label: "Nombre", kind: "text" },
      { path: "id", label: "Id", kind: "text", hint: "del nombre" },
      { path: "type", label: "Tipo", kind: "select", options: ["", "solid", "liquid", "air"], free: true, title: "«liquid» fluye; el resto es libre (se usa para polvo y sonidos)" },
      { path: "hardness", label: "Dureza", kind: "number", hint: "-1 = irrompible", def: -1 },
      { path: "harvestTier", label: "Tier mínimo", kind: "number", hint: "0", def: 0, title: "Tier de herramienta necesario para que suelte sus drops" },
      { path: "tags", label: "Etiquetas", kind: "tags" },
      { path: "drops", label: "Suelta", kind: "drops" },
    ] },
    { id: "light", title: "Luz", fields: [
      { path: "luminosity", label: "Luz", kind: "number", hint: "0", def: 0 },
      { path: "lightColor", label: "Color", kind: "color" },
      { path: "lightRadius", label: "Radio", kind: "number", hint: "400", def: 400 },
      { path: "lightVerticalFalloff", label: "Caída vertical", kind: "number", hint: "4", def: 4 },
      { path: "lightOpacity", label: "Opacidad a luz", kind: "number", hint: "auto", title: "Cuánto frena la luz de antorchas (0–15). Vacío = según el tile" },
      { path: "sunOpacity", label: "Opacidad al sol", kind: "number", hint: "auto", title: "Cuánto frena el sol (0–15). Vacío = según el tile" },
    ] },
    { id: "shape", title: "Forma y dibujo", fields: [
      { path: "collision", label: "Colisión", kind: "collision" },
      { path: "rotatable", label: "Se puede girar (R)", kind: "check", def: false },
      { path: "rotatableVertical", label: "Se puede poner boca abajo", kind: "check", def: false },
      { path: "shaderEffect", label: "Efecto", kind: "select", options: ["", "none", "wind", "wind_tall", "water", "glass"] },
      { path: "sheetId", label: "Hoja propia", kind: "text", hint: "la del archivo", title: "Atlas de este tile si no es el de su archivo" },
      { path: "pathMalus", label: "Coste al pisar (IA)", kind: "number", hint: "0", def: 0 },
    ] },
    { id: "place", title: "Colocación y hábitat", fields: [
      { path: "placement.attach", label: "Se apoya en", kind: "attach" },
      { path: "placement.on", label: "Solo sobre", kind: "list", hint: "ids o #tags; vacío = cualquier sólido" },
      { path: "placement.notOn", label: "Nunca sobre", kind: "list", hint: "ids o #tags" },
      { path: "placement.dropsWithoutSupport", label: "Se rompe si pierde el apoyo", kind: "check", def: true },
      { path: "habitat", label: "Hábitat", kind: "select", options: ["", "land", "submerged", "emergent", "floating"] },
      { path: "spawnOn", label: "Aparece sobre", kind: "list", hint: "ids o #tags (generación)" },
      { path: "tillsTo", label: "La azada lo convierte en", kind: "text", hint: "id de tile" },
    ] },
    { id: "growth", title: "Crecimiento", fields: [
      { path: "growth.type", label: "Tipo", kind: "select", options: ["", "column", "revert"], labels: { "": "por etapas", column: "columna", revert: "revertir" } },
      { path: "growth.next", label: "Siguiente etapa", kind: "text", hint: "id de tile" },
      { path: "growth.middle", label: "Tile del medio", kind: "text", hint: "columna" },
      { path: "growth.top", label: "Tile de arriba", kind: "text", hint: "columna" },
      { path: "growth.maxHeight", label: "Altura máx.", kind: "number", hint: "0 = hasta topar" },
      { path: "growth.into", label: "Se convierte en", kind: "text", hint: "revertir" },
      { path: "growth.days", label: "Días por paso", kind: "range", hint: ["mín", "máx"] },
      { path: "growth.light", label: "Luz (0–1)", kind: "range", hint: ["mín", "máx"] },
      { path: "growth.climate.temperature", label: "Temperatura", kind: "range", hint: ["mín", "máx"] },
      { path: "growth.climate.humidity", label: "Humedad", kind: "range", hint: ["mín", "máx"] },
      { path: "growth.nearWater", label: "Agua a ≤ celdas", kind: "number" },
      { path: "growth.waterBoost", label: "Acelera con agua ×", kind: "number" },
      { path: "growth.fertilizer", label: "Abonos", kind: "list", hint: "ids de items" },
      { path: "growth.unlessPlanted", label: "No revierte si tiene planta", kind: "check", def: false },
      { path: "growth.unlessWater", label: "No revierte con agua a ≤", kind: "number" },
    ] },
    { id: "station", title: "Estación y almacén", fields: [
      { path: "interactable", label: "Se puede usar (clic)", kind: "check", def: false },
      { path: "stationType", label: "Estación", kind: "select", options: ["", "workbench", "furnace", "crucible", "cauldron", "campfire", "engraving_table", "scribe_table", "smithing_table", "storage"], free: true },
      { path: "stationSlots", label: "Ranuras", kind: "number", def: 0 },
      { path: "openSound", label: "Sonido al abrir", kind: "text", hint: "id de sonido" },
      { path: "closeSound", label: "Sonido al cerrar", kind: "text", hint: "id de sonido" },
      { path: "storage.columns", label: "Almacén: columnas", kind: "number" },
      { path: "storage.rows", label: "Almacén: filas", kind: "number" },
      { path: "storage.double", label: "Cofre doble", kind: "double" },
    ] },
    { id: "emitter", title: "Emisor (llama, sonido)", fields: [
      { path: "emitter.effect", label: "Efecto", kind: "text", hint: "sprite_effects.json" },
      { path: "emitter.sound", label: "Sonido en bucle", kind: "text", hint: "id de sonido" },
      { path: "emitter.default", label: "Punto", kind: "vec3" },
      { path: "emitter.wall", label: "Punto en pared", kind: "vec3" },
    ] },
    { id: "more", title: "Avanzado", fields: [
      { path: "layers", label: "Capas (nieve…)", kind: "json", title: "[{ \"name\", \"height\", \"art\", \"drops\" }, …]" },
      { path: "snowfall", label: "Nevada", kind: "json" },
      { path: "flow", label: "Flujos (líquidos)", kind: "json" },
      { path: "colorVariants", label: "Variantes de color", kind: "json" },
      { path: "allowedTiles", label: "allowedTiles (antiguo)", kind: "list", title: "Forma antigua de placement.on: muévelo allí" },
    ] },
  ];

  // Every key ItemRegistry.ParseItem reads, by item type ("types": the groups that only apply to some). Enum lists hold
  // the values the project uses; the selects marked free take any other a mod or a new enum value needs.
  const ITEM_TYPES = ["MiscItem", "Material", "ConsumableItem", "TileItem", "ToolItem", "EquipItem", "MeleeWeapon", "RangedWeapon", "MagicWeapon", "RuneItem", "MagicPaperItem"];
  const WEAPONS = ["MeleeWeapon", "RangedWeapon", "MagicWeapon"];
  const ITEM_GROUPS = [
    { id: "common", title: "Básico", open: true, fields: [
      { path: "name", label: "Nombre", kind: "text" },
      { path: "id", label: "Id", kind: "text", hint: "del nombre" },
      { path: "desc", label: "Descripción", kind: "text" },
      { path: "type", label: "Tipo", kind: "select", options: ITEM_TYPES, required: true },
      { path: "maxStack", label: "Pila máx.", kind: "number", hint: "1", def: 1 },
      { path: "sheetId", label: "Hoja del icono", kind: "text", hint: "la del archivo" },
    ] },
    { id: "misc", title: "Material", types: ["MiscItem", "Material"], fields: [
      { path: "itemType", label: "Clase", kind: "select", options: ["", "Material", "None", "Key", "Quest"], free: true },
    ] },
    { id: "tile", title: "Coloca", types: ["TileItem"], open: true, fields: [
      { path: "tile", label: "Tile", kind: "text", hint: "id del tile" },
      { path: "tileType", label: "tileType", kind: "text", title: "Grupo del tile (antiguo; se sigue leyendo)" },
    ] },
    { id: "consumable", title: "Consumible", types: ["ConsumableItem"], open: true, fields: [
      { path: "consumableType", label: "Clase", kind: "select", options: ["Food", "Potion"], free: true, required: true },
      { path: "consumeDuration", label: "Tarda (s)", kind: "number", hint: "0", def: 0 },
      { path: "effects", label: "Efectos", kind: "effects" },
    ] },
    { id: "tool", title: "Herramienta", types: ["ToolItem"], open: true, fields: [
      { path: "toolType", label: "Herramienta", kind: "select", options: ["Pickaxe", "Axe", "Shovel", "Hoe", "Hammer"], free: true, required: true },
      { path: "tier", label: "Tier", kind: "number", hint: "0", def: 0 },
      { path: "maxDurability", label: "Durabilidad", kind: "number", hint: "0 = infinita", def: 0 },
    ] },
    { id: "weapon", title: "Arma", types: WEAPONS, open: true, fields: [
      { path: "meleeType", label: "Cuerpo a cuerpo", kind: "select", options: ["Dagger", "Sword", "Spear", "Greatsword"], free: true, onlyFor: ["MeleeWeapon"], required: true },
      { path: "rangedType", label: "A distancia", kind: "select", options: ["Bow", "Longbow", "Crossbow"], free: true, onlyFor: ["RangedWeapon"], required: true },
      { path: "magicType", label: "Mágica", kind: "select", options: ["Staff", "Grimoire", "Wand"], free: true, onlyFor: ["MagicWeapon"], required: true },
      { path: "baseDamage", label: "Daño", kind: "number", required: true },
      { path: "grip", label: "Agarre", kind: "select", options: ["", "OneHanded", "TwoHanded", "Versatile", "Bow"], labels: { "": "(según el tipo)" } },
      { path: "material", label: "Material", kind: "text", hint: "wood" },
      { path: "maxDurability", label: "Durabilidad", kind: "number", hint: "0", def: 0 },
      { path: "attackSpeed", label: "Velocidad", kind: "number", hint: "1", def: 1, onlyFor: ["MeleeWeapon"] },
      { path: "basePenetration", label: "Penetración", kind: "number", def: 0, onlyFor: ["MeleeWeapon"] },
      { path: "baseCritChance", label: "Prob. crítico", kind: "number", def: 0, onlyFor: ["MeleeWeapon"] },
      { path: "baseCritDamage", label: "Daño crítico", kind: "number", def: 0, onlyFor: ["MeleeWeapon"] },
      { path: "baseAttackRange", label: "Alcance extra", kind: "number", def: 0, onlyFor: ["MeleeWeapon"] },
      { path: "baseKnockbackForce", label: "Empuje", kind: "number", def: 0, onlyFor: ["MeleeWeapon"] },
      { path: "baseMagicDamageBonus", label: "Bonus mágico", kind: "number", def: 0, onlyFor: ["MeleeWeapon"] },
      { path: "baseRuneAmplification", label: "Amplif. de runas", kind: "number", def: 0, onlyFor: ["MeleeWeapon"] },
      { path: "maxAmmo", label: "Munición máx.", kind: "number", def: 0, onlyFor: ["RangedWeapon"] },
      { path: "spellPower", label: "Poder mágico", kind: "number", def: 0, onlyFor: ["MagicWeapon"] },
      { path: "spellSlotCount", label: "Hechizos", kind: "number", hint: "1", def: 1, onlyFor: ["MagicWeapon"] },
    ] },
    { id: "equip", title: "Equipo", types: ["EquipItem"], open: true, fields: [
      { path: "equipSlot", label: "Ranura", kind: "select", options: ["Head", "Chest", "Legs", "Feet", "Hands", "Arms", "Necklace", "Earring", "Bag"], free: true, required: true },
      { path: "maxDurability", label: "Durabilidad", kind: "number", def: 0 },
      { path: "runeSlotCount", label: "Ranuras de runa", kind: "number", def: 0 },
      { path: "modSlotCount", label: "Ranuras de mod", kind: "number", def: 0 },
      { path: "baseDefense", label: "Defensa", kind: "number", def: 0 },
      { path: "basePhysicalResist", label: "Resist. física", kind: "number", def: 0 },
      { path: "baseMagicResist", label: "Resist. mágica", kind: "number", def: 0 },
      { path: "baseMovementSpeed", label: "Velocidad", kind: "number", def: 0 },
      { path: "baseStaminaRegenBonus", label: "Regen. estamina", kind: "number", def: 0 },
      { path: "baseManaRegenBonus", label: "Regen. maná", kind: "number", def: 0 },
    ] },
    { id: "rune", title: "Runa", types: ["RuneItem"], open: true, fields: [
      { path: "categories", label: "Categorías", kind: "list", hint: "Fire, Area…" },
      { path: "role", label: "Rol", kind: "select", options: ["", "Effect", "Modifier"], labels: { "": "(Effect)" } },
      { path: "isPassive", label: "Pasiva", kind: "check", def: false },
      { path: "adjective", label: "Adjetivo", kind: "text", hint: "Mighty…" },
      { path: "effectData.amount", label: "Cantidad", kind: "number" },
      { path: "effectData.duration", label: "Duración (s)", kind: "number" },
      { path: "effectData.tickInterval", label: "Cada (s)", kind: "number" },
    ] },
    { id: "hold", title: "En la mano y modelo", fields: [
      { path: "model", label: "Modelo", kind: "list", hint: "archivo.glb|Nodo, …", single: true },
      { path: "textureSheet", label: "Textura del modelo", kind: "text", hint: "materials" },
      { path: "offhand", label: "Va en la mano secundaria", kind: "check", def: false },
      { path: "holdPose", label: "Pose", kind: "text", hint: "TorchInHand…" },
      { path: "heldEffect.node", label: "Efecto: nodo", kind: "text", hint: "Torch_Flame" },
      { path: "heldEffect.effect", label: "Efecto: nombre", kind: "text", hint: "el del tile" },
      { path: "heldEffect.offset", label: "Efecto: desplazamiento", kind: "vec3" },
      { path: "light", label: "Luz en la mano", kind: "json", title: "La de su tile en los items de tile" },
    ] },
  ];

  // What "Nuevo item" writes: a stackable material, the most common kind of icon added to a sheet.
  const NEW_ITEM = { type: "MiscItem", maxStack: 64, itemType: "Material" };

  const getPath = (obj, path) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

  function atlasTool() {
    return new AtlasTool();
  }

  class AtlasTool {
    id = "atlas";
    title = "Atlas";
    project = null;
    docs = [];
    refs = [];
    sheets = [];
    sheet = null;           // the open sheet (sheetFiles entry of an atlas)
    img = null;             // its SheetImage
    grid = { w: 64, h: 64 };
    view = "";              // layer shown: "" colour, "_n", "_d"…
    showMarks = true;
    selection = new Set();  // "x,y" grid cells
    tile = null;            // tile object open in the inspector
    pending = null;         // a placement sent from Crear, waiting for its cell
    placed = null;          // the last placement, until a tile is made for it
    picking = null;         // { label, apply(cell) } while the next click sets an art coordinate
    history = new History({ limit: 200 });
    tint = Tint.merge(prefs.get("atlas:tint", {}));
    biomes = [Tint.DEFAULT_TINT];
    grayPreview = false;    // show the selection converted to grey before applying it
    #version = 0;           // bumped on every change, for the drawing caches below
    #tintCache = null;
    #grayCache = null;
    #hover = null;
    #drag = null;
    #sheetRefs = [];
    #cellRefs = new Map();
    #artCells = new Set();

    // -----------------------------------------------------------------------------------------------------------------
    // Setup

    mount(host, studio) {
      this.studio = studio;
      this.showMarks = prefs.get("atlas:marks", true);
      this.showCoords = prefs.get("atlas:coords", false);
      // Moves and swaps carry only the pixels: no tile or item JSON is rewritten. Off by default — following the art is
      // what keeps sprites and data in step; this is for re-arranging what is drawn without touching what uses it.
      this.pixelsOnly = prefs.get("atlas:pixelsOnly", false);
      host.appendChild(this.#buildLayout());
      this.vp = new Viewport(this.canvas);
      this.vp.on("change", () => this.#draw());
      new ResizeObserver(() => this.#draw()).observe(this.viewEl);
      this.history.on("change", () => this.#changed());
      this.#bindPointer();
      this.#registerCommands();
      this.#renderAll();
    }

    async activate() {
      this.#draw();
      const p = this.studio.pendingPlacement;
      this.studio.pendingPlacement = null;
      await this.#refreshIfChanged();
      if (p) this.#beginPlacement(p);
    }

    // Crear's "Guardar en el atlas", Aseprite or a text editor may have written the files while this tab held them.
    // Untouched here, they are simply read again; with edits pending, saving asks before overwriting (#confirmOverwrite).
    async #refreshIfChanged() {
      if (!this.img || this.history.dirty) return;
      const changed = await this.#changedOnDisk();
      if (!changed.length) return;
      await this.studio.busy(this.#loadDocs());
      await this.#loadSheet(this.sheet, false);
      this.studio.setStatus("Releído (cambió fuera del Atlas): " + changed.join(", ") + ".", "ok");
    }

    async #changedOnDisk() {
      return [...(await this.img.changedOnDisk()), ...(await T.docsChangedOnDisk(this.docs))];
    }

    deactivate() {
      this.picking = null;
    }

    isDirty() { return this.history.dirty; }
    dirtyLabel() { return "El atlas"; }

    async onProject(project) {
      this.project = project;
      this.biomes = await Tint.listBiomes(project);
      this.sheets = listSheets(project).filter((s) => s.atlas);
      if (this.history.dirty) {
        // Reloading would throw away the edits; the list is refreshed and the open sheet stays as it is.
        this.studio.toast("Carpeta releída. El atlas tiene cambios sin guardar: los mantengo.", { kind: "warn" });
        this.#renderSheets();
        return;
      }
      await this.studio.busy(this.#loadDocs());
      const keep = this.sheet && this.sheets.find((s) => s.key === this.sheet.key);
      const first = keep ?? this.sheets.find((s) => this.refs.some((r) => r.sheet === T.sheetKey(s.id))) ?? this.sheets[0];
      if (first) await this.#loadSheet(first, !keep);
      else this.#renderAll();
    }

    async #loadDocs() {
      this.docs = await T.loadDocs(this.project);
      this.refs = T.collectRefs(this.docs);
      const broken = this.docs.filter((d) => d.error);
      if (broken.length) {
        this.studio.toast(`${broken.length} archivo(s) de tiles o items no se pueden leer.`, {
          kind: "bad", detail: broken.map((d) => `${d.name}: ${d.error}`).join(" · "),
        });
      }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Layout

    #buildLayout() {
      this.sheetList = h("div", { class: "at-sheets scroll" });
      this.tileFilter = h("input", { type: "search", placeholder: "Buscar tile…", oninput: () => this.#renderTileList() });
      this.tileList = h("div", { class: "at-tiles scroll" });
      const left = h("div", { class: "at-left" },
        h("div", { class: "at-head" }, h("strong", null, "Hojas")),
        this.sheetList,
        h("div", { class: "at-head" }, this.tileFilter),
        this.tileList);

      this.viewSeg = h("div", { class: "seg" });
      this.marksBtn = h("button", { class: this.showMarks ? "on" : "", title: "Marcas: celdas usadas, referencias rotas, arte sin usar (M)",
        onclick: () => this.#toggleMarks() }, "Marcas");
      this.coordsBtn = h("button", { class: this.showCoords ? "on" : "", title: "Coordenadas [x, y] de cada celda, como van en el JSON (C)",
        onclick: () => this.#toggleCoords() }, "Coords");
      this.pixelsBtn = h("button", { class: this.pixelsOnly ? "on" : "",
        title: "Solo píxeles: mover e intercambiar celdas sin cambiar las coordenadas de los JSON (P)",
        onclick: () => this.#togglePixelsOnly() }, "Solo píxeles");
      this.undoBtn = h("button", { class: "icon", title: "Deshacer (Ctrl+Z)", onclick: () => this.history.undo() }, "↶");
      this.redoBtn = h("button", { class: "icon", title: "Rehacer (Ctrl+Y)", onclick: () => this.history.redo() }, "↷");
      this.saveBtn = h("button", { class: "primary", title: "Guardar la hoja, sus mapas y los JSON cambiados (Ctrl+S)", onclick: () => this.save() }, "Guardar");
      this.banner = h("div", { class: "at-banner", hidden: true });
      this.canvas = h("canvas", { class: "at-canvas", tabindex: 0 });
      this.viewEl = h("div", { class: "at-view" }, this.canvas, this.banner);
      const stage = h("div", { class: "at-stage" },
        h("div", { class: "at-toolbar" },
          this.viewSeg, this.marksBtn, this.coordsBtn, this.pixelsBtn,
          h("button", { title: "Ver la hoja entera (F)", onclick: () => this.#fit() }, "Encajar"),
          h("span", { class: "grow" }),
          this.undoBtn, this.redoBtn, this.saveBtn),
        this.viewEl);

      this.panel = h("div", { class: "at-panel scroll" });
      this.root = h("div", { class: "at" }, left, stage, this.panel);
      return this.root;
    }

    #renderAll() {
      this.#renderSheets();
      this.#renderTileList();
      this.#renderViews();
      this.#renderPanel();
      this.#renderBanner();
      this.#updateToolbar();
      this.#draw();
    }

    #renderSheets() {
      clear(this.sheetList);
      if (!this.sheets.length) {
        this.sheetList.appendChild(h("div", { class: "empty-state" },
          this.project ? "Ningún atlases.json declara una hoja con su PNG." : "Abre la carpeta del proyecto para ver sus hojas."));
        return;
      }
      for (const s of this.sheets) {
        const key = T.sheetKey(s.id);
        const count = this.refs.filter((r) => r.sheet === key).length;
        this.sheetList.appendChild(h("div", {
          class: ["at-sheet", this.sheet?.key === s.key && "active"], title: s.path,
          onclick: () => this.#openSheet(s),
        },
          h("div", { class: "id" }, s.id, h("span", { class: "grow" }),
            s.has.n ? h("span", { class: "badge plain", title: "Tiene _n.png" }, "_n") : null,
            s.has.d ? h("span", { class: "badge plain", title: "Tiene _d.png" }, "_d") : null,
            h("span", { class: "badge plain", title: "Referencias de los JSON a esta hoja" }, count)),
          h("div", { class: "path" }, s.path)));
      }
    }

    #renderTileList() {
      clear(this.tileList);
      if (!this.sheet) return;
      const q = this.tileFilter.value.trim().toLowerCase();
      const byTile = new Map();
      for (const r of this.#sheetRefs) {
        if (!byTile.has(r.tile)) byTile.set(r.tile, []);
        byTile.get(r.tile).push(r);
      }
      // Items of this sheet without an "iconCoord" have no ref, but they belong here: listed last, so they can be opened
      // and given a cell. Tile items are left out — without an icon of their own they show their tile.
      const key = T.sheetKey(this.sheet.id);
      for (const doc of this.docs) {
        if (!T.isItemDoc(doc) || !doc.root) continue;
        for (const it of doc.root.tiles) {
          if (!it || byTile.has(it) || it.type === "TileItem" || T.docSheet(doc, it) !== key) continue;
          byTile.set(it, []);
        }
      }
      const rows = [...byTile].filter(([tile]) => !q || T.tileId(tile).includes(q) || T.tileLabel(tile).toLowerCase().includes(q));
      if (!rows.length) {
        this.tileList.appendChild(h("div", { class: "empty-state" }, q ? "Ningún tile coincide." : "Ningún tile usa esta hoja todavía."));
        return;
      }
      for (const [tile, refs] of rows) {
        const broken = refs.some((r) => !this.#refHasArt(r));
        const noIcon = !refs.length;
        this.tileList.appendChild(h("div", {
          class: ["at-tile", tile === this.tile && "active"],
          title: `${T.tileId(tile)} · ${this.#docOf(tile)?.name ?? ""}` + (noIcon ? " · sin iconCoord" : ""),
          onclick: () => this.#openTile(tile, true),
        }, h("span", { class: ["grow", noIcon && "faint"] }, T.tileLabel(tile)),
          broken ? h("span", { class: "badge bad", title: "Apunta a una celda vacía" }, "!") : null,
          noIcon ? h("span", { class: "badge warn", title: "Sin \"iconCoord\": el juego muestra el cuadrado de color. Selecciona una celda y usa «Usar la selección como icono»." }, "sin icono")
            : h("span", { class: "faint" }, refs.length)));
      }
    }

    #renderViews() {
      clear(this.viewSeg);
      const views = [["", "Color"], ["tint", "Bioma", "Los tiles biome_tinted como los pinta el juego, con el bioma de «Ver con»"],
        ...COMPANIONS.filter(([s]) => this.img?.has(s)).map(([s, label, title]) => [s, label, title])];
      if (!views.some(([v]) => v === this.view)) this.view = "";
      for (const [v, label, title] of views) {
        this.viewSeg.appendChild(h("button", { class: v === this.view ? "on" : "", title: title ?? "La hoja de color",
          onclick: () => { this.view = v; this.#renderViews(); this.#draw(); } }, label));
      }
    }

    #updateToolbar() {
      this.undoBtn.disabled = !this.history.canUndo;
      this.redoBtn.disabled = !this.history.canRedo;
      this.undoBtn.title = "Deshacer" + (this.history.undoLabel ? ": " + this.history.undoLabel : "") + " (Ctrl+Z)";
      this.redoBtn.title = "Rehacer" + (this.history.redoLabel ? ": " + this.history.redoLabel : "") + " (Ctrl+Y)";
      this.saveBtn.disabled = !this.history.dirty;
    }

    #toggleMarks() {
      this.showMarks = !this.showMarks;
      prefs.set("atlas:marks", this.showMarks);
      this.marksBtn.classList.toggle("on", this.showMarks);
      this.#draw();
    }

    #togglePixelsOnly() {
      this.pixelsOnly = !this.pixelsOnly;
      prefs.set("atlas:pixelsOnly", this.pixelsOnly);
      this.pixelsBtn.classList.toggle("on", this.pixelsOnly);
      this.studio.setStatus(this.pixelsOnly
        ? "Solo píxeles: mover no cambia ningún JSON — los tiles e items siguen apuntando a sus celdas."
        : "Mover lleva las coordenadas de los JSON con el arte.", this.pixelsOnly ? "warn" : "ok");
    }

    #toggleCoords() {
      this.showCoords = !this.showCoords;
      prefs.set("atlas:coords", this.showCoords);
      this.coordsBtn.classList.toggle("on", this.showCoords);
      this.#draw();
    }

    // "x,y" in each cell's corner. Brighter where the cell has art or a tile points at it; below ~26 px a label would
    // cover the art, so it is left out until the user zooms in (the status bar still shows the hovered cell).
    #drawCoords(g, rect, cw) {
      if (cw < 26) return;
      const size = Math.max(9, Math.min(13, Math.floor(cw / 6)));
      g.font = `600 ${size}px ui-monospace, Consolas, monospace`;
      g.textBaseline = "top";
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          const k = x + "," + y;
          const used = this.#artCells.has(k) || this.#cellRefs.has(k);
          const [rx, ry] = rect(x, y);
          const label = `${x},${y}`;
          const w = g.measureText(label).width + 6;
          g.fillStyle = used ? "rgba(0,0,0,.72)" : "rgba(0,0,0,.35)";
          g.fillRect(rx + 1, ry + 1, w, size + 4);
          g.fillStyle = used ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.4)";
          g.fillText(label, rx + 4, ry + 3);
        }
      }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Sheets

    async #openSheet(sheet) {
      if (sheet.key === this.sheet?.key) return;
      if (!(await this.#settleUnsaved())) return;
      await this.#loadSheet(sheet, true);
    }

    /** Before something that drops the edits in memory: save, discard (reloading the JSON from disk) or stay. */
    async #settleUnsaved() {
      if (!this.history.dirty) return true;
      const choice = await this.studio.askUnsaved("El atlas «" + (this.sheet?.id ?? "") + "»");
      if (choice === "save") return this.save();
      if (choice === "discard") {
        await this.studio.busy(this.#loadDocs());
        this.history.clear();
        return true;
      }
      return false;
    }

    async #loadSheet(sheet, fit) {
      try {
        const img = await this.studio.busy(new SheetImage(sheet).load(this.project));
        this.sheet = sheet;
        this.img = img;
      } catch (err) {
        this.studio.toast("No pude abrir la hoja.", { kind: "bad", detail: err.message });
        return;
      }
      this.history.clear();
      this.selection.clear();
      this.tile = null;
      this.placed = null;
      this.grid = this.#gridFor(sheet);
      this.#version++;
      this.#index();
      this.#renderAll();
      if (fit) requestAnimationFrame(() => this.#fit());
      for (const w of this.img.warnings) this.studio.toast(w, { kind: "warn" });
      if (this.#asepriteOf(sheet)) {
        this.studio.toast("Esta hoja tiene su .aseprite al lado.", {
          kind: "warn", detail: "Lo que cambies aquí se pisa si vuelves a exportar el PNG desde Aseprite. Edita en un solo sitio.",
        });
      }
      this.studio.setStatus(`«${sheet.id}»: ${this.img.w}×${this.img.h}, ${this.#sheetRefs.length} referencias, ${this.img.layers.size - 1} mapa(s) acompañando.`, "ok");
    }

    #asepriteOf(sheet) {
      const stem = sheet.path.replace(/\.png$/i, "");
      return this.project.get(stem + ".aseprite") ?? this.project.get(stem + ".ase");
    }

    // The size most of the sheet's references use; remembered per sheet once changed by hand.
    #gridFor(sheet) {
      const saved = prefs.get("atlas:grid:" + sheet.key, null);
      if (saved) return saved;
      const key = T.sheetKey(sheet.id), counts = new Map();
      for (const r of this.refs) if (r.sheet === key) counts.set(r.tw + "x" + r.th, (counts.get(r.tw + "x" + r.th) ?? 0) + 1);
      const best = [...counts].sort((a, b) => b[1] - a[1])[0];
      const [w, h] = best ? best[0].split("x").map(Number) : [T.CELL, T.CELL];
      return { w, h };
    }

    #setGrid(w, h) {
      if (!(w >= 4 && h >= 4)) return;
      this.grid = { w, h };
      prefs.set("atlas:grid:" + this.sheet.key, this.grid);
      this.selection.clear();
      this.#index();
      this.#renderAll();
    }

    get cols() { return this.img ? Math.floor(this.img.w / this.grid.w) : 0; }
    get rows() { return this.img ? Math.floor(this.img.h / this.grid.h) : 0; }

    // -----------------------------------------------------------------------------------------------------------------
    // Index: which references and which art each grid cell has. Rebuilt after every change — cheap next to a frame.

    #index() {
      this.refs = T.collectRefs(this.docs);
      this.#sheetRefs = [];
      this.#cellRefs = new Map();
      this.#artCells = new Set();
      if (!this.img) return;
      const key = T.sheetKey(this.sheet.id);
      for (const r of this.refs) {
        if (r.sheet !== key) continue;
        this.#sheetRefs.push(r);
        for (const c of this.#cellsOf(r)) {
          const k = ck(c[0], c[1]);
          if (!this.#cellRefs.has(k)) this.#cellRefs.set(k, []);
          this.#cellRefs.get(k).push(r);
        }
      }
      const { w, h } = this.grid;
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) if (this.img.hasArt(x * w, y * h, w, h)) this.#artCells.add(ck(x, y));
      }
    }

    #cellsOf(ref) {
      const r = T.refRect(ref), { w, h } = this.grid, out = [];
      for (let y = Math.floor(r.y / h); y < Math.ceil((r.y + r.h) / h); y++) {
        for (let x = Math.floor(r.x / w); x < Math.ceil((r.x + r.w) / w); x++) out.push([x, y]);
      }
      return out;
    }

    #refHasArt(ref) {
      const r = T.refRect(ref);
      return !!this.img && r.x + r.w <= this.img.w && r.y + r.h <= this.img.h && this.img.hasArt(r.x, r.y, r.w, r.h);
    }

    #changed() {
      this.#version++;
      this.#index();
      if (this.#hover) this.#hoverStatus(this.#hover);
      this.#renderSheets();
      this.#renderTileList();
      this.#renderViews();
      this.#renderPanel();
      this.#updateToolbar();
      this.#draw();
      this.studio.refreshDirty();
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Drawing

    #draw = rafThrottle(() => {
      const c = this.canvas;
      if (!c?.isConnected || !c.offsetWidth) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const g = c.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      if (!this.img) return;

      const z = this.vp.zoom, ox = this.vp.panX, oy = this.vp.panY;
      const iw = this.img.w * z, ih = this.img.h * z;
      g.fillStyle = this.#checker(g);
      g.fillRect(ox, oy, iw, ih);
      g.imageSmoothingEnabled = false;
      g.drawImage(this.view === "tint" ? this.#tintedCanvas() : this.img.canvasOf(this.view), ox, oy, iw, ih);
      if (this.grayPreview && this.selection.size) this.#drawGrayPreview(g, ox, oy, z);

      const cw = this.grid.w * z, chh = this.grid.h * z;
      const rect = (x, y, w = 1, hh = 1) => [ox + x * cw, oy + y * chh, w * cw, hh * chh];

      if (cw >= 6) {
        g.strokeStyle = "rgba(255,255,255,.08)";
        g.lineWidth = 1;
        g.beginPath();
        for (let x = 0; x <= this.cols; x++) { g.moveTo(Math.round(ox + x * cw) + 0.5, oy); g.lineTo(Math.round(ox + x * cw) + 0.5, oy + this.rows * chh); }
        for (let y = 0; y <= this.rows; y++) { g.moveTo(ox, Math.round(oy + y * chh) + 0.5); g.lineTo(ox + this.cols * cw, Math.round(oy + y * chh) + 0.5); }
        g.stroke();
      }

      if (this.showMarks) {
        // Art no tile points at (yellow corner) and tiles pointing at nothing (red frame): what to look at first.
        g.fillStyle = "rgba(240,180,90,.85)";
        for (const k of this.#artCells) {
          if (this.#cellRefs.has(k)) continue;
          const [x, y] = pk(k);
          const [rx, ry, rw] = rect(x, y);
          const s = Math.max(3, Math.min(8, cw / 6));
          g.fillRect(rx + rw - s - 1, ry + 1, s, s);
        }
        g.strokeStyle = "rgba(239,111,108,.95)";
        g.lineWidth = 2;
        for (const r of this.#sheetRefs) {
          if (this.#refHasArt(r)) continue;
          const rr = T.refRect(r);
          g.strokeRect(ox + rr.x * z + 1, oy + rr.y * z + 1, rr.w * z - 2, rr.h * z - 2);
        }
      }

      if (this.showCoords) this.#drawCoords(g, rect, cw);

      // The open tile's cells.
      if (this.tile) {
        g.strokeStyle = "rgba(127,178,255,.95)";
        g.lineWidth = 2;
        for (const r of this.#sheetRefs) {
          if (r.tile !== this.tile) continue;
          const rr = T.refRect(r);
          g.strokeRect(ox + rr.x * z + 1, oy + rr.y * z + 1, rr.w * z - 2, rr.h * z - 2);
        }
      }

      g.fillStyle = "rgba(95,211,176,.22)";
      g.strokeStyle = "rgba(95,211,176,.95)";
      g.lineWidth = 2;
      for (const k of this.selection) {
        const [x, y] = pk(k);
        const r = rect(x, y);
        g.fillRect(...r);
        g.strokeRect(r[0] + 1, r[1] + 1, r[2] - 2, r[3] - 2);
      }

      const d = this.#drag;
      if (d?.kind === "move" && (d.dx || d.dy)) this.#drawMoveGhost(g, rect, d);
      if (d?.kind === "marquee") {
        const [x0, y0, x1, y1] = this.#marqueeCells(d);
        g.strokeStyle = "rgba(95,211,176,.9)";
        g.setLineDash([4, 3]);
        g.strokeRect(...rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1));
        g.setLineDash([]);
      }
      if (this.pending && this.#hover) this.#drawPlacementGhost(g, rect);

      if (this.#hover && !this.pending && !d) {
        g.strokeStyle = this.picking ? "rgba(127,178,255,.95)" : "rgba(255,255,255,.55)";
        g.lineWidth = 1;
        const r = rect(this.#hover[0], this.#hover[1]);
        g.strokeRect(r[0] + 0.5, r[1] + 0.5, r[2] - 1, r[3] - 1);
      }
    });

    // The colour sheet with every biome_tinted tile's cells under the preview biome, the rest as painted — the game's
    // rule (BiomeTint.a is 0 for any other tile). Rebuilt only when the sheet or the biome changed.
    #tintedCanvas() {
      const key = this.#version + "|" + this.tint.preview;
      if (this.#tintCache?.key === key) return this.#tintCache.canvas;
      const color = this.img.color, out = new Uint8ClampedArray(color.rgba);
      const rgb = TP.previewRgb(this.tint, this.biomes);
      const done = new Set();
      for (const r of this.#sheetRefs) {
        if (!isTinted(r.tile)) continue;
        const rr = T.refRect(r), k = rr.x + "," + rr.y;
        if (done.has(k)) continue;
        done.add(k);
        pasteInto(out, color.w, color.h, rr, Tint.applyTint(this.img.read(color, rr.x, rr.y, rr.w, rr.h), rgb));
      }
      const canvas = new OffscreenCanvas(color.w, color.h);
      canvas.getContext("2d").putImageData(new ImageData(out, color.w, color.h), 0, 0);
      this.#tintCache = { key, canvas };
      return canvas;
    }

    // The selected cells as "Pasar a gris" would leave them (under the preview biome in the Bioma view).
    #drawGrayPreview(g, ox, oy, z) {
      const key = [this.#version, [...this.selection].join(";"), JSON.stringify(this.tint), this.view].join("|");
      if (this.#grayCache?.key !== key) {
        const { w, h } = this.grid, color = this.img.color;
        const rgb = TP.previewRgb(this.tint, this.biomes), opts = TP.resolve(this.tint, this.biomes);
        const blocks = this.#selectedCells().map(([x, y]) => {
          let px = Tint.toTinted(this.img.read(color, x * w, y * h, w, h), opts);
          if (this.view === "tint") px = Tint.applyTint(px, rgb);
          const c = new OffscreenCanvas(w, h);
          c.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
          return { x, y, c };
        });
        this.#grayCache = { key, blocks };
      }
      const { w, h } = this.grid;
      for (const b of this.#grayCache.blocks) {
        g.clearRect(ox + b.x * w * z, oy + b.y * h * z, w * z, h * z);
        g.fillStyle = this.#checker(g);
        g.fillRect(ox + b.x * w * z, oy + b.y * h * z, w * z, h * z);
        g.drawImage(b.c, ox + b.x * w * z, oy + b.y * h * z, w * z, h * z);
      }
    }

    #drawMoveGhost(g, rect, d) {
      const { w, h } = this.grid, src = this.img.canvasOf(this.view);
      g.globalAlpha = 0.8;
      for (const k of this.selection) {
        const [x, y] = pk(k);
        g.drawImage(src, x * w, y * h, w, h, ...rect(x + d.dx, y + d.dy));
      }
      g.globalAlpha = 1;
      g.strokeStyle = d.copy ? "rgba(127,178,255,.95)" : "rgba(95,211,176,.95)";
      g.setLineDash([4, 3]);
      for (const k of this.selection) {
        const [x, y] = pk(k);
        const r = rect(x + d.dx, y + d.dy);
        g.strokeRect(r[0] + 1, r[1] + 1, r[2] - 2, r[3] - 2);
      }
      g.setLineDash([]);
    }

    #drawPlacementGhost(g, rect) {
      const cells = this.#placementCells(this.#hover);
      for (let i = 0; i < cells.length; i++) {
        const [x, y] = cells[i];
        const r = rect(x, y);
        const item = this.pending.items[i];
        item.canvas ??= toCanvas(item.color, this.pending.size);
        g.globalAlpha = 0.85;
        g.drawImage(item.canvas, ...r);
        g.globalAlpha = 1;
        const out = x >= this.cols || y >= this.rows;
        const busy = this.#artCells.has(ck(x, y));
        g.strokeStyle = out ? "rgba(240,180,90,.95)" : busy ? "rgba(239,111,108,.95)" : "rgba(95,211,176,.95)";
        g.lineWidth = 2;
        g.strokeRect(r[0] + 1, r[1] + 1, r[2] - 2, r[3] - 2);
      }
    }

    #checker(g) {
      if (!this.checkerPattern) {
        const c = new OffscreenCanvas(16, 16), cg = c.getContext("2d");
        cg.fillStyle = "#2b2e33"; cg.fillRect(0, 0, 16, 16);
        cg.fillStyle = "#33363c"; cg.fillRect(0, 0, 8, 8); cg.fillRect(8, 8, 8, 8);
        this.checkerPattern = g.createPattern(c, "repeat");
      }
      return this.checkerPattern;
    }

    #fit() {
      if (this.img) this.vp.fit(this.img.w, this.img.h);
    }

    #reveal(cells) {
      if (!cells.length) return;
      const [x, y] = cells[0];
      const s = this.vp.toScreen((x + 0.5) * this.grid.w, (y + 0.5) * this.grid.h), size = this.vp.size();
      if (s.x < 0 || s.y < 0 || s.x > size.w || s.y > size.h) this.vp.centerOn((x + 0.5) * this.grid.w, (y + 0.5) * this.grid.h);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Pointer: click selects (Shift adds, Ctrl toggles), dragging art moves it (swapping with what is there; Alt copies),
    // dragging from empty space draws a selection box. Wheel / middle drag / Space pan, as in every canvas of the studio.

    #cellAt(e) {
      const p = this.vp.toImage(e.clientX, e.clientY);
      return [Math.floor(p.x / this.grid.w), Math.floor(p.y / this.grid.h)];
    }

    #inside([x, y]) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }

    #bindPointer() {
      const c = this.canvas;
      c.addEventListener("pointerdown", (e) => {
        if (!this.img || e.button !== 0 || this.vp.wantsPan(e)) return;
        c.focus();
        const cell = this.#cellAt(e);
        if (this.pending) { this.#placeAt(cell); return; }
        if (this.picking) {
          if (this.#inside(cell)) { const p = this.picking; this.picking = null; p.apply(cell); }
          return;
        }
        const k = ck(...cell);
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (!this.#inside(cell) || (!this.#artCells.has(k) && !this.selection.has(k) && !e.altKey)) {
          if (!additive) this.selection.clear();
          this.#drag = { kind: "marquee", start: cell, end: cell, base: new Set(this.selection) };
        } else {
          if (e.ctrlKey || e.metaKey) {
            if (this.selection.has(k)) this.selection.delete(k); else this.selection.add(k);
            this.#selectionChanged();
            return;
          }
          if (e.shiftKey) this.selection.add(k);
          else if (!this.selection.has(k)) { this.selection.clear(); this.selection.add(k); }
          this.#drag = { kind: "move", start: cell, dx: 0, dy: 0, copy: e.altKey, clicked: k, additive };
        }
        c.setPointerCapture(e.pointerId);
        this.#draw();
      });
      c.addEventListener("pointermove", (e) => {
        if (!this.img) return;
        const cell = this.#cellAt(e);
        const d = this.#drag;
        if (d?.kind === "marquee") d.end = cell;
        if (d?.kind === "move") { d.dx = cell[0] - d.start[0]; d.dy = cell[1] - d.start[1]; d.copy = e.altKey; }
        const changed = !this.#hover || this.#hover[0] !== cell[0] || this.#hover[1] !== cell[1];
        this.#hover = cell;
        if (changed) this.#hoverStatus(cell);
        this.#draw();
      });
      c.addEventListener("pointerleave", () => { this.#hover = null; this.studio.slot("cell", ""); this.#draw(); });
      c.addEventListener("pointerup", (e) => {
        const d = this.#drag;
        this.#drag = null;
        if (!d) return;
        if (d.kind === "marquee") {
          const [x0, y0, x1, y1] = this.#marqueeCells(d);
          this.selection = new Set(d.base);
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.#inside([x, y])) this.selection.add(ck(x, y));
          this.#selectionChanged();
        } else if (d.dx || d.dy) {
          this.#moveSelection(d.dx, d.dy, d.copy);
        } else {
          // A plain click on a cell of a bigger selection picks just that cell.
          if (!d.additive && this.selection.size > 1) { this.selection.clear(); this.selection.add(d.clicked); }
          this.#selectionChanged(true);
        }
        this.#draw();
      });
      c.addEventListener("dblclick", (e) => {
        const refs = this.#cellRefs.get(ck(...this.#cellAt(e)));
        if (refs?.length) this.#openTile(refs[0].tile, false);
      });
    }

    #marqueeCells(d) {
      const clampX = (v) => Math.max(0, Math.min(this.cols - 1, v)), clampY = (v) => Math.max(0, Math.min(this.rows - 1, v));
      return [clampX(Math.min(d.start[0], d.end[0])), clampY(Math.min(d.start[1], d.end[1])),
        clampX(Math.max(d.start[0], d.end[0])), clampY(Math.max(d.start[1], d.end[1]))];
    }

    #hoverStatus(cell) {
      if (!this.#inside(cell)) { this.studio.slot("cell", ""); return; }
      const refs = this.#cellRefs.get(ck(...cell)) ?? [];
      const what = refs.length ? `${T.tileLabel(refs[0].tile)} (${T.refLabel(refs[0])})${refs.length > 1 ? ` +${refs.length - 1}` : ""}`
        : this.#artCells.has(ck(...cell)) ? "arte sin usar" : "vacía";
      this.studio.slot("cell", `[${cell[0]}, ${cell[1]}] · ${what}`);
    }

    /** After the selection changed: the inspector follows, and a cell used by one tile opens that tile. */
    #selectionChanged(fromClick = false) {
      if (fromClick && this.selection.size === 1) {
        const tiles = [...new Set((this.#cellRefs.get([...this.selection][0]) ?? []).map((r) => r.tile))];
        if (tiles.length === 1) this.tile = tiles[0];
      }
      this.#renderPanel();
      this.#renderTileList();
      this.#draw();
    }

    #selectedCells() { return sortCells([...this.selection].map(pk)); }

    // -----------------------------------------------------------------------------------------------------------------
    // Pixel edits. Each is one undo step over every layer (colour and maps) and the JSON coordinates it moves.

    /**
     * Moves the selection by (dx, dy) cells. Without copy it is a permutation: what was in the way goes to the cells
     * left behind, so nothing is ever lost, and every reference follows its art. With copy, the targets are overwritten
     * and no reference changes.
     */
    async #moveSelection(dx, dy, copy = false) {
      const src = this.#selectedCells();
      if (!src.length || (!dx && !dy)) return;
      const dst = src.map(([x, y]) => [x + dx, y + dy]);
      if (dst.some((c) => !this.#inside(c))) {
        this.studio.toast("Se sale de la hoja.", { kind: "warn", detail: "Agranda la hoja (panel Hoja) o mueve a otro sitio." });
        return;
      }
      const { w, h } = this.grid;

      if (copy) {
        const hits = dst.filter(([x, y]) => this.#artCells.has(ck(x, y)) && !this.selection.has(ck(x, y)));
        if (hits.length && !(await this.studio.confirm({
          title: "Copiar encima", danger: true, confirm: "Sobrescribir",
          message: `${hits.length} celda(s) de destino ya tienen arte y se perderá (Ctrl+Z lo devuelve).`,
        }))) return;
        const layers = [...this.img.layers.values()];
        const before = layers.map((l) => dst.map(([x, y]) => this.img.read(l, x * w, y * h, w, h)));
        const after = layers.map((l) => src.map(([x, y]) => this.img.read(l, x * w, y * h, w, h)));
        this.#run(`Copiar ${src.length} celda(s)`, () => this.#writeBlocks(layers, dst, after), () => this.#writeBlocks(layers, dst, before));
        this.#select(dst);
        return;
      }

      // The cells taken over hand their content to the cells vacated, in reading order.
      const srcSet = new Set(src.map((c) => ck(...c))), dstSet = new Set(dst.map((c) => ck(...c)));
      const displaced = sortCells(dst.filter((c) => !srcSet.has(ck(...c))));
      const vacated = sortCells(src.filter((c) => !dstSet.has(ck(...c))));
      const pairs = src.map((c, i) => [c, dst[i]]).concat(displaced.map((c, i) => [c, vacated[i]]));
      // Pixels only: no reference follows, so nothing can be split either.
      const plan = this.pixelsOnly ? { moves: [], conflicts: [] } : this.#refPlan(pairs);
      if (plan.conflicts.length) {
        this.studio.toast("No puedo mover sin partir un tile.", {
          kind: "bad", detail: plan.conflicts.slice(0, 4).map((r) => `${T.tileLabel(r.tile)} (${T.refLabel(r)})`).join(" · ")
            + " ocupa varias celdas o no encaja en esta cuadrícula. Selecciona todas sus celdas o cambia la cuadrícula.",
        });
        return;
      }
      const inverse = pairs.map(([a, b]) => [b, a]);
      const layers = [...this.img.layers.values()];
      this.#run(`Mover ${src.length} celda(s)${this.pixelsOnly ? " (solo píxeles)" : ""}`,
        () => { this.#permute(layers, pairs); for (const m of plan.moves) { m.coord[0] = m.to[0]; m.coord[1] = m.to[1]; } },
        () => { this.#permute(layers, inverse); for (const m of plan.moves) { m.coord[0] = m.from[0]; m.coord[1] = m.from[1]; } });
      this.#select(dst);
      const n = new Set(plan.moves.map((m) => m.ref.doc)).size;
      if (plan.moves.length) this.studio.setStatus(`Movido: ${plan.moves.length} coordenada(s) actualizadas en ${n} archivo(s).`, "ok");
    }

    // Where every reference into the moved cells ends up. A reference covering several cells moves only when they all
    // move together; one that would be split, or land off its own file's grid, is a conflict.
    #refPlan(pairs) {
      const delta = new Map(pairs.map(([a, b]) => [ck(...a), [b[0] - a[0], b[1] - a[1]]]));
      const moves = [], conflicts = [];
      for (const ref of this.#sheetRefs) {
        const ds = this.#cellsOf(ref).map((c) => delta.get(ck(...c)) ?? [0, 0]);
        if (ds.every(([x, y]) => !x && !y)) continue;
        const [dx, dy] = ds[0];
        if (!ds.every(([x, y]) => x === dx && y === dy)) { conflicts.push(ref); continue; }
        const nx = ref.coord[0] + (dx * this.grid.w) / ref.tw, ny = ref.coord[1] + (dy * this.grid.h) / ref.th;
        if (!Number.isInteger(nx) || !Number.isInteger(ny)) { conflicts.push(ref); continue; }
        moves.push({ ref, coord: ref.coord, from: [ref.coord[0], ref.coord[1]], to: [nx, ny] });
      }
      return { moves, conflicts };
    }

    #permute(layers, pairs) {
      const { w, h } = this.grid;
      for (const l of layers) {
        const blocks = pairs.map(([[x, y]]) => this.img.read(l, x * w, y * h, w, h));
        pairs.forEach(([, [x, y]], i) => this.img.write(l, x * w, y * h, w, h, blocks[i]));
      }
    }

    #writeBlocks(layers, cells, blocksPerLayer) {
      const { w, h } = this.grid;
      layers.forEach((l, li) => cells.forEach(([x, y], i) => this.img.write(l, x * w, y * h, w, h, blocksPerLayer[li][i])));
    }

    async #emptySelection() {
      const cells = this.#selectedCells();
      if (!cells.length) return;
      const refs = [...new Set(cells.flatMap((c) => this.#cellRefs.get(ck(...c)) ?? []))];
      if (refs.length && !(await this.studio.confirm({
        title: "Vaciar celdas", danger: true, confirm: "Vaciar",
        message: `${refs.length} referencia(s) seguirán apuntando aquí y se verán vacías en el juego: `
          + [...new Set(refs.map((r) => T.tileLabel(r.tile)))].slice(0, 8).join(", ") + ". Ctrl+Z lo devuelve.",
      }))) return;
      const { w, h } = this.grid;
      const layers = [...this.img.layers.values()];
      const before = layers.map((l) => cells.map(([x, y]) => this.img.read(l, x * w, y * h, w, h)));
      this.#run(`Vaciar ${cells.length} celda(s)`,
        () => { for (const l of layers) for (const [x, y] of cells) this.img.clear(l, x * w, y * h, w, h); },
        () => this.#writeBlocks(layers, cells, before));
    }

    /** Adds whole rows or columns of cells (transparent) to the sheet and its maps. */
    #growSheet(addCols, addRows) {
      const oldW = this.img.w, oldH = this.img.h;
      const newW = oldW + addCols * this.grid.w, newH = oldH + addRows * this.grid.h;
      this.#run(`Agrandar la hoja a ${newW}×${newH}`, () => this.img.resize(newW, newH), () => this.img.resize(oldW, oldH));
      this.studio.setStatus(`Hoja ${newW}×${newH}. Si el juego usa ResizeToPowerOfTwo no hace falta nada más.`, "ok");
    }

    #select(cells) {
      this.selection = new Set(cells.map((c) => ck(...c)));
      this.#renderPanel();
      this.#draw();
    }

    #run(label, redo, undo) {
      this.history.run({ label, redo, undo });
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Tile edits. A tile's keys are swapped as values, never cloned on undo, so the [x, y] arrays earlier steps hold stay
    // the ones in the file whatever is undone in between.

    #replaceTile(tile, next, label) {
      const before = Object.entries(tile), after = Object.entries(next);
      const put = (entries) => {
        for (const k of Object.keys(tile)) delete tile[k];
        for (const [k, v] of entries) tile[k] = v;
      };
      this.#run(label, () => put(after), () => put(before));
    }

    #setField(tile, key, value) {
      const next = {};
      let placed = false;
      for (const [k, v] of Object.entries(tile)) {
        if (k === key) { if (value !== undefined) next[k] = value; placed = true; } else next[k] = v;
      }
      if (!placed && value !== undefined) {
        // New keys go before "art", where a person would write them.
        const entries = Object.entries(next), at = entries.findIndex(([k]) => k === "art" || k === "parts");
        entries.splice(at < 0 ? entries.length : at, 0, [key, value]);
        this.#replaceTile(tile, Object.fromEntries(entries), `${T.tileLabel(tile)}: ${key}`);
        return;
      }
      this.#replaceTile(tile, next, `${T.tileLabel(tile)}: ${key}`);
    }

    #setCoord(coord, x, y, label) {
      const from = [coord[0], coord[1]];
      this.#run(label, () => { coord[0] = x; coord[1] = y; }, () => { coord[0] = from[0]; coord[1] = from[1]; });
    }

    #docOf(tile) {
      return this.docs.find((d) => d.root?.tiles.includes(tile)) ?? null;
    }

    #openTile(tile, reveal) {
      this.tile = tile;
      if (reveal) {
        const cells = this.#sheetRefs.filter((r) => r.tile === tile).flatMap((r) => this.#cellsOf(r));
        if (cells.length) { this.#select(cells); this.#reveal(cells); }
      }
      this.#renderPanel();
      this.#renderTileList();
      this.#draw();
    }

    async #deleteTile(tile) {
      const doc = this.#docOf(tile);
      if (!doc || !(await this.studio.confirm({
        title: "Quitar tile", danger: true, confirm: "Quitar",
        message: T.isItemDoc(doc)
          ? `«${T.tileLabel(tile)}» sale de ${doc.name}. Su icono se queda en la hoja. Si algo lo usa (recetas, drops, combustibles), el juego avisará al cargar.`
          : `«${T.tileLabel(tile)}» sale de ${doc.name}. Su arte se queda en la hoja. Si algo lo usa (estructuras, drops, crecimiento), el juego avisará al cargar.`,
      }))) return;
      const list = doc.root.tiles, index = list.indexOf(tile);
      this.tile = null;
      this.#run(`Quitar ${T.tileLabel(tile)}`, () => list.splice(index, 1), () => list.splice(index, 0, tile));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Placement from Crear

    #beginPlacement(p) {
      if (!this.project) {
        this.studio.toast("Abre la carpeta del proyecto para colocar en una hoja.", { kind: "warn" });
        return;
      }
      const go = async () => {
        if (p.sheetKey && p.sheetKey !== this.sheet?.key) {
          const target = this.sheets.find((s) => s.key === p.sheetKey);
          if (target) {
            if (!(await this.#settleUnsaved())) return;
            await this.#loadSheet(target, true);
          }
        }
        if (!this.img) {
          this.studio.toast("Elige una hoja para colocar.", { kind: "warn" });
          return;
        }
        if (p.size !== this.grid.w || p.size !== this.grid.h) {
          this.studio.toast(`Los sprites miden ${p.size} px y la cuadrícula de «${this.sheet.id}» ${this.grid.w}×${this.grid.h}.`, {
            kind: "warn", detail: "Cambia el tamaño del sprite en Crear o la cuadrícula en el panel Hoja.",
          });
          return;
        }
        this.pending = p;
        this.picking = null;
        this.#renderBanner();
        this.#findGap(false);
        this.canvas.focus();
      };
      go();
    }

    // Cells for n sprites from a start cell, in reading order, wrapping at the sheet's width.
    #placementCells([sx, sy]) {
      const cols = Math.max(1, this.cols);
      return Array.from({ length: this.pending.items.length }, (_, i) => {
        const flat = sy * cols + sx + i;
        return [flat % cols, Math.floor(flat / cols)];
      });
    }

    /** First start cell with room for every sprite, all empty. With go, places there at once. */
    #findGap(go) {
      const n = this.pending.items.length;
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          const cells = this.#placementCells([x, y]);
          if (cells.every((c) => this.#inside(c) && !this.#artCells.has(ck(...c)) && !this.#cellRefs.has(ck(...c)))) {
            this.#hover = [x, y];
            this.#reveal(cells);
            if (go) this.#placeAt([x, y]);
            else this.#draw();
            return true;
          }
        }
      }
      if (go) {
        this.studio.toast(`No hay ${n} celda(s) libres seguidas.`, { kind: "warn", detail: "Usa «Añadir fila» o haz clic donde quieras sobrescribir." });
      }
      return false;
    }

    async #placeAt(start) {
      const p = this.pending;
      if (!p || start[0] < 0 || start[1] < 0) return;
      const cells = this.#placementCells(start);
      const rowsNeeded = Math.max(...cells.map(([, y]) => y)) + 1 - this.rows;
      if (rowsNeeded > 0) {
        if (!(await this.studio.confirm({ title: "Falta sitio", confirm: `Añadir ${rowsNeeded} fila(s)`,
          message: `No caben en la hoja desde [${start.join(", ")}]. ¿La agrando?` }))) return;
        this.#growSheet(0, rowsNeeded);
      }
      const busy = cells.filter((c) => this.#artCells.has(ck(...c)) || this.#cellRefs.has(ck(...c)));
      if (busy.length && !(await this.studio.confirm({
        title: "Colocar encima", danger: true, confirm: "Sobrescribir",
        message: `${busy.length} celda(s) ya tienen arte o un tile que las usa. Ctrl+Z lo devuelve.`,
      }))) return;

      const { w, h } = this.grid;
      const created = !this.img.has("_n") && p.items.some((i) => i.normal);
      const layersNow = () => [...this.img.layers.values()];
      let before = null;
      this.#run(`Colocar ${p.label}`, () => {
        if (created) this.img.ensure("_n");
        const layers = layersNow();
        before ??= layers.map((l) => cells.map(([x, y]) => this.img.read(l, x * w, y * h, w, h)));
        for (const l of layers) {
          cells.forEach(([x, y], i) => {
            const item = p.items[i];
            // The colour and its shape normals; the detail map and the old normals tool's inputs are emptied there, so
            // nothing of the sprite that was in the cell before is left in the maps.
            const data = l.suffix === "" ? item.color : l.suffix === "_n" ? item.normal : null;
            if (data) this.img.write(l, x * w, y * h, w, h, new Uint8ClampedArray(data));
            else this.img.clear(l, x * w, y * h, w, h);
          });
        }
      }, () => {
        const layers = layersNow();
        if (created) {
          this.img.drop("_n");
          this.#writeBlocks(layersNow(), cells, before.filter((_, i) => layers[i].suffix !== "_n"));
        } else {
          this.#writeBlocks(layers, cells, before);
        }
      });
      this.pending = null;
      this.placed = { p, cells };
      this.#select(cells);
      this.#renderBanner();
      this.#renderPanel();
      this.studio.setStatus(`Colocado ${p.label} en ${cells.length} celda(s) desde [${cells[0].join(", ")}]${created ? " · _n nuevo" : ""}. Crea su tile en el panel o guarda (Ctrl+S).`, "ok");
    }

    #cancel() {
      if (this.pending) { this.pending = null; this.#renderBanner(); this.#draw(); return; }
      if (this.picking) { this.picking = null; this.#renderPanel(); this.#draw(); return; }
      if (this.selection.size) { this.selection.clear(); this.#renderPanel(); this.#draw(); }
    }

    #renderBanner() {
      clear(this.banner);
      this.banner.hidden = !this.pending && !this.picking;
      if (this.pending) {
        const p = this.pending;
        this.banner.append(
          h("span", null, h("b", null, p.label), ` · ${p.items.length} celda(s) de ${p.size} px. Haz clic en la primera celda.`),
          h("button", { onclick: () => this.#findGap(true) }, "Primer hueco libre"),
          h("button", { class: "ghost", onclick: () => this.#cancel() }, "Cancelar (Esc)"));
      } else if (this.picking) {
        this.banner.append(h("span", null, `Haz clic en la celda para ${this.picking.label}.`),
          h("button", { class: "ghost", onclick: () => this.#cancel() }, "Cancelar (Esc)"));
      }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Inspector

    #renderPanel() {
      // Removing a focused field fires its change event, which edits and renders again from inside clear(): committing
      // it first lets that inner render finish before this one starts.
      if (this.panel.contains(document.activeElement)) document.activeElement.blur();
      const top = this.panel.scrollTop;
      clear(this.panel);
      if (!this.img) {
        this.panel.appendChild(h("div", { class: "empty-state" }, h("h3", null, "Atlas"),
          "Abre la carpeta del proyecto y elige una hoja. Aquí mueves, cambias y vacías celdas; sus mapas (_n, _d) y las coordenadas de los JSON se actualizan solos."));
        return;
      }
      this.panel.append(this.#sheetSection().el);
      if (this.placed) this.panel.append(this.#placedSection().el);
      this.panel.append(this.#selectionSection().el);
      // Item icons are never tinted by the biome: the grey workflow only belongs on tile sheets.
      if (!this.#isItemSheet()) this.panel.append(this.#tintSection().el);
      if (this.tile && this.#docOf(this.tile)) this.panel.append(this.#tileSection(this.tile).el);
      else this.tile = null;
      this.panel.append(this.#reviewSection().el);
      this.panel.scrollTop = top;
      this.#renderBanner();
    }

    #sheetSection() {
      const s = this.sheet, img = this.img;
      const gw = h("input", { type: "number", min: 4, max: 1024, value: this.grid.w, title: "Ancho de celda" });
      const gh = h("input", { type: "number", min: 4, max: 1024, value: this.grid.h, title: "Alto de celda" });
      const apply = () => this.#setGrid(Number(gw.value) | 0, Number(gh.value) | 0);
      gw.onchange = apply; gh.onchange = apply;
      const maps = [...img.layers.values()].filter((l) => l.suffix).map((l) =>
        h("span", { class: ["badge", l.exists ? "plain" : "warn"], title: l.exists ? "Se mueve con la hoja" : "Nuevo: se crea al guardar" }, l.suffix));
      const ase = this.#asepriteOf(s);
      return section({ id: "at-sheet", title: "Hoja", extra: s.id },
        h("div", { class: "note mono" }, s.path),
        h("div", { class: "note" }, `${img.w}×${img.h} px · ${this.cols}×${this.rows} celdas · `, maps.length ? maps : "sin mapas"),
        ase ? h("p", { class: "note warn" }, "Tiene ", h("b", null, ase.name), ": si vuelves a exportar desde Aseprite, se pisa lo de aquí.") : null,
        h("div", { class: "field" }, h("label", null, "Cuadrícula"), h("div", { class: "pair" }, gw, gh)),
        h("div", { class: "row" },
          h("button", { class: "grow", onclick: () => this.#growSheet(0, 1) }, "Añadir fila"),
          h("button", { class: "grow", onclick: () => this.#growSheet(1, 0) }, "Añadir columna")),
        h("button", { onclick: () => this.#sortDocsByY(),
          title: "Reordena los JSON que usan esta hoja por la Y de su arte (la más pequeña primero, luego la X). Cambia el orden de los ids en tiempo de ejecución; los mundos guardados no se ven afectados (se guardan por id)." },
          "Ordenar JSON por Y"));
    }

    // One undo step for every file that has art on this sheet. Entries with no art keep their order, at the end.
    #sortDocsByY() {
      const key = T.sheetKey(this.sheet.id);
      const docs = this.docs.filter((d) => d.root && this.refs.some((r) => r.doc === d && r.sheet === key));
      const changes = docs.map((doc) => ({ doc, before: [...doc.root.tiles], after: T.orderByCoord(doc, this.refs) })).filter((c) => c.after);
      if (!changes.length) { this.studio.toast("Ya están ordenados por Y."); return; }
      const put = (list, order) => { list.length = 0; list.push(...order); };
      this.#run(`Ordenar por Y (${changes.map((c) => c.doc.name).join(", ")})`,
        () => { for (const c of changes) put(c.doc.root.tiles, c.after); },
        () => { for (const c of changes) put(c.doc.root.tiles, c.before); });
      this.studio.setStatus(`${changes.length} archivo(s) reordenado(s) por Y. Guarda para escribirlos (Ctrl+S).`, "ok");
    }

    #selectionSection() {
      const cells = this.#selectedCells();
      if (!cells.length) {
        return section({ id: "at-sel", title: "Selección" },
          h("p", { class: "note" }, "Clic en una celda para ver qué tiles la usan. Arrastra para mover (cambia el sitio con lo que haya; ",
            h("b", null, "Alt"), " copia). Arrastra en vacío para seleccionar varias. ", h("b", null, "Supr"), " vacía, flechas mueven."));
      }
      const refs = [...new Set(cells.flatMap((c) => this.#cellRefs.get(ck(...c)) ?? []))];
      const list = h("div", { class: "at-refs" }, refs.length ? refs.map((r) => h("div", {
        class: ["at-ref", r.tile === this.tile && "active"], title: `${T.tileId(r.tile)} · ${r.doc.name}`,
        onclick: () => this.#openTile(r.tile, false),
      }, h("span", { class: "grow" }, T.tileLabel(r.tile)), h("span", { class: "faint" }, `[${r.coord.join(", ")}] ${T.refLabel(r)}`)))
        : h("p", { class: "note" }, cells.some((c) => this.#artCells.has(ck(...c))) ? "Arte que ningún tile usa." : "Celda vacía."));
      const single = cells.length === 1;
      return section({ id: "at-sel", title: "Selección", extra: single ? `[${cells[0].join(", ")}]` : `${cells.length} celdas` },
        list,
        single ? this.#newTileForm(cells, null) : null,
        h("button", { class: "danger", onclick: () => this.#emptySelection() }, "Vaciar celdas (Supr)"));
    }

    // "Bioma": the selected cells turned into the grey a biome_tinted tile needs, previewed on the sheet first.
    // A sheet an item file draws from, or whose every reference is an item icon.
    #isItemSheet() {
      const key = T.sheetKey(this.sheet.id);
      if (this.docs.some((d) => T.isItemDoc(d) && d.root && T.docSheet(d) === key)) return true;
      return this.#sheetRefs.length > 0 && this.#sheetRefs.every((r) => T.isItemDoc(r.doc));
    }

    #tintSection() {
      const cells = this.#selectedCells();
      const ui = TP.tintSection({ id: "at-tint", title: "Bioma · pasar a gris", state: this.tint, biomes: this.biomes, withToggle: false,
        onChange: () => { prefs.set("atlas:tint", this.tint); this.#updateTintStats(); this.#draw(); } });
      this.tintUi = ui;
      const previewChk = h("input", { type: "checkbox", checked: this.grayPreview,
        onchange: () => { this.grayPreview = previewChk.checked; this.#draw(); } });
      const markChk = h("input", { type: "checkbox", checked: true });
      const apply = h("button", { class: "primary", disabled: !cells.length,
        onclick: () => this.#grayCells(cells, markChk.checked) }, cells.length ? `Pasar a gris ${cells.length} celda(s)` : "Selecciona celdas");
      ui.el.querySelector(".section-body").append(
        h("label", { class: "field check" }, previewChk, h("span", null, "Ver el resultado sobre la selección")),
        h("label", { class: "field check" }, markChk, h("span", null, "Marcar sus tiles como biome_tinted")),
        apply);
      this.#updateTintStats();
      return ui;
    }

    // Counts for the selection as it would come out (or, with nothing selected, for every biome_tinted cell as it is).
    #updateTintStats() {
      if (!this.tintUi || !this.img) return;
      const { w, h } = this.grid, color = this.img.color, opts = TP.resolve(this.tint, this.biomes);
      const cells = this.#selectedCells();
      const sum = { full: 0, partial: 0, kept: 0, total: 0 };
      for (const [x, y] of cells) {
        const s = Tint.analyze(Tint.toTinted(this.img.read(color, x * w, y * h, w, h), opts));
        for (const k in sum) sum[k] += s[k];
      }
      this.tintUi.setStats(cells.length ? sum : null);
    }

    #grayCells(cells, mark) {
      const { w, h } = this.grid, color = this.img.color, opts = TP.resolve(this.tint, this.biomes);
      const before = cells.map(([x, y]) => this.img.read(color, x * w, y * h, w, h));
      const after = before.map((b) => Tint.toTinted(b, opts));
      this.#run(`Pasar a gris ${cells.length} celda(s)`,
        () => cells.forEach(([x, y], i) => this.img.write(color, x * w, y * h, w, h, after[i])),
        () => cells.forEach(([x, y], i) => this.img.write(color, x * w, y * h, w, h, before[i])));
      if (mark) {
        const tiles = [...new Set(cells.flatMap((c) => this.#cellRefs.get(ck(...c)) ?? []).map((r) => r.tile))].filter((t) => !isTinted(t));
        for (const tile of tiles) this.#setField(tile, "tags", [...(Array.isArray(tile.tags) ? tile.tags : []), TINT_TAG]);
        if (tiles.length) this.studio.setStatus(`En gris; ${tiles.length} tile(s) marcados biome_tinted.`, "ok");
      }
      this.grayPreview = false;
    }

    // The tile files that can hold a tile drawing from this sheet: those whose sheet it is first.
    #docOptions() {
      const key = T.sheetKey(this.sheet.id);
      const ok = this.docs.filter((d) => d.root);
      ok.sort((a, b) => (T.docSheet(b) === key) - (T.docSheet(a) === key) || a.name.localeCompare(b.name));
      return ok.map((d) => [d.path, (T.isItemDoc(d) ? "Items/" : "") + d.name + (T.docSheet(d) === key ? "" : " (con sheetId)")]);
    }

    /**
     * "Nuevo tile" on cells: one cell for a selection, or what a placement put down (builder makes the art from its
     * cells). The art is written in the file's own cell size, so it must line up with the file's grid.
     */
    #newTileForm(cells, placement) {
      const details = h("details", { class: "at-new", open: !!placement });
      const opts = this.#docOptions();
      if (!opts.length) return h("p", { class: "note" }, "No hay archivos de tiles ni de items (Data/Tiles, Data/Items) donde crear uno.");
      const base = placement?.p.name ?? "";
      const nameIn = h("input", { type: "text", value: base, placeholder: "Nombre (p. ej. Oak Leaves)", spellcheck: false });
      const idIn = h("input", { type: "text", value: placement?.p.id ?? "", placeholder: "id: del nombre", spellcheck: false });
      const fileSel = select({ options: opts, value: opts[0][0] });
      const kindSel = select({ options: TILE_KINDS.map(([k, t]) => [k, t]), value: placement?.p.kind ?? "block" });
      const preview = h("pre", { class: "at-json" });
      const error = h("p", { class: "note bad" });

      const build = () => {
        const doc = this.docs.find((d) => d.path === fileSel.get());
        const [tw, th] = T.docCell(doc);
        const coords = cells.map(([x, y]) => [(x * this.grid.w) / tw, (y * this.grid.h) / th]);
        if (coords.some(([x, y]) => !Number.isInteger(x) || !Number.isInteger(y))) {
          throw new Error(`${doc.name} usa celdas de ${tw}×${th}: estas celdas no caen en su cuadrícula.`);
        }
        const name = nameIn.value.trim();
        if (!name) throw new Error("Ponle un nombre.");
        const id = idIn.value.trim() || T.deriveIdPath(name);
        if (!/^[a-z0-9_]+(:[a-z0-9_/]+)?$/.test(id)) throw new Error("El id solo lleva minúsculas, números y _ .");
        const onOtherSheet = T.docSheet(doc) !== T.sheetKey(this.sheet.id);
        if (T.isItemDoc(doc)) {
          if (placement?.p.buildTiles || placement?.p.buildTile) throw new Error("Esto es arte de tiles: elige un archivo de Data/Tiles.");
          const item = { id, name, ...structuredClone(NEW_ITEM), iconCoord: coords[0] };
          if (onOtherSheet) item.sheetId = this.sheet.id;
          return { doc, tiles: [item] };
        }
        // A growth export is a whole set (every stage, or base / middle / top), each built complete by its sender.
        if (placement?.p.buildTiles) {
          const tiles = placement.p.buildTiles(coords, { id, name });
          if (onOtherSheet) for (const t of tiles) t.sheetId = this.sheet.id;
          return { doc, tiles };
        }
        const tile = { id, name, ...structuredClone(TILE_KINDS.find(([k]) => k === kindSel.get())[2]) };
        if (onOtherSheet) tile.sheetId = this.sheet.id;
        Object.assign(tile, placement?.p.buildTile ? placement.p.buildTile(coords) : { art: { default: { front: coords[0] } } });
        return { doc, tiles: [tile] };
      };
      const refresh = () => {
        try {
          const { tiles } = build();
          preview.textContent = tiles.length === 1 ? T.formatJson(tiles[0]) : T.formatJson(tiles);
          const doc = this.docs.find((d) => d.path === fileSel.get());
          const sameKind = (d) => T.isItemDoc(d) === T.isItemDoc(doc);
          const taken = tiles.find((tile) => this.docs.some((d) => sameKind(d) && d.root?.tiles.some((t) => t && T.tileId(t) === T.tileId(tile))));
          error.textContent = taken ? `Ya existe ${T.isItemDoc(doc) ? "un item" : "un tile"} «${T.tileId(taken)}».` : "";
          kindSel.el.hidden = T.isItemDoc(doc);
        } catch (err) {
          preview.textContent = "";
          error.textContent = err.message;
        }
      };
      for (const el of [nameIn, idIn]) el.addEventListener("input", refresh);
      fileSel.input.addEventListener("change", refresh);
      kindSel.input.addEventListener("change", refresh);
      const create = () => {
        refresh();
        if (error.textContent) return;
        const { doc, tiles } = build();
        const list = doc.root.tiles;
        this.tile = tiles[0];
        if (placement) this.placed = null;
        const what = T.isItemDoc(doc) ? "item" : "tile";
        this.#run(tiles.length === 1 ? `Nuevo ${what} ${tiles[0].name}` : `${tiles.length} ${what}s nuevos`,
          () => list.push(...tiles), () => list.splice(list.indexOf(tiles[0]), tiles.length));
        this.studio.setStatus(`${tiles.map((t) => "«" + t.id + "»").join(", ")} añadido(s) a ${doc.name}. Guarda para escribirlo (Ctrl+S).`, "ok");
      };
      refresh();
      details.append(
        h("summary", null, placement ? "Crear su tile" : "Nuevo tile o item en esta celda"),
        h("div", { class: "field" }, h("label", null, "Nombre"), nameIn),
        h("div", { class: "field" }, h("label", null, "Id"), idIn),
        h("div", { class: "field" }, h("label", null, "Archivo"), fileSel.el),
        placement?.p.buildTiles ? null : h("div", { class: "field" }, h("label", null, "Clase"), kindSel.el),
        preview, error,
        h("button", { class: "primary", onclick: create }, "Crear"));
      return details;
    }

    #placedSection() {
      const { p, cells } = this.placed;
      const snippet = p.snippet?.(cells) ?? "";
      return section({ id: "at-placed", title: "Recién colocado", extra: h("button", { class: "ghost", title: "Cerrar", onclick: () => { this.placed = null; this.#renderPanel(); } }, "×") },
        h("p", { class: "note" }, h("b", null, p.label), ` en ${cells.length} celda(s) desde [${cells[0].join(", ")}].`),
        p.buildTile || p.buildTiles ? this.#newTileForm(cells, this.placed)
          : h("div", null, h("p", { class: "note" }, p.why ?? "Esto no es un solo tile: copia su arte al JSON que toque."),
            h("textarea", { class: "at-raw", rows: 6, readonly: true, value: snippet })),
        // Items the tiles need (seeds, the harvest) live in the items files, which this tab does not edit.
        p.itemsText ? h("div", null, h("div", { class: "at-sub" }, "Items para tu archivo de items"),
          h("textarea", { class: "at-raw", rows: 6, readonly: true, value: p.itemsText() })) : null);
    }

    #tileSection(tile) {
      const doc = this.#docOf(tile);
      const isItem = T.isItemDoc(doc);
      const fields = isItem ? this.#itemGroups(tile) : this.#tileGroups(tile);

      // The art: every state and side of the tile and its parts, with their cells. Built from the file's own sheet and
      // cell size (a spread of the root would drop the item file's hidden list and default sheet).
      const root = { sheetId: doc.root.sheetId, tileWidth: doc.root.tileWidth, tileHeight: doc.root.tileHeight, tiles: [tile] };
      const rows = T.collectRefs([{ ...doc, root }]);
      const artRows = rows.map((r) => {
        const xIn = h("input", { type: "number", min: 0, value: r.coord[0] });
        const yIn = h("input", { type: "number", min: 0, value: r.coord[1] });
        const set = () => this.#setCoord(r.coord, Number(xIn.value) | 0, Number(yIn.value) | 0, `${T.tileLabel(tile)}: arte ${T.refLabel(r)}`);
        xIn.onchange = set; yIn.onchange = set;
        const pick = h("button", { class: "icon", title: "Elegir la celda en la hoja", onclick: () => {
          this.picking = { label: `${T.tileLabel(tile)} · ${T.refLabel(r)}`, apply: (cell) => {
            const x = (cell[0] * this.grid.w) / r.tw, y = (cell[1] * this.grid.h) / r.th;
            if (!Number.isInteger(x) || !Number.isInteger(y)) { this.studio.toast("Esa celda no cae en la cuadrícula del archivo.", { kind: "warn" }); return; }
            this.#setCoord(r.coord, x, y, `${T.tileLabel(tile)}: arte ${T.refLabel(r)}`);
          } };
          this.#renderBanner();
        } }, "⌖");
        const off = r.sheet !== T.sheetKey(this.sheet.id);
        return h("div", { class: ["at-art", off && "off"], title: off ? "En otra hoja" : "" },
          h("span", { class: "lbl" }, T.refLabel(r)), xIn, yIn, pick);
      });

      const raw = h("textarea", { class: "at-raw", rows: 12, spellcheck: false, value: T.formatJson(tile) });
      const rawErr = h("p", { class: "note bad" });
      const applyRaw = () => {
        let next;
        try {
          next = JSON.parse(raw.value);
        } catch (err) {
          rawErr.textContent = "JSON no válido: " + err.message;
          return;
        }
        const problems = isItem ? T.validateItem(next) : T.validateTile(next);
        if (problems.length) { rawErr.textContent = problems.join(" "); return; }
        rawErr.textContent = "";
        this.#replaceTile(tile, next, `${T.tileLabel(tile)}: JSON`);
      };

      const tinted = h("input", { type: "checkbox", checked: isTinted(tile), onchange: () => {
        const tags = (Array.isArray(tile.tags) ? tile.tags : []).filter((t) => String(t).toLowerCase() !== TINT_TAG);
        if (tinted.checked) tags.push(TINT_TAG);
        this.#setField(tile, "tags", tags.length ? tags : undefined);
      } });
      return section({ id: "at-tile", title: isItem ? "Item" : "Tile", extra: T.tileId(tile) },
        h("p", { class: "note" }, "En ", h("b", null, (isItem ? "Items/" : "") + doc.name), "."),
        fields,
        isItem ? null : h("label", { class: "field check", title: "El juego tiñe sus pixeles grises con el color del bioma" }, tinted, h("span", null, "Teñido por bioma (biome_tinted)")),
        h("div", { class: "at-sub" }, isItem ? "Icono " : "Arte ", h("span", { class: "faint" }, "(x, y en celdas del archivo)")),
        artRows.length ? artRows : h("p", { class: "note" }, isItem ? "Sin icono propio (no tiene \"iconCoord\")." : "Sin arte."),
        isItem ? this.#itemIconRow(tile, doc) : this.#addArtRow(tile, doc),
        isItem ? null : this.#partsBlock(tile, doc),
        h("div", { class: "at-sub" }, "JSON"),
        raw, rawErr,
        h("div", { class: "row" },
          h("button", { class: "grow", onclick: applyRaw, title: "Sustituye la entrada por este JSON (se puede deshacer)" }, "Aplicar JSON"),
          h("button", { onclick: () => this.#openTile(tile, true), title: "Seleccionar sus celdas" }, "Ver celdas"),
          h("button", { class: "danger", onclick: () => this.#deleteTile(tile) }, "Quitar")));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Tile inspector: every key the game reads, in groups. A group opens by itself when the tile uses any of its keys.

    #tileGroups(tile) {
      return TILE_GROUPS.map((g) => {
        const used = g.fields.some((f) => getPath(tile, f.path) !== undefined);
        const body = g.fields.map((f) => (f.path === "name" || f.path === "id"
          ? this.#formField(tile, { key: f.path, label: f.label, kind: f.kind, hint: f.hint })
          : this.#tileField(tile, f)));
        return h("details", { class: "at-group", open: g.open || used || undefined },
          h("summary", null, g.title, used && !g.open ? h("span", { class: "faint" }, " ●") : null), body);
      });
    }

    // Item inspector: the common groups, plus the one for its type. Fields of other types are not shown, but stay in the
    // file if they are there (the JSON box shows everything).
    #itemGroups(item) {
      const type = item.type;
      return ITEM_GROUPS.filter((g) => !g.types || g.types.includes(type)).map((g) => {
        const fields = g.fields.filter((f) => !f.onlyFor || f.onlyFor.includes(type));
        const used = fields.some((f) => getPath(item, f.path) !== undefined);
        const body = fields.map((f) => (f.path === "name" || f.path === "id"
          ? this.#formField(item, { key: f.path, label: f.label, kind: f.kind, hint: f.hint })
          : this.#tileField(item, f)));
        const missing = fields.filter((f) => f.required && getPath(item, f.path) === undefined);
        return h("details", { class: "at-group", open: g.open || used || undefined },
          h("summary", null, g.title, used && !g.open ? h("span", { class: "faint" }, " ●") : null,
            missing.length ? h("span", { class: "badge bad", title: "El juego lo necesita: " + missing.map((f) => f.label).join(", ") }, "falta") : null),
          body);
      });
    }

    // Writes one (possibly dotted) key. Objects emptied by the edit are removed, so the file never keeps "growth": {}.
    #setPath(tile, path, value) {
      const keys = path.split(".");
      if (keys.length === 1) { this.#setField(tile, path, value); return; }
      const root = structuredClone(tile[keys[0]] ?? {});
      let node = root;
      const trail = [root];
      for (let i = 1; i < keys.length - 1; i++) {
        node = node[keys[i]] = typeof node[keys[i]] === "object" && node[keys[i]] !== null ? node[keys[i]] : {};
        trail.push(node);
      }
      if (value === undefined) delete node[keys[keys.length - 1]];
      else node[keys[keys.length - 1]] = value;
      for (let i = trail.length - 1; i > 0; i--) if (!Object.keys(trail[i]).length) delete trail[i - 1][keys[i]];
      this.#setField(tile, keys[0], Object.keys(root).length ? root : undefined);
    }

    #tileField(tile, f) {
      const current = getPath(tile, f.path);
      const commit = (v) => this.#setPath(tile, f.path, v === f.def ? undefined : v);
      const num = (text) => (text.trim() === "" ? undefined : Number(text));
      const field = (input, extraClass) => h("div", { class: ["field", extraClass], title: f.title ?? "" }, h("label", null, f.label), input);
      const textInput = (value, hint, onChange, type = "text") => {
        const el = h("input", { type, value: value ?? "", placeholder: hint ?? "", spellcheck: false, step: "any" });
        if (onChange) el.addEventListener("change", () => onChange(el.value));
        return el;
      };

      switch (f.kind) {
        case "check": {
          const value = current ?? f.def ?? false;
          return h("label", { class: "field check", title: f.title ?? "" },
            h("input", { type: "checkbox", checked: !!value, onchange: (e) => commit(e.target.checked) }), h("span", null, f.label));
        }
        case "number":
          return field(textInput(current, f.hint, (t) => commit(num(t)), "number"));
        case "text":
          return field(textInput(current, f.hint, (t) => commit(t.trim() || undefined)));
        case "select": {
          const opts = f.options.map((o) => [o, f.labels?.[o] ?? (o || "(por defecto)")]);
          if (current !== undefined && !f.options.includes(current)) opts.push([String(current), String(current)]);
          if (current === undefined && !f.options.includes("")) opts.unshift(["", "— elige —"]);
          const sel = select({ options: opts, value: current === undefined ? "" : String(current), onChange: (v) => commit(v || undefined) }).input;
          if (!f.free) return field(sel);
          // Free selects: the list for the usual values, a text box for anything else a mod uses.
          const other = textInput(f.options.includes(current ?? "") ? "" : current, "otro…", (t) => commit(t.trim() || undefined));
          return field(h("div", { class: "at-pair" }, sel, other));
        }
        case "list": {
          const shown = Array.isArray(current) ? current.join(", ") : typeof current === "string" ? current : "";
          return field(textInput(shown, f.hint, (t) => {
            const list = t.trim() ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
            // "single": one value is written as a plain string, the way the files write a one-node "model".
            commit(!list.length ? undefined : f.single && list.length === 1 ? list[0] : list);
          }));
        }
        case "effects":
          return field(this.#effectsEditor(current, commit), "wide");
        case "color": {
          const hex = typeof current === "string" ? current : "";
          const picker = h("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#ffffff",
            onchange: (e) => commit(e.target.value.toUpperCase()) });
          const clearBtn = h("button", { class: "icon", title: "Sin color (luz blanca)", onclick: () => commit(undefined) }, "✕");
          return field(h("div", { class: "at-pair" }, picker, h("span", { class: "faint mono" }, hex || "—"), clearBtn));
        }
        case "range": {
          const pair = Array.isArray(current) ? current : [];
          const a = textInput(pair[0], f.hint?.[0], null, "number"), b = textInput(pair[1], f.hint?.[1], null, "number");
          const write = () => {
            const x = num(a.value), y = num(b.value);
            commit(x === undefined && y === undefined ? undefined : [x ?? y, y ?? x]);
          };
          a.onchange = write; b.onchange = write;
          return field(h("div", { class: "at-pair" }, a, b));
        }
        case "vec3": {
          const v = Array.isArray(current) ? current : [];
          const ins = [0, 1, 2].map((i) => textInput(v[i], ["x", "y", "z"][i], null, "number"));
          const write = () => {
            const vals = ins.map((el) => num(el.value));
            commit(vals.every((x) => x === undefined) ? undefined : vals.map((x) => x ?? 0.5));
          };
          for (const el of ins) el.onchange = write;
          return field(h("div", { class: "at-trio" }, ...ins));
        }
        case "attach": {
          const list = Array.isArray(current) ? current : ["floor", "wall"];
          const box = (key, label) => h("label", { class: "check" },
            h("input", { type: "checkbox", checked: list.includes(key), onchange: (e) => {
              const next = ["floor", "wall"].filter((k) => (k === key ? e.target.checked : list.includes(k)));
              if (!next.length) { this.studio.toast("Tiene que apoyarse en algo.", { kind: "warn" }); this.#renderPanel(); return; }
              commit(next.length === 2 ? undefined : next);
            } }), h("span", null, label));
          return field(h("div", { class: "at-pair" }, box("floor", "suelo"), box("wall", "pared")));
        }
        case "tags": {
          const tags = Array.isArray(current) ? current : [];
          const lower = tags.map((t) => String(t).toLowerCase());
          const chips = KNOWN_TAGS.map((t) => h("button", { class: ["at-chip", lower.includes(t) && "on"], title: t,
            onclick: () => commit(lower.includes(t) ? (tags.filter((x) => String(x).toLowerCase() !== t).length ? tags.filter((x) => String(x).toLowerCase() !== t) : undefined) : [...tags, t]) }, t));
          const extra = tags.filter((t) => !KNOWN_TAGS.includes(String(t).toLowerCase()));
          const free = textInput(extra.join(", "), "otras, separadas por coma", (t) => {
            const known = tags.filter((x) => KNOWN_TAGS.includes(String(x).toLowerCase()));
            const next = [...known, ...t.split(",").map((x) => x.trim()).filter(Boolean)];
            commit(next.length ? next : undefined);
          });
          return field(h("div", null, h("div", { class: "at-chips" }, chips), free), "wide");
        }
        case "drops":
          return field(this.#dropsEditor(tile, current, commit), "wide");
        case "collision": {
          const mode = current === undefined ? "" : typeof current === "string" ? current : "boxes";
          const area = h("textarea", { class: "at-raw small", rows: 3, spellcheck: false, hidden: mode !== "boxes",
            value: mode === "boxes" ? JSON.stringify(current) : "[ { \"min\": [0, 0, 0], \"max\": [1, 0.5, 1] } ]" });
          area.onchange = () => {
            try { commit(JSON.parse(area.value)); } catch (err) { this.studio.toast("Cajas no válidas: " + err.message, { kind: "warn" }); }
          };
          const sel = select({ options: [["", "completa (por defecto)"], ["none", "ninguna"], ["boxes", "cajas…"]], value: mode === "full" ? "" : mode,
            onChange: (v) => { if (v === "boxes") { area.hidden = false; area.onchange(); } else commit(v || undefined); } }).input;
          return field(h("div", null, sel, area), "wide");
        }
        case "double": {
          const mode = current === undefined ? "" : current === true ? "true" : typeof current === "string" ? "id" : "parts";
          const idIn = textInput(typeof current === "string" ? current : "", "id del tile doble", (t) => commit(t.trim() || undefined));
          idIn.hidden = mode !== "id";
          const sel = select({ options: [["", "no"], ["true", "sí, mismo arte"], ["id", "otro tile…"], ...(mode === "parts" ? [["parts", "con partes (JSON)"]] : [])],
            value: mode, onChange: (v) => {
              if (v === "id") { idIn.hidden = false; idIn.focus(); return; }
              if (v === "parts") return;
              commit(v === "true" ? true : undefined);
            } }).input;
          return field(h("div", { class: "at-pair" }, sel, idIn));
        }
        case "json": {
          const area = h("textarea", { class: "at-raw small", rows: current === undefined ? 2 : 5, spellcheck: false,
            placeholder: "vacío = no tiene", value: current === undefined ? "" : JSON.stringify(current, null, 1) });
          area.onchange = () => {
            const text = area.value.trim();
            if (!text) { commit(undefined); return; }
            try { commit(JSON.parse(text)); } catch (err) { this.studio.toast(`${f.label}: JSON no válido (${err.message})`, { kind: "warn" }); }
          };
          return field(area, "wide");
        }
        default:
          return null;
      }
    }

    // What a tile leaves when broken: one row per item, with its chance and amount. The item list offers every item id
    // the open item files declare.
    #dropsEditor(tile, current, commit) {
      const list = Array.isArray(current) ? current : [];
      const listId = "at-items-" + (this.#dropsListSeq = (this.#dropsListSeq ?? 0) + 1);
      const ids = [...new Set(this.docs.filter((d) => T.isItemDoc(d) && d.root).flatMap((d) => d.root.tiles.filter(Boolean).map((it) => it.id ?? T.deriveIdPath(it.name ?? ""))))].sort();
      const dataList = h("datalist", { id: listId }, ids.map((id) => h("option", { value: id })));
      const write = (next) => commit(next.length ? next : undefined);
      const rows = list.map((d, i) => {
        const set = (key, value) => write(list.map((x, j) => (j === i ? { ...x, [key]: value } : x)));
        const item = h("input", { type: "text", value: d.item ?? "", list: listId, placeholder: "item", spellcheck: false });
        item.onchange = () => set("item", item.value.trim());
        const n = (key, value, hint) => {
          const el = h("input", { type: "number", value: value ?? "", placeholder: hint, step: "any" });
          el.onchange = () => set(key, el.value === "" ? undefined : Number(el.value));
          return el;
        };
        return h("div", { class: "at-drop" }, item, n("chance", d.chance, "1"), n("minQty", d.minQty, "1"), n("maxQty", d.maxQty, "1"),
          h("button", { class: "icon danger", title: "Quitar", onclick: () => write(list.filter((_, j) => j !== i)) }, "✕"));
      });
      return h("div", { class: "at-drops" },
        list.length ? h("div", { class: "at-drop head faint" }, h("span", null, "item"), h("span", null, "prob."), h("span", null, "mín"), h("span", null, "máx"), h("span")) : null,
        rows, dataList,
        h("button", { onclick: () => write([...list, { item: "", chance: 1, minQty: 1, maxQty: 1 }]) }, "+ Añadir drop"));
    }

    #dropsListSeq = 0;

    // A consumable's effects: one row each, a type and an amount (plus a duration for the ones over time).
    #effectsEditor(current, commit) {
      const TYPES = ["AddHunger", "AddHealth", "AddStamina", "AddRegen", "AddManaRegen", "AddSpeed", "AddResist"];
      const list = Array.isArray(current) ? current : [];
      const write = (next) => commit(next);
      const rows = list.map((e, i) => {
        const set = (key, value) => write(list.map((x, j) => (j === i ? { ...x, [key]: value } : x)));
        const opts = TYPES.map((t) => [t, t]);
        if (e.type && !TYPES.includes(e.type)) opts.push([e.type, e.type]);
        const type = select({ options: opts, value: e.type ?? TYPES[0], onChange: (v) => set("type", v) }).input;
        const n = (key, value, hint) => {
          const el = h("input", { type: "number", value: value ?? "", placeholder: hint, step: "any" });
          el.onchange = () => set(key, el.value === "" ? undefined : Number(el.value));
          return el;
        };
        return h("div", { class: "at-effect" }, type, n("amount", e.amount, "cant."), n("duration", e.duration, "dur."),
          h("button", { class: "icon danger", title: "Quitar", onclick: () => write(list.filter((_, j) => j !== i)) }, "✕"));
      });
      return h("div", { class: "at-drops" }, rows,
        h("button", { onclick: () => write([...list, { type: "AddHunger", amount: 5 }]) }, "+ Añadir efecto"));
    }

    #formField(tile, f) {
      const current = tile[f.key];
      let input;
      const commit = (value) => {
        if (f.key === "id" || f.key === "name") {
          const next = { ...tile, [f.key]: value };
          if (!next.id && !next.name) { this.studio.toast("Un tile necesita id o nombre.", { kind: "warn" }); this.#renderPanel(); return; }
          const kindOf = T.isItemDoc(this.#docOf(tile));
          const clash = this.docs.some((d) => T.isItemDoc(d) === kindOf && d.root?.tiles.some((t) => t && t !== tile && T.tileId(t) === T.tileId(next)));
          if (clash) { this.studio.toast(`Ya existe «${T.tileId(next)}».`, { kind: "bad" }); this.#renderPanel(); return; }
          if (f.key === "id" || !tile.id) {
            this.studio.toast("Id cambiado: lo que lo nombre (estructuras, crecimiento, biomas, drops) hay que cambiarlo a mano.", { kind: "warn" });
          }
        }
        this.#setField(tile, f.key, value);
      };
      if (f.kind === "select") {
        const opts = f.options.map((o) => [o, o || "(por defecto)"]);
        if (current !== undefined && !f.options.includes(current)) opts.push([String(current), String(current)]);
        input = select({ options: opts, value: current === undefined ? "" : String(current), onChange: (v) => commit(v || undefined) }).input;
      } else {
        const text = f.kind === "tags" ? (Array.isArray(current) ? current.join(", ") : "") : current ?? "";
        input = h("input", { type: f.kind === "number" ? "number" : "text", value: String(text), placeholder: f.hint ?? "", spellcheck: false, step: "any" });
        input.addEventListener("change", () => {
          const v = input.value.trim();
          if (f.kind === "number") commit(v === "" ? undefined : Number(v));
          else if (f.kind === "tags") commit(v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
          else commit(v || undefined);
        });
      }
      return h("div", { class: "field" }, h("label", null, f.label), input);
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Parts: one tile that fills several cells of the world (a tall plant, a bed). The game reads only "default" art on a
    // part (front and back), and takes the tile's own coord from the anchor — the part at offset 0, 0, 0 — so the anchor
    // is always kept and its offsets are fixed.

    #partsBlock(tile, doc) {
      const parts = Array.isArray(tile.parts) ? tile.parts : null;
      if (!parts) {
        return h("div", { class: "at-parts" },
          h("div", { class: "at-sub" }, "Partes"),
          h("button", { onclick: () => this.#toMultipart(tile), title: "Mueve el arte por defecto a una parte ancla (0, 0, 0) para añadirle más partes" },
            "Convertir en multipart"));
      }

      const isAnchor = (p) => (p.offsetX | 0) === 0 && (p.offsetY | 0) === 0 && (p.offsetZ | 0) === 0;
      const rows = parts.map((part, i) => {
        if (!part || typeof part !== "object") return null;
        const anchor = isAnchor(part);
        const axis = (key) => {
          const input = h("input", { type: "number", step: 1, value: part[key] | 0, disabled: anchor, title: key });
          input.onchange = () => this.#setPartOffset(tile, i, key, Number(input.value) | 0);
          return input;
        };
        const remove = h("button", { class: "icon danger", disabled: anchor, title: anchor ? "El ancla no se quita" : "Quitar esta parte",
          onclick: () => this.#removePart(tile, i) }, "✕");
        return h("div", { class: "at-part" }, h("span", { class: "lbl" }, anchor ? "ancla" : `parte ${i}`),
          axis("offsetX"), axis("offsetY"), axis("offsetZ"), remove);
      });

      // The new part defaults to the cell above the highest one: the common case is a plant or a door growing upward.
      const top = Math.max(0, ...parts.filter((p) => p && typeof p === "object").map((p) => p.offsetY | 0));
      const nx = h("input", { type: "number", step: 1, value: 0, title: "offsetX" });
      const ny = h("input", { type: "number", step: 1, value: top + 1, title: "offsetY (niveles hacia arriba)" });
      const nz = h("input", { type: "number", step: 1, value: 0, title: "offsetZ" });
      const add = h("button", { class: "icon", title: "Añadir parte (usa la celda seleccionada en la hoja; si no hay, copia la del ancla)",
        onclick: () => this.#addPart(tile, doc, Number(nx.value) | 0, Number(ny.value) | 0, Number(nz.value) | 0) }, "+");

      return h("div", { class: "at-parts" },
        h("div", { class: "at-sub" }, "Partes ", h("span", { class: "faint" }, "(X, Y nivel, Z)")),
        rows,
        h("div", { class: "at-part new" }, h("span", { class: "lbl" }, "nueva"), nx, ny, nz, add),
        h("p", { class: "note" }, "La celda de cada parte se elige arriba, en Arte, con ⌖."),
        parts.length <= 1
          ? h("button", { onclick: () => this.#toSinglePart(tile), title: "Devuelve el arte del ancla al tile y quita \"parts\"" }, "Volver a una sola pieza")
          : null);
    }

    #toMultipart(tile) {
      const art = tile.art && typeof tile.art === "object" && !Array.isArray(tile.art) ? tile.art : null;
      const def = art?.default;
      if (!def) { this.studio.toast("El tile necesita arte por defecto antes de tener partes.", { kind: "warn" }); return; }

      // Other states (inverted, wall…) don't exist on parts: they stay on the tile, where they were.
      const rest = Object.fromEntries(Object.entries(art).filter(([k]) => k !== "default"));
      const anchor = { offsetX: 0, offsetY: 0, offsetZ: 0, art: { default: structuredClone(def) } };
      const next = this.#withKeyAt(tile, "art", [
        ...(Object.keys(rest).length ? [["art", rest]] : []),
        ["parts", [anchor]],
      ]);
      if (Object.keys(rest).length) this.studio.toast("Los estados que no son «por defecto» se quedan en el tile: las partes solo usan el arte por defecto.", { kind: "warn" });
      this.#replaceTile(tile, next, `${T.tileLabel(tile)}: a multipart`);
    }

    #toSinglePart(tile) {
      const anchor = tile.parts?.find((p) => p && (p.offsetX | 0) === 0 && (p.offsetY | 0) === 0 && (p.offsetZ | 0) === 0);
      const def = anchor?.art?.default;
      if (!def) { this.studio.toast("El ancla no tiene arte por defecto.", { kind: "warn" }); return; }
      const rest = tile.art && typeof tile.art === "object" && !Array.isArray(tile.art) ? tile.art : {};
      const art = { default: structuredClone(def), ...Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "default")) };
      this.#replaceTile(tile, this.#withKeyAt(tile, "parts", [["art", art]]), `${T.tileLabel(tile)}: a una pieza`);
    }

    #addPart(tile, doc, x, y, z) {
      const parts = tile.parts;
      if (parts.some((p) => p && (p.offsetX | 0) === x && (p.offsetY | 0) === y && (p.offsetZ | 0) === z)) {
        this.studio.toast(`Ya hay una parte en (${x}, ${y}, ${z}).`, { kind: "warn" });
        return;
      }

      let front = parts.find((p) => p && !(p.offsetX | 0) && !(p.offsetY | 0) && !(p.offsetZ | 0))?.art?.default?.front;
      const cell = this.#selectedCells()[0];
      if (cell) {
        const [tw, th] = T.docCell(doc);
        const coord = [(cell[0] * this.grid.w) / tw, (cell[1] * this.grid.h) / th];
        if (!coord.every(Number.isInteger)) { this.studio.toast("Esa celda no cae en la cuadrícula del archivo.", { kind: "warn" }); return; }
        front = coord;
      }
      if (!front) { this.studio.toast("Selecciona la celda de la parte en la hoja.", { kind: "warn" }); return; }

      const part = { offsetX: x, offsetY: y, offsetZ: z, art: { default: { front: [...front] } } };
      this.#setField(tile, "parts", [...parts.map((p) => structuredClone(p)), part]);
      if (!cell) this.studio.toast("Parte añadida con la celda del ancla: elige la suya en Arte con ⌖.");
    }

    #setPartOffset(tile, index, key, value) {
      const parts = tile.parts.map((p) => structuredClone(p));
      const p = parts[index];
      const probe = { offsetX: p.offsetX | 0, offsetY: p.offsetY | 0, offsetZ: p.offsetZ | 0, [key]: value };
      const clash = parts.some((o, i) => i !== index && o && (o.offsetX | 0) === probe.offsetX && (o.offsetY | 0) === probe.offsetY && (o.offsetZ | 0) === probe.offsetZ);
      if (clash || (probe.offsetX === 0 && probe.offsetY === 0 && probe.offsetZ === 0)) {
        this.studio.toast(clash ? "Ya hay una parte en ese sitio." : "(0, 0, 0) es el ancla.", { kind: "warn" });
        this.#renderPanel();
        return;
      }
      p[key] = value;
      this.#setField(tile, "parts", parts);
    }

    #removePart(tile, index) {
      this.#setField(tile, "parts", tile.parts.filter((_, i) => i !== index).map((p) => structuredClone(p)));
    }

    // The tile's entries with `key` swapped for `entries` in the same spot, so the JSON keeps the order a person wrote.
    #withKeyAt(tile, key, entries) {
      const out = [];
      let placed = false;
      for (const [k, v] of Object.entries(tile)) {
        if (k === key) { out.push(...entries); placed = true; }
        else if (v !== undefined && !entries.some(([e]) => e === k)) out.push([k, v]);
      }
      if (!placed) out.push(...entries);
      return Object.fromEntries(out);
    }

    // An item without an icon of its own (no "iconCoord") takes the selected cell; one with an icon can drop it again.
    #itemIconRow(tile, doc) {
      const hasIcon = T.isCoord(tile.iconCoord);
      const assign = () => {
        const cell = this.#selectedCells()[0];
        if (!cell) { this.studio.toast("Selecciona antes la celda en la hoja.", { kind: "warn" }); return; }
        const [tw, th] = T.docCell(doc);
        const coord = [(cell[0] * this.grid.w) / tw, (cell[1] * this.grid.h) / th];
        if (!coord.every(Number.isInteger)) { this.studio.toast("Esa celda no cae en la cuadrícula del archivo.", { kind: "warn" }); return; }
        if (T.docSheet(doc, tile) !== T.sheetKey(this.sheet.id)) {
          this.studio.toast(`El icono de este item se lee de «${T.docSheet(doc, tile) || T.DEFAULT_ITEM_SHEET}», no de esta hoja.`, { kind: "warn",
            detail: "Abre esa hoja, o pon \"sheetId\" en el item desde el JSON." });
          return;
        }
        this.#setField(tile, "iconCoord", coord);
      };
      return h("div", { class: "row" },
        h("button", { class: "grow", onclick: assign, title: "Usa la celda seleccionada como icono" }, hasIcon ? "Mover icono a la selección" : "Usar la selección como icono"),
        hasIcon ? h("button", { onclick: () => this.#setField(tile, "iconCoord", undefined), title: "Quita \"iconCoord\": el juego mostrará el cuadrado de color (o el tile, en un item de tile)" }, "Quitar icono") : null);
    }

    // Adds a state the tile has no art for yet, on the selected cell.
    #addArtRow(tile, doc) {
      const have = new Set(Object.keys(tile.art ?? {}).map((s) => s.toLowerCase()));
      const free = T.STATES.filter((s) => !have.has(s));
      const options = [["", "+ Añadir arte…"], ...free.map((s) => [s, T.STATE_LABEL[s]]),
        ...[...have].filter((s) => tile.art[s] && !tile.art[s].back && !Array.isArray(tile.art[s])).map((s) => [s + ":back", T.STATE_LABEL[s] + " · espalda"])];
      if (options.length === 1 || tile.parts) return null;
      const sel = select({ options, value: "", onChange: (v) => {
        if (!v) return;
        const cell = this.#selectedCells()[0];
        if (!cell) { this.studio.toast("Selecciona antes la celda en la hoja.", { kind: "warn" }); sel.set(""); return; }
        const [tw, th] = T.docCell(doc);
        const coord = [(cell[0] * this.grid.w) / tw, (cell[1] * this.grid.h) / th];
        if (!coord.every(Number.isInteger)) { this.studio.toast("Esa celda no cae en la cuadrícula del archivo.", { kind: "warn" }); sel.set(""); return; }
        const [state, side] = v.split(":");
        const art = { ...(tile.art ?? {}) };
        art[state] = side ? { ...art[state], back: coord } : { front: coord };
        this.#setField(tile, "art", art);
      } });
      sel.input.title = "Usa la celda seleccionada";
      return sel.el;
    }

    // biome_tinted tiles whose art the shader would tint halfway somewhere, or not at all.
    #tintIssues() {
      const byTile = new Map();
      for (const r of this.#sheetRefs) {
        if (!isTinted(r.tile) || !this.#refHasArt(r)) continue;
        const rr = T.refRect(r), s = Tint.analyze(this.img.read(this.img.color, rr.x, rr.y, rr.w, rr.h));
        const acc = byTile.get(r.tile) ?? { full: 0, partial: 0, cells: [] };
        acc.full += s.full; acc.partial += s.partial; acc.cells.push(...this.#cellsOf(r));
        byTile.set(r.tile, acc);
      }
      const out = [];
      for (const [tile, s] of byTile) {
        if (!s.full) out.push([`${T.tileLabel(tile)}: biome_tinted sin nada gris (el bioma no lo tiñe)`, s.cells]);
        else if (s.partial) out.push([`${T.tileLabel(tile)}: ${s.partial} px teñidos a medias`, s.cells]);
      }
      return out;
    }

    #reviewSection() {
      const broken = this.#sheetRefs.filter((r) => !this.#refHasArt(r));
      const orphans = [...this.#artCells].filter((k) => !this.#cellRefs.has(k));
      const dupes = T.duplicateIds(this.docs);
      const errors = this.docs.filter((d) => d.error);
      const item = (text, cells, kind) => h("div", { class: ["at-issue", kind], onclick: cells ? () => { this.#select(cells); this.#reveal(cells); } : null }, text);
      const list = [
        // An item pointing at an empty cell only lacks its art (the game shows the colour square); a tile there is broken.
        ...broken.map((r) => T.isItemDoc(r.doc)
          ? item(`${T.tileLabel(r.tile)}: su icono [${r.coord.join(", ")}] está vacío (sale el cuadrado de color)`, this.#cellsOf(r), "warn")
          : item(`${T.tileLabel(r.tile)} (${T.refLabel(r)}) → [${r.coord.join(", ")}] vacía`, this.#cellsOf(r), "bad")),
        orphans.length ? item(`${orphans.length} celda(s) con arte que ningún tile usa`, orphans.map(pk), "warn") : null,
        ...this.#tintIssues().map(([text, cells]) => item(text, cells, "warn")),
        ...dupes.map((id) => item(`Id repetido: ${id} (el juego no carga)`, null, "bad")),
        ...errors.map((d) => item(`${d.name}: ${d.error}`, null, "bad")),
      ].filter(Boolean);
      return section({ id: "at-review", title: "Revisión", extra: list.length ? String(list.length) : "todo bien" },
        list.length ? list : h("p", { class: "note" }, "Cada tile de esta hoja apunta a arte, y no hay ids repetidos."));
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Saving

    /** Writes the sheet's changed layers and every changed tile file. Resolves true when everything was written. */
    async save() {
      if (!this.img || !this.history.dirty) return true;
      const dupes = T.duplicateIds(this.docs);
      if (dupes.length && !(await this.studio.confirm({ title: "Ids repetidos", confirm: "Guardar igual", danger: true,
        message: `${dupes.join(", ")} está más de una vez: el juego no cargará hasta que lo arregles.` }))) return false;
      const changed = await this.#changedOnDisk();
      if (changed.length && !(await this.studio.confirm({ title: "Cambiado fuera del Atlas", confirm: "Guardar igual", danger: true,
        message: `${changed.join(", ")} cambió en disco después de abrirlo aquí (Crear, Aseprite, un editor…). Guardar pisa esos cambios; cancela para guardarlos aparte o descartar los de aquí.` }))) return false;
      const backups = [];
      try {
        const written = await this.studio.busy(this.#write(backups));
        this.history.markSaved();
        this.studio.refreshDirty();
        this.studio.toast("Guardado " + (written.length ? written.join(", ") : "(nada cambió)"), {
          kind: "ok", action: backups.length ? { label: "Restaurar anterior", run: () => this.#restore(backups) } : undefined,
        });
        this.studio.setStatus("Guardado: " + written.join(", ") + ".", "ok");
        return true;
      } catch (err) {
        this.studio.toast("No pude guardar todo.", { kind: "bad", detail: err.message + (backups.length ? " · Lo ya escrito se puede restaurar." : ""),
          action: backups.length ? { label: "Restaurar", run: () => this.#restore(backups) } : undefined });
        return false;
      }
    }

    async #write(backups) {
      const { written, created } = await this.img.save(this.project, backups);
      // A map the sheet did not have must also be built by the content pipeline, with the sheet's own settings.
      for (const suffix of created) {
        const s = this.sheet;
        if (!s.mgcb || !s.rel) { written.push(`(añade ${stripExt(s.name)}${suffix}.png al .mgcb a mano)`); continue; }
        const before = await readText(s.mgcb.handle);
        const { text, result } = addToMgcb(before, s.rel, stripExt(s.name) + suffix + ".png");
        if (result !== "already") {
          backups.push({ name: s.mgcb.name, path: s.mgcb.path, dir: s.mgcb.dir, previous: await s.mgcb.handle.getFile() });
          await writeHandle(s.mgcb.handle, text);
          written.push(s.mgcb.name);
        }
      }
      for (const doc of this.docs) {
        if (!T.isDocDirty(doc)) continue;
        const text = T.serialize(doc);
        backups.push({ name: doc.entry.name, path: doc.path, dir: doc.entry.dir, previous: await doc.entry.handle.getFile() });
        await writeHandle(doc.entry.handle, text);
        doc.baseline = text;
        doc.stamp = (await doc.entry.handle.getFile()).lastModified;
        written.push(doc.name);
      }
      this.sheet.has = Object.fromEntries(["n", "d", "faces", "height"].map((k) => [k, this.img.has("_" + k)]));
      this.#renderSheets();
      return written;
    }

    // Puts the files back as they were before the save, then reloads, since memory now holds the newer state.
    async #restore(backups) {
      try {
        for (const b of backups.slice().reverse()) {
          if (b.previous) {
            const handle = await writeInDir(b.dir, b.name, b.previous);
            this.project.addFile(b.path, handle, b.dir);
          } else {
            await b.dir.removeEntry(b.name).catch(() => {});
            this.project.files.delete(b.path.toLowerCase());
          }
        }
        this.history.clear();
        await this.studio.busy(this.#loadDocs());
        const sheet = this.sheets.find((s) => s.key === this.sheet?.key);
        if (sheet) await this.#loadSheet(sheet, false);
        this.studio.toast("Archivos restaurados.", { kind: "ok" });
      } catch (err) {
        this.studio.toast("No pude restaurar.", { kind: "bad", detail: err.message });
      }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Commands

    #registerCommands() {
      const has = () => !!this.img;
      const sel = () => this.selection.size > 0 && !this.pending;
      const arrow = (dx, dy) => () => this.#moveSelection(dx, dy, false);
      this.studio.commands.registerAll([
        { id: "atlas.save", title: "Guardar hoja y JSON", group: "Atlas", keys: ["Ctrl+S"], whileTyping: true, enabled: () => this.history.dirty, run: () => this.save() },
        { id: "atlas.undo", title: "Deshacer", group: "Atlas", keys: ["Ctrl+Z"], enabled: () => this.history.canUndo, run: () => this.history.undo() },
        { id: "atlas.redo", title: "Rehacer", group: "Atlas", keys: ["Ctrl+Y", "Ctrl+Shift+Z"], enabled: () => this.history.canRedo, run: () => this.history.redo() },
        { id: "atlas.empty", title: "Vaciar celdas seleccionadas", group: "Atlas", keys: ["Delete", "Backspace"], enabled: sel, run: () => this.#emptySelection() },
        { id: "atlas.cancel", title: "Cancelar / quitar selección", group: "Atlas", keys: ["Escape"], hidden: true, run: () => this.#cancel() },
        { id: "atlas.fit", title: "Ver la hoja entera", group: "Atlas", keys: ["F"], enabled: has, run: () => this.#fit() },
        { id: "atlas.marks", title: "Mostrar/ocultar marcas", group: "Atlas", keys: ["M"], enabled: has, run: () => this.#toggleMarks() },
        { id: "atlas.coords", title: "Mostrar/ocultar coordenadas", group: "Atlas", keys: ["C"], enabled: has, run: () => this.#toggleCoords() },
        { id: "atlas.pixelsOnly", title: "Solo píxeles (mover sin cambiar los JSON)", group: "Atlas", keys: ["P"], enabled: has, run: () => this.#togglePixelsOnly() },
        { id: "atlas.all", title: "Seleccionar todo el arte", group: "Atlas", keys: ["Ctrl+A"], enabled: has, run: () => this.#select([...this.#artCells].map(pk)) },
        { id: "atlas.left", title: "Mover selección a la izquierda", group: "Atlas", keys: ["ArrowLeft"], enabled: sel, hidden: true, run: arrow(-1, 0) },
        { id: "atlas.right", title: "Mover selección a la derecha", group: "Atlas", keys: ["ArrowRight"], enabled: sel, hidden: true, run: arrow(1, 0) },
        { id: "atlas.up", title: "Mover selección arriba", group: "Atlas", keys: ["ArrowUp"], enabled: sel, hidden: true, run: arrow(0, -1) },
        { id: "atlas.down", title: "Mover selección abajo", group: "Atlas", keys: ["ArrowDown"], enabled: sel, hidden: true, run: arrow(0, 1) },
        { id: "atlas.gap", title: "Colocar en el primer hueco libre", group: "Atlas", enabled: () => !!this.pending, run: () => this.#findGap(true) },
      ], this.id);
    }

    extraKeys() {
      const group = "Atlas · ratón";
      return [
        { group, title: "Mover celdas (intercambia con lo que haya)", keys: ["Arrastrar"] },
        { group, title: "Copiar celdas", keys: ["Alt+Arrastrar"] },
        { group, title: "Añadir / quitar de la selección", keys: ["Shift+Clic", "Ctrl+Clic"] },
        { group, title: "Abrir el tile de la celda", keys: ["Doble clic"] },
      ];
    }
  }

  function pasteInto(out, W, H, r, block) {
    for (let y = 0; y < r.h; y++) {
      if (r.y + y >= H) break;
      const n = Math.min(r.w, W - r.x);
      if (n > 0) out.set(block.subarray(y * r.w * 4, (y * r.w + n) * 4), ((r.y + y) * W + r.x) * 4);
    }
  }

  function toCanvas(rgba, size) {
    const c = new OffscreenCanvas(size, size);
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
    return c;
  }

  Aura.atlasTool = { atlasTool };
})(window.Aura ??= {});
