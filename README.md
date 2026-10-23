# Aura Studio

Las herramientas de desarrollo de Aura en una sola página: abres la carpeta del proyecto una vez y todas la usan.
Solo HTML, CSS y JavaScript: nada que instalar ni compilar.

**Para usarla** abre `index.html` en Chrome o Edge (hace falta la API de carpetas del navegador).
**Para cambiarla** edita los archivos y recarga la página (F5).

| Pestaña | Qué hace |
|---|---|
| Crear | Genera sprites con su `_n`: modo **Bloque** (cubos, losas, escaleras… con caras de una hoja) y **Planta** (hierba, flores, cultivos, plantas de agua, hojas de 16 especies, semillas). Sección Bioma (escala de grises para `biome_tinted`), vista Contexto (3 × 3 con bioma, luz y viento), Básico/Avanzado, Crecimiento (etapas y columnas). «Enviar al Atlas» lo coloca en una hoja. |
| Atlas | Edita las hojas de tiles: mover, intercambiar, copiar y vaciar celdas arrastrando. Los mapas (`_n`, `_d`…) y las coordenadas de los JSON de tiles se actualizan solos. Inspector con formulario y JSON, tiles nuevos (también juegos completos de crecimiento), vista Bioma y pasar a gris, revisión de referencias rotas. Deshacer/rehacer y Ctrl+S. |
| Biomas | Crea y edita los biomas de `Data/Worldgen/Biomes`: mapa de clima (qué bioma gana, huecos y solapes), muestra con los tiles reales, **vista 3D** (un trozo con sus árboles y casas, cada tile con el color de su sprite, para girar), materiales, decoración, **estructuras** (cuáles y con qué densidad), colores, revisión de tiles y estructuras que no existen. |
| Estructuras | Un solo editor para `Data/Worldgen/Structures` y `Data/Worldgen/Templates`, con dos vistas: **iso 2D** (los sprites del juego) y **3D** (cada tile con el color de su sprite). Las plantillas se construyen bloque a bloque en cualquiera de las dos: clic pone, clic derecho quita, Alt+clic copia el tile, Shift+arrastrar rellena o vacía un rectángulo; nivel de trabajo (W/S), orientación (R), forma (F), ver todo / fantasma / cortar (1 2 3), ocultar (H), anclaje (A), deshacer. Los árboles y casas se ven como los genera el juego (mismos generadores, misma semilla), de 1 a 9 a la vez, se ajustan con controles y se pueden **pasar a plantilla** para terminarlos a mano. Dónde pueden ir, qué biomas las usan, revisión y JSON. |
| Partículas | versión anterior dentro del Studio (v1) |

## Estructura

```
index.html              carga los estilos y los scripts, en orden
css/                    base.css (colores y controles), shell.css (marco), uno por herramienta
js/core/                lo que comparten todas
  dom.js                h() para crear elementos, utilidades
  studio.js             marco: pestañas, carpeta del proyecto, barra de estado, avisos, comandos
  project.js            la carpeta: un solo recorrido, búsquedas, atlases.json, .mgcb
  history.js            deshacer/rehacer por pasos (cada paso guarda solo lo que cambió)
  viewport.js           zoom y desplazamiento de un lienzo de píxeles
  ui/commands.js        atajos + paleta (Ctrl+K) + hoja de atajos (?) desde una sola lista
  ui/controls.js        controles de panel (deslizador, selector, casilla…)
  ui/dialog.js          diálogos (sustituyen confirm/prompt)
  ui/toast.js           avisos apilados
js/tools/<herramienta>/ cada herramienta en su carpeta
js/main.js              registra las herramientas
legacy/*.js             herramientas aún no migradas, tal cual (su HTML como texto)
```

Cada archivo es un script normal que se registra en `window.Aura` (`Aura.dom`, `Aura.history`…) y toma de ahí lo que
usa, así que el orden de los `<script>` en `index.html` importa: un archivo solo puede usar los de encima.

`js/tools/shared/` tiene lo que usan varias herramientas: `sheets.js` (las hojas del proyecto y sus mapas `_n`, `_d`…),
`mgcb.js` (añadir un mapa nuevo al `.mgcb` copiando la entrada de su hoja) y `cells.js` (escribir sprites en celdas).
El Atlas está en `js/tools/atlas/`: `tiles.js` (los JSON de tiles y su formato), `layers.js` (la hoja y sus mapas como
píxeles) y `tool.js` (la interfaz).

### Añadir una herramienta

1. Crea `js/tools/mi-herramienta/tool.js`:
   ```js
   "use strict";
   (function (Aura) {
     const { h } = Aura.dom;
     function miHerramienta() {
       return {
         id: "mia", title: "Mi herramienta",
         mount(host, studio) { /* construir la interfaz en host */ },
         activate() {}, deactivate() {},
         onProject(project) { /* se abrió o releyó la carpeta */ },
         isDirty: () => false,
       };
     }
     Aura.miHerramienta = { miHerramienta };
   })(window.Aura ??= {});
   ```
2. Registra sus comandos con `studio.commands.registerAll([...], id)`: así tienen atajo, aparecen en Ctrl+K y en `?`.
3. Añade su `<script>` en `index.html` (antes de `main.js`), su línea `studio.addTool(...)` en `js/main.js` y, si hace
   falta, `css/mi-herramienta.css`.
