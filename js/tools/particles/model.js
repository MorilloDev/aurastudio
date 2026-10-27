"use strict";

// Particle effects under Assets/Data/Particles (or Data/Particles): one JSON file per effect.
(function (Aura) {
  const { readText, baseName, joinPath, dirName } = Aura.fs;

  const isParticleFile = (entry) =>
    /(^|\/)(assets\/)?data\/particles\/[^/]+\.json$/i.test(entry.lower);

  /** Defaults aligned with the legacy editor / game ParticleSystem. */
  function defaults(id = "nuevo_efecto") {
    return {
      id,
      texture: "",
      fps: 24,
      essential: false,
      emission: "burst", // burst | rate
      burst: [8, 12],
      rate: 30,
      duration: -1,
      shape: "sphere", // box | sphere | cone | point
      boxMin: [0, 0, 0],
      boxMax: [0, 0, 0],
      radius: 0.4,
      innerRadius: 0,
      direction: [0, 1, 0],
      angle: 25,
      length: 1,
      velMin: [-0.4, 1.2, -0.4],
      velMax: [0.4, 2.4, 0.4],
      lifetime: [0.6, 1.2],
      startSize: [0.15, 0.25],
      endSize: [0.05, 0.1],
      startColor: [255, 220, 120, 255],
      endColor: [80, 40, 20, 0],
      gravity: [0, -2.5, 0],
      drag: 0.1,
      maxParticles: 256,
      alignToVelocity: false,
    };
  }

  function parseFile(text, name) {
    const data = text.trim() ? JSON.parse(text) : defaults(name.replace(/\.json$/i, ""));
    if (!data.id) data.id = name.replace(/\.json$/i, "");
    return data;
  }

  function serialize(data) {
    return JSON.stringify(data, null, 2) + "\n";
  }

  const isDirty = (doc) =>
    doc.isNew ? true : serialize(doc.data) !== doc.baseline;

  async function loadFiles(project) {
    const docs = [];
    const entries = project.filter(isParticleFile).sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of entries) {
      const name = baseName(entry.path);
      const doc = {
        entry, path: entry.path, name,
        data: defaults(name.replace(/\.json$/i, "")),
        baseline: "", error: null, isNew: false,
      };
      try {
        const text = await readText(entry.handle);
        doc.data = parseFile(text, name);
        doc.baseline = serialize(doc.data);
      } catch (err) {
        doc.error = err.message;
      }
      docs.push(doc);
    }
    return docs;
  }

  function particlesDir(project, docs) {
    if (docs.length) return dirName(docs[0].path);
    // Prefer Assets/Data/Particles next to Content layout
    const any = project.filter((e) => /(^|\/)data\//i.test(e.lower))[0];
    if (!any) return null;
    const lower = any.lower;
    const at = lower.lastIndexOf("/data/");
    if (at >= 0) return joinPath(any.path.slice(0, at + 5), "Particles");
    return "Assets/Data/Particles";
  }

  Aura.particlesModel = {
    isParticleFile, defaults, parseFile, serialize, isDirty, loadFiles, particlesDir,
  };
})(window.Aura ??= {});
