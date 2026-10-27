"use strict";

// Particle effects — same schema as ParticleEffectRegistry.cs / Data/Particles/*.json
(function (Aura) {
  const { readText, baseName, joinPath, dirName } = Aura.fs;

  // Data/Particles/foo.json or Assets/Data/Particles/foo.json (any depth)
  const isParticleFile = (entry) =>
    /(^|\/)data\/particles\/[^/]+\.json$/i.test(entry.lower);

  const isEffectPng = (entry) =>
    /\.png$/i.test(entry.lower) && /(^|\/)(assets\/)?effects\//i.test(entry.lower);

  function defaults(id = "default") {
    return {
      id: id.includes(":") ? id : "aura:" + id,
      texture: "",
      frameCount: 1,
      fps: 24,
      essential: false,
      emission: { type: "burst", count: [4, 8], rate: 30, duration: -1 },
      spawn: {
        shape: "sphere",
        radius: 0.2,
        velocity: { min: [-1, 1, -1], max: [1, 2, 1] },
      },
      lifetime: [0.4, 0.8],
      scale: [0.2, 0.5],
      render: { tint: [255, 255, 255, 255], lighting: "lit" },
      behaviors: {
        gravity: [0, -9.8, 0],
        drag: 0.8,
        alphaCurve: [0, 1, 1, 0],
      },
      subEmitters: [],
      trail: null,
    };
  }

  function bareId(name) {
    if (!name) return "";
    const s = String(name);
    return s.startsWith("aura:") ? s.slice(5) : s.includes(":") ? s.split(":").pop() : s;
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
    // Game uses 4 keys; some authored files have 5 — take first 4 and last as end if needed
    if (!Array.isArray(a) || a.length < 4) return null;
    if (a.length === 4) return [+a[0], +a[1], +a[2], +a[3]];
    // 5 keys: sample at 0, 1/3, 2/3, 1 approximately
    return [+a[0], +a[1], +a[Math.floor(a.length / 2)], +a[a.length - 1]];
  }

  function color(c, fb = [255, 255, 255, 255]) {
    if (!Array.isArray(c) || c.length < 3) return fb.slice();
    return [c[0] | 0, c[1] | 0, c[2] | 0, c.length > 3 ? c[3] | 0 : 255];
  }

  /** Disk JSON → runtime (preview). Mirrors ParticleEffectRegistry.LoadEffect. */
  function compile(data, fileId) {
    const d = data || {};
    const id = bareId(d.id || d.name || fileId || "fx");
    const fx = {
      id,
      texture: typeof d.texture === "string" && d.texture ? d.texture.replace(/\.png$/i, "") : null,
      frameCount: d.frameCount ?? 1,
      fps: d.fps ?? 24,
      essential: d.essential === true,
      emission: "burst",
      burst: [1, 1],
      rate: 30,
      interval: 1,
      duration: -1,
      shape: "box",
      boxMin: [0, 0, 0],
      boxMax: [0, 0, 0],
      radius: 0,
      innerRadius: 0,
      direction: [0, 1, 0],
      angle: 30,
      length: 1,
      velMin: [0, 0, 0],
      velMax: [0, 0, 0],
      lifetime: range(d.lifetime, 1, 1),
      rotation: range(d.rotation, 0, 0),
      angularVelocity: range(d.angularVelocity, 0, 0),
      scaleX: [1, 1],
      scaleY: [1, 1],
      tint: [255, 255, 255, 255],
      lighting: "lit",
      alignToVelocity: false,
      pivot: [0.5, 0.5],
      gravity: null,
      drag: null,
      wind: null,
      maxSpeed: null,
      alphaCurve: null,
      scaleCurve: null,
      rotationCurve: null,
      colorCurve: null,
      collision: { mode: "none", bounciness: 0.5, friction: 0 },
      subEmitters: [],
      trail: null,
      maxParticles: 1024,
    };

    const em = d.emission;
    if (em) {
      const t = em.type;
      fx.emission = t === "continuous" ? "continuous" : t === "interval" ? "interval" : "burst";
      if (Array.isArray(em.count) && em.count.length >= 2) fx.burst = [em.count[0] | 0, em.count[1] | 0];
      if (em.rate != null) fx.rate = +em.rate;
      if (em.intervalSeconds != null) fx.interval = +em.intervalSeconds;
      if (em.duration != null) fx.duration = +em.duration;
    }

    const sp = d.spawn;
    if (sp) {
      if (sp.positionOffset) {
        fx.shape = "box";
        fx.boxMin = vec3(sp.positionOffset.min);
        fx.boxMax = vec3(sp.positionOffset.max);
      }
      if (typeof sp.shape === "string") {
        fx.shape = ["sphere", "hemisphere", "ring", "cone", "line", "box", "point"].includes(sp.shape)
          ? sp.shape : "box";
      }
      if (sp.radius != null) fx.radius = +sp.radius;
      if (sp.innerRadius != null) fx.innerRadius = +sp.innerRadius;
      if (sp.direction) fx.direction = vec3(sp.direction, [0, 1, 0]);
      if (sp.angle != null) fx.angle = +sp.angle;
      if (sp.length != null) fx.length = +sp.length;
      if (sp.velocity) {
        fx.velMin = vec3(sp.velocity.min, fx.velMin);
        fx.velMax = vec3(sp.velocity.max, fx.velMax);
      }
    }

    if (Array.isArray(d.scale)) {
      if (Array.isArray(d.scale[0])) {
        // ReadScaleRange: nested [x range, y range] — C# uses max-first on nested
        fx.scaleX = [+d.scale[0][1], +d.scale[0][0]].sort((a, b) => a - b);
        fx.scaleY = [+d.scale[1][1], +d.scale[1][0]].sort((a, b) => a - b);
      } else {
        fx.scaleX = range(d.scale, 0.2, 0.5);
        fx.scaleY = fx.scaleX.slice();
      }
    }

    const rn = d.render;
    if (rn) {
      if (rn.tint) fx.tint = color(rn.tint, fx.tint);
      if (rn.lighting) fx.lighting = rn.lighting === "emissive" ? "emissive" : "lit";
      fx.alignToVelocity = rn.alignToVelocity === true;
      if (rn.pivot === "left") fx.pivot = [0, 0.5];
      else if (rn.pivot === "right") fx.pivot = [1, 0.5];
      else if (Array.isArray(rn.pivot)) fx.pivot = [+rn.pivot[0], +rn.pivot[1]];
    }

    const bh = d.behaviors;
    if (bh) {
      if (Array.isArray(bh.gravity)) fx.gravity = vec3(bh.gravity);
      if (typeof bh.drag === "number") fx.drag = bh.drag;
      if (typeof bh.wind === "number") fx.wind = bh.wind;
      if (typeof bh.maxSpeed === "number") fx.maxSpeed = bh.maxSpeed;
      if (curve4(bh.alphaCurve)) fx.alphaCurve = curve4(bh.alphaCurve);
      if (curve4(bh.scaleCurve)) fx.scaleCurve = curve4(bh.scaleCurve);
      if (curve4(bh.rotationCurve)) fx.rotationCurve = curve4(bh.rotationCurve);
      if (bh.colorCurve && bh.colorCurve.start) {
        fx.colorCurve = [
          color(bh.colorCurve.start),
          color(bh.colorCurve.mid || bh.colorCurve.start),
          color(bh.colorCurve.end || bh.colorCurve.start),
        ];
      }
      if (bh.collision && typeof bh.collision === "object") {
        fx.collision = {
          mode: bh.collision.mode === "kill" ? "kill" : bh.collision.mode === "bounce" ? "bounce" : "none",
          bounciness: bh.collision.bounciness ?? 0.5,
          friction: bh.collision.friction ?? 0,
        };
      }
    }

    for (const s of d.subEmitters || []) {
      fx.subEmitters.push({
        event: s.event === "death" ? "death" : s.event === "collision" ? "collision" : "spawn",
        effect: bareId(s.effect || ""),
        chance: s.chance ?? 1,
        count: s.count ?? 0,
      });
    }
    if (d.trail && d.trail.effect) {
      fx.trail = { effect: bareId(d.trail.effect), rate: d.trail.rate ?? 30 };
    }
    return fx;
  }

  function parseFile(text, name) {
    const raw = text.trim() ? JSON.parse(text) : defaults(name.replace(/\.json$/i, ""));
    // Array of effects in one file — take first for split-file workflow we keep one doc per file
    const data = Array.isArray(raw) ? raw[0] : raw;
    const fileId = name.replace(/\.json$/i, "");
    if (!data.id && !data.name) data.id = "aura:" + fileId;
    return data;
  }

  function serialize(data) {
    return JSON.stringify(data, null, 2) + "\n";
  }

  const isDirty = (doc) => (doc.isNew ? true : serialize(doc.data) !== doc.baseline);

  async function loadFiles(project) {
    const docs = [];
    const entries = project.filter(isParticleFile).sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of entries) {
      const name = baseName(entry.path);
      const fileId = name.replace(/\.json$/i, "");
      const doc = {
        entry, path: entry.path, name, fileId,
        data: defaults(fileId), baseline: "", error: null, isNew: false, fx: null,
      };
      try {
        const text = await readText(entry.handle);
        doc.data = parseFile(text, name);
        doc.baseline = serialize(doc.data);
        doc.fx = compile(doc.data, fileId);
      } catch (err) {
        doc.error = err.message;
      }
      docs.push(doc);
    }
    return docs;
  }

  /** Built-in demos so the tool is usable without a project folder. */
  function loadDemoDocs() {
    const pack = Aura.particlesDemo || {};
    return Object.keys(pack).sort().map((fileId) => {
      const data = JSON.parse(JSON.stringify(pack[fileId]));
      if (!data.id && !data.name) data.id = "aura:" + fileId;
      return {
        entry: null, path: "demo/" + fileId + ".json", name: fileId + ".json", fileId,
        data, baseline: serialize(data), error: null, isNew: false, demo: true,
        fx: compile(data, fileId),
      };
    });
  }

  function particlesDir(project, docs) {
    const real = docs.filter((d) => !d.demo);
    if (real.length) return dirName(real[0].path);
    const any = project?.filter((e) => /(^|\/)data\//i.test(e.lower))[0];
    if (!any) return "Assets/Data/Particles";
    const at = any.lower.lastIndexOf("/data/");
    if (at >= 0) return joinPath(any.path.slice(0, at + 5), "Particles");
    return "Assets/Data/Particles";
  }

  function listTextures(project) {
    if (!project) return [];
    return project
      .filter(isEffectPng)
      .map((e) => {
        let p = e.path.replace(/\\/g, "/");
        const i = p.toLowerCase().indexOf("assets/");
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

  /** Spawn offset sample — mirrors SpawnShapeConfig.Sample conceptually. */
  function sampleSpawn(fx, rnd = Math.random) {
    const shape = fx.shape || "box";
    if (shape === "point") return [0, 0, 0];
    if (shape === "box") {
      return [
        fx.boxMin[0] + rnd() * (fx.boxMax[0] - fx.boxMin[0]),
        fx.boxMin[1] + rnd() * (fx.boxMax[1] - fx.boxMin[1]),
        fx.boxMin[2] + rnd() * (fx.boxMax[2] - fx.boxMin[2]),
      ];
    }
    const r0 = fx.innerRadius || 0;
    const r1 = fx.radius || 0.2;
    const u = rnd();
    const r = Math.sqrt(r0 * r0 + u * (r1 * r1 - r0 * r0));
    const theta = rnd() * Math.PI * 2;
    if (shape === "ring") {
      return [Math.cos(theta) * r, 0, Math.sin(theta) * r];
    }
    if (shape === "hemisphere") {
      const phi = rnd() * Math.PI * 0.5;
      return [Math.sin(phi) * Math.cos(theta) * r, Math.cos(phi) * r, Math.sin(phi) * Math.sin(theta) * r];
    }
    if (shape === "cone") {
      const ang = ((fx.angle || 25) * Math.PI) / 180;
      const phi = rnd() * ang;
      return [Math.sin(phi) * Math.cos(theta) * r, Math.cos(phi) * r, Math.sin(phi) * Math.sin(theta) * r];
    }
    // sphere
    const phi = Math.acos(2 * rnd() - 1);
    return [Math.sin(phi) * Math.cos(theta) * r, Math.cos(phi) * r, Math.sin(phi) * Math.sin(theta) * r];
  }

  Aura.particlesModel = {
    isParticleFile, defaults, bareId, compile, parseFile, serialize, isDirty,
    loadFiles, loadDemoDocs, particlesDir, listTextures, evalCurve, evalColorCurve,
    range, vec3, color, curve4, sampleSpawn,
  };
})(window.Aura ??= {});
