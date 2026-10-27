"use strict";

// Particle effects: Assets/Data/Particles/*.json as the game / legacy editor expect.
(function (Aura) {
  const { readText, baseName, joinPath, dirName } = Aura.fs;

  const isParticleFile = (entry) =>
    /(^|\/)(assets\/)?data\/particles\/[^/]+\.json$/i.test(entry.lower);

  const isEffectPng = (entry) =>
    /(^|\/)(assets\/)?effects\/.+\.png$/i.test(entry.lower) ||
    /(^|\/)assets\/effects\/.+\.png$/i.test(entry.lower);

  /** Nested JSON defaults (disk format). */
  function defaults(id = "nuevo_efecto") {
    return {
      id: id.startsWith("aura:") ? id : "aura:" + id,
      texture: "",
      frameCount: 1,
      fps: 24,
      essential: false,
      emission: { type: "burst", count: [8, 12], rate: 30, duration: -1 },
      spawn: {
        shape: "sphere",
        radius: 0.35,
        innerRadius: 0,
        direction: [0, 1, 0],
        angle: 25,
        velocity: { min: [-0.4, 1.2, -0.4], max: [0.4, 2.4, 0.4] },
      },
      lifetime: [0.6, 1.2],
      scale: [0.2, 0.35],
      render: {
        tint: [255, 220, 140, 255],
        alignToVelocity: false,
        lighting: "emissive",
      },
      behaviors: {
        gravity: [0, -2.5, 0],
        drag: 0.08,
        alphaCurve: [1, 1, 0.6, 0],
        scaleCurve: [1, 1.1, 0.8, 0.3],
        colorCurve: null,
      },
      subEmitters: [],
      trail: null,
    };
  }

  function bareId(name) {
    if (!name) return "";
    const s = String(name);
    return s.startsWith("aura:") ? s.slice(5) : s;
  }

  function range(v, a = 0, b = 0) {
    if (Array.isArray(v) && v.length >= 2) return [+v[0], +v[1]];
    if (typeof v === "number") return [v, v];
    return [a, b];
  }

  function vec3(v, fb = [0, 0, 0]) {
    if (!Array.isArray(v) || v.length < 3) return fb.slice();
    return [+v[0], +v[1], +v[2]];
  }

  function curve4(a) {
    return Array.isArray(a) && a.length >= 4 ? [+a[0], +a[1], +a[2], +a[3]] : null;
  }

  function color(c, fb = [255, 255, 255, 255]) {
    if (!Array.isArray(c) || c.length < 3) return fb.slice();
    return [c[0] | 0, c[1] | 0, c[2] | 0, c.length > 3 ? c[3] | 0 : 255];
  }

  /** Compile disk JSON → runtime shape used by the preview sim. */
  function compile(data) {
    const d = data || {};
    const id = bareId(d.id || "fx");
    const fx = {
      id,
      texture: typeof d.texture === "string" && d.texture ? d.texture : null,
      frameCount: d.frameCount ?? 1,
      fps: d.fps ?? 24,
      essential: d.essential === true,
      emission: "burst",
      burst: [8, 12],
      rate: 30,
      interval: 1,
      duration: -1,
      shape: "sphere",
      boxMin: [0, 0, 0],
      boxMax: [0, 0, 0],
      radius: 0.35,
      innerRadius: 0,
      direction: [0, 1, 0],
      angle: 25,
      length: 1,
      velMin: [-0.3, 1, -0.3],
      velMax: [0.3, 2, 0.3],
      lifetime: range(d.lifetime, 0.6, 1.2),
      scaleX: [0.2, 0.35],
      scaleY: [0.2, 0.35],
      tint: [255, 220, 140, 255],
      alignToVelocity: false,
      gravity: [0, -2.5, 0],
      drag: 0.08,
      alphaCurve: [1, 1, 0.6, 0],
      scaleCurve: [1, 1.1, 0.8, 0.3],
      colorCurve: null,
      subEmitters: [],
      trail: null,
      maxParticles: 512,
    };

    const em = d.emission;
    if (em) {
      fx.emission = em.type === "continuous" || em.type === "rate" ? "continuous"
        : em.type === "interval" ? "interval" : "burst";
      if (Array.isArray(em.count)) fx.burst = [em.count[0] | 0, em.count[1] | 0];
      if (em.rate != null) fx.rate = +em.rate;
      if (em.intervalSeconds != null) fx.interval = +em.intervalSeconds;
      if (em.duration != null) fx.duration = +em.duration;
    }

    const sp = d.spawn;
    if (sp) {
      if (typeof sp.shape === "string") fx.shape = sp.shape;
      if (sp.radius != null) fx.radius = +sp.radius;
      if (sp.innerRadius != null) fx.innerRadius = +sp.innerRadius;
      if (sp.direction) fx.direction = vec3(sp.direction, [0, 1, 0]);
      if (sp.angle != null) fx.angle = +sp.angle;
      if (sp.length != null) fx.length = +sp.length;
      if (sp.positionOffset) {
        fx.shape = "box";
        fx.boxMin = vec3(sp.positionOffset.min);
        fx.boxMax = vec3(sp.positionOffset.max);
      }
      if (sp.velocity) {
        fx.velMin = vec3(sp.velocity.min, fx.velMin);
        fx.velMax = vec3(sp.velocity.max, fx.velMax);
      }
    }

    if (Array.isArray(d.scale)) {
      if (Array.isArray(d.scale[0])) {
        fx.scaleX = [+d.scale[0][0], +d.scale[0][1]];
        fx.scaleY = [+d.scale[1][0], +d.scale[1][1]];
      } else {
        fx.scaleX = range(d.scale, 0.2, 0.35);
        fx.scaleY = fx.scaleX.slice();
      }
    }

    const rn = d.render;
    if (rn) {
      if (rn.tint) fx.tint = color(rn.tint, fx.tint);
      fx.alignToVelocity = rn.alignToVelocity === true;
    }

    const bh = d.behaviors;
    if (bh) {
      if (Array.isArray(bh.gravity)) fx.gravity = vec3(bh.gravity, fx.gravity);
      if (typeof bh.drag === "number") fx.drag = bh.drag;
      if (curve4(bh.alphaCurve)) fx.alphaCurve = curve4(bh.alphaCurve);
      if (curve4(bh.scaleCurve)) fx.scaleCurve = curve4(bh.scaleCurve);
      if (bh.colorCurve && bh.colorCurve.start) {
        fx.colorCurve = [
          color(bh.colorCurve.start),
          color(bh.colorCurve.mid || bh.colorCurve.start),
          color(bh.colorCurve.end || bh.colorCurve.start),
        ];
      }
    }

    for (const s of d.subEmitters || []) {
      fx.subEmitters.push({
        event: s.event === "death" ? "death" : s.event === "collision" ? "collision" : "spawn",
        effect: bareId(s.effect || ""),
        chance: s.chance ?? 1,
        count: s.count ?? 1,
      });
    }
    if (d.trail) fx.trail = { effect: bareId(d.trail.effect || ""), rate: d.trail.rate ?? 30 };

    return fx;
  }

  function parseFile(text, name) {
    const data = text.trim() ? JSON.parse(text) : defaults(name.replace(/\.json$/i, ""));
    if (!data.id) data.id = "aura:" + name.replace(/\.json$/i, "");
    return data;
  }

  function serialize(data) {
    return JSON.stringify(data, null, 2) + "\n";
  }

  const isDirty = (doc) => (doc.isNew ? true : serialize(doc.data) !== doc.baseline);

  async function loadFiles(project) {
    const docs = [];
    for (const entry of project.filter(isParticleFile).sort((a, b) => a.path.localeCompare(b.path))) {
      const name = baseName(entry.path);
      const doc = {
        entry, path: entry.path, name,
        data: defaults(name.replace(/\.json$/i, "")),
        baseline: "", error: null, isNew: false, fx: null,
      };
      try {
        const text = await readText(entry.handle);
        doc.data = parseFile(text, name);
        doc.baseline = serialize(doc.data);
        doc.fx = compile(doc.data);
      } catch (err) {
        doc.error = err.message;
      }
      docs.push(doc);
    }
    return docs;
  }

  function particlesDir(project, docs) {
    if (docs.length) return dirName(docs[0].path);
    const any = project.filter((e) => /(^|\/)data\//i.test(e.lower))[0];
    if (!any) return "Assets/Data/Particles";
    const at = any.lower.lastIndexOf("/data/");
    if (at >= 0) return joinPath(any.path.slice(0, at + 5), "Particles");
    return "Assets/Data/Particles";
  }

  /** Content paths of PNGs under Assets/Effects for the texture picker. */
  function listTextures(project) {
    return project
      .filter(isEffectPng)
      .map((e) => {
        // Prefer path relative style Assets/Effects/... without extension for game ids
        let p = e.path.replace(/\\/g, "/");
        const i = p.toLowerCase().lastIndexOf("assets/");
        if (i >= 0) p = p.slice(i);
        return p.replace(/\.png$/i, "");
      })
      .sort((a, b) => a.localeCompare(b));
  }

  function evalCurve(c, t) {
    if (!c || c.length < 4) return 1;
    if (t <= 0) return c[0];
    if (t >= 1) return c[3];
    if (t < 1 / 3) return c[0] + (c[1] - c[0]) * (t * 3);
    if (t < 2 / 3) return c[1] + (c[2] - c[1]) * ((t - 1 / 3) * 3);
    return c[2] + (c[3] - c[2]) * ((t - 2 / 3) * 3);
  }

  function evalColorCurve(cc, t) {
    if (!cc || cc.length < 3) return null;
    if (t <= 0) return cc[0].slice();
    if (t >= 1) return cc[2].slice();
    const [a, b, k] = t < 0.5 ? [cc[0], cc[1], t * 2] : [cc[1], cc[2], (t - 0.5) * 2];
    return [0, 1, 2, 3].map((i) => Math.round(a[i] + (b[i] - a[i]) * k));
  }

  Aura.particlesModel = {
    isParticleFile, defaults, bareId, compile, parseFile, serialize, isDirty,
    loadFiles, particlesDir, listTextures, evalCurve, evalColorCurve, range, vec3, color, curve4,
  };
})(window.Aura ??= {});
