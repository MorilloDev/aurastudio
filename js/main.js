"use strict";

// Aura Studio: the shell and its tools. A new tool is one <script> in index.html and one addTool line here.
(function (Aura) {
  const studio = new Aura.studio.Studio(document.getElementById("app"));
  studio.addTool(Aura.normalsTool.normalsTool());
  studio.addTool(Aura.blocksTool.blocksTool());
  studio.addTool(Aura.legacy.legacyTool({ id: "structures", title: "Estructuras", source: "structures" }));
  studio.addTool(Aura.legacy.legacyTool({ id: "atlas", title: "Atlas", source: "atlas" }));
  studio.addTool(Aura.legacy.legacyTool({ id: "particles", title: "Partículas", source: "particles" }));
  studio.registerToolSwitching();
  studio.start();

  // For poking at from the console.
  window.auraStudio = studio;
})(window.Aura ??= {});
