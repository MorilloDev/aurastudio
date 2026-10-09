# Aura Studio

Las herramientas de desarrollo de Aura en una sola página: abres la carpeta del proyecto una vez y todas la usan.
Solo HTML, CSS y JavaScript: nada que instalar ni compilar.

**Para usarla** abre `index.html` en Chrome o Edge (hace falta la API de carpetas del navegador).
**Para cambiarla** edita los archivos y recarga la página (F5).

| Pestaña | Estado |
|---|---|
| Normal maps | migrada (v2) |
| Estructuras, Atlas, Partículas | versión anterior dentro del Studio (v1), se migran en las próximas fases |

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

El generador de normal maps (`js/tools/normals/generator.js`) es una sola función sin nada de fuera: su texto arranca el
proceso en segundo plano (Web Worker), porque una página abierta desde el disco no puede cargar un worker de otro archivo.

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
