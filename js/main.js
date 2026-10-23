"use strict";

// Aura Studio: the shell and its tools. A new tool is one <script> in index.html and one addTool line here.
(function (Aura) {
  const studio = new Aura.studio.Studio(document.getElementById("app"));
  studio.addTool(Aura.createTool.createTool());
  studio.addTool(Aura.atlasTool.atlasTool());
  studio.addTool(Aura.biomesTool.biomesTool());
  studio.addTool(Aura.recipesTool.recipesTool());
  studio.addTool(Aura.structuresTool.structuresTool());
  studio.addTool(Aura.legacy.legacyTool({ id: "templates", title: "Plantillas", source: "structures" }));
  studio.addTool(Aura.legacy.legacyTool({ id: "particles", title: "Partículas", source: "particles" }));
  studio.registerToolSwitching();
  studio.start();

  // For poking at from the console.
  window.auraStudio = studio;
})(window.Aura ??= {});
