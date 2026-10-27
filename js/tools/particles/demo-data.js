"use strict";
(function (Aura) {
  Aura.particlesDemo = {
  "default": {
    "emission": {
      "type": "burst",
      "count": [
        4,
        8
      ]
    },
    "spawn": {
      "positionOffset": {
        "min": [
          -0.1,
          0,
          -0.1
        ],
        "max": [
          0.1,
          0.1,
          0.1
        ]
      },
      "velocity": {
        "min": [
          -1.0,
          1.0,
          -1.0
        ],
        "max": [
          1.0,
          2.0,
          1.0
        ]
      }
    },
    "lifetime": [
      0.4,
      0.8
    ],
    "scale": [
      0.2,
      0.5
    ],
    "behaviors": {
      "gravity": [
        0,
        -9.8,
        0
      ],
      "drag": 0.8,
      "alphaCurve": [
        0,
        1,
        1,
        0
      ]
    }
  },
  "chimney_smoke": {
    "texture": "Assets/Effects/Smoke/Smoke_3",
    "emission": {
      "type": "continuous",
      "rate": 2,
      "duration": -1
    },
    "spawn": {
      "positionOffset": {
        "min": [
          -0.1,
          0,
          -0.1
        ],
        "max": [
          0.1,
          0.05,
          0.1
        ]
      },
      "velocity": {
        "min": [
          -0.25,
          0.8,
          -0.25
        ],
        "max": [
          0.25,
          1.2,
          0.25
        ]
      }
    },
    "lifetime": [
      6,
      12
    ],
    "angularVelocity": [
      -0.35,
      0.35
    ],
    "scale": [
      0.075,
      0.1
    ],
    "render": {
      "tint": [
        90,
        90,
        88,
        200
      ]
    },
    "behaviors": {
      "gravity": [
        0,
        0.25,
        0
      ],
      "drag": 0.3,
      "alphaCurve": [
        0.6,
        0.5,
        0.3,
        0
      ],
      "scaleCurve": [
        0.1,
        0.5,
        0.75,
        1.5
      ],
      "colorCurve": {
        "start": [
          120,
          118,
          115,
          210
        ],
        "mid": [
          90,
          88,
          85,
          170
        ],
        "end": [
          60,
          58,
          56,
          0
        ]
      },
      "wind": 0.15,
      "collision": {
        "mode": "bounce",
        "bounciness": 0,
        "friction": 0.3
      }
    }
  },
  "dust": {
    "emission": {
      "type": "burst",
      "count": [
        3,
        5
      ]
    },
    "spawn": {
      "shape": "sphere",
      "radius": 0.4,
      "velocity": {
        "min": [
          -1.5,
          0.3,
          -1.5
        ],
        "max": [
          1.5,
          1.2,
          1.5
        ]
      }
    },
    "lifetime": [
      0.55,
      1.4
    ],
    "angularVelocity": [
      -1,
      1
    ],
    "scale": [
      0.05,
      0.075
    ],
    "render": {
      "tint": [
        150,
        140,
        125,
        200
      ]
    },
    "behaviors": {
      "gravity": [
        0,
        0.4,
        0
      ],
      "drag": 0.9,
      "alphaCurve": [
        0.8,
        0.6,
        0.3,
        0
      ],
      "scaleCurve": [
        0.5,
        1,
        2,
        2.5
      ]
    },
    "texture": "Assets/Effects/Smoke/Smoke_1"
  },
  "dust_puff": {
    "texture": "Assets/Effects/Smoke/Smoke_3",
    "emission": {
      "type": "burst",
      "count": [
        2,
        3
      ]
    },
    "spawn": {
      "positionOffset": {
        "min": [
          -0.15,
          0,
          -0.15
        ],
        "max": [
          0.15,
          0.05,
          0.15
        ]
      },
      "velocity": {
        "min": [
          -0.4,
          0.3,
          -0.4
        ],
        "max": [
          0.4,
          0.7,
          0.4
        ]
      }
    },
    "lifetime": [
      0.25,
      0.75
    ],
    "scale": [
      0.025,
      0.05
    ],
    "render": {
      "tint": [
        255,
        255,
        255,
        200
      ]
    },
    "behaviors": {
      "gravity": [
        0,
        -2,
        0
      ],
      "drag": 1,
      "alphaCurve": [
        0.7,
        0.5,
        0.2,
        0
      ],
      "wind": 1.3,
      "scaleCurve": [
        0.25,
        0.5,
        0.75,
        1
      ]
    }
  },
  "explosion": {
    "emission": {
      "type": "burst",
      "count": [
        1,
        1
      ]
    },
    "spawn": {
      "velocity": {
        "min": [
          0,
          0,
          0
        ],
        "max": [
          0,
          0,
          0
        ]
      }
    },
    "lifetime": [
      0.5,
      0.5
    ],
    "scale": [
      0.1,
      0.1
    ],
    "render": {
      "tint": [
        255,
        250,
        210,
        255
      ],
      "lighting": "emissive"
    },
    "behaviors": {
      "alphaCurve": [
        1,
        1,
        1,
        0.6,
        0
      ],
      "scaleCurve": [
        0.5,
        1,
        1.5,
        2,
        2.5
      ],
      "colorCurve": {
        "start": [
          255,
          250,
          210,
          255
        ],
        "mid": [
          255,
          120,
          30,
          250
        ],
        "end": [
          40,
          25,
          20,
          0
        ]
      }
    },
    "subEmitters": [
      {
        "event": "death",
        "effect": "explosion_shockwave",
        "chance": 1.0
      },
      {
        "event": "death",
        "effect": "explosion_sparks",
        "chance": 1.0
      },
      {
        "event": "death",
        "effect": "smoke_explosion",
        "chance": 1.0
      },
      {
        "event": "death",
        "effect": "explosion_embers",
        "chance": 0.9
      }
    ]
  },
  "explosion_sparks": {
    "emission": {
      "type": "burst",
      "count": [
        45,
        60
      ]
    },
    "spawn": {
      "shape": "sphere",
      "radius": 0.3,
      "velocity": {
        "min": [
          -13,
          3,
          -13
        ],
        "max": [
          13,
          15,
          13
        ]
      }
    },
    "lifetime": [
      0.4,
      0.75
    ],
    "scale": [
      0.1,
      0.2
    ],
    "render": {
      "tint": [
        255,
        190,
        90,
        255
      ],
      "lighting": "emissive"
    },
    "behaviors": {
      "gravity": [
        0,
        -19,
        0
      ],
      "drag": 0.4,
      "alphaCurve": [
        1,
        1,
        0.3,
        0
      ],
      "colorCurve": {
        "start": [
          255,
          230,
          160,
          255
        ],
        "mid": [
          255,
          140,
          50,
          240
        ],
        "end": [
          120,
          40,
          20,
          0
        ]
      }
    }
  },
  "explosion_embers": {
    "emission": {
      "type": "burst",
      "count": [
        10,
        16
      ]
    },
    "spawn": {
      "shape": "sphere",
      "radius": 0.4,
      "velocity": {
        "min": [
          -2,
          2,
          -2
        ],
        "max": [
          2,
          5,
          2
        ]
      }
    },
    "lifetime": [
      0.8,
      1.4
    ],
    "scale": [
      0.75,
      0.125
    ],
    "render": {
      "tint": [
        255,
        140,
        60,
        255
      ],
      "lighting": "emissive"
    },
    "behaviors": {
      "gravity": [
        0,
        -3,
        0
      ],
      "drag": 0.6,
      "alphaCurve": [
        1,
        1,
        0.4,
        0
      ],
      "colorCurve": {
        "start": [
          255,
          200,
          100,
          255
        ],
        "mid": [
          255,
          100,
          40,
          220
        ],
        "end": [
          80,
          30,
          20,
          0
        ]
      }
    }
  },
  "explosion_shockwave": {
    "emission": {
      "type": "burst",
      "count": [
        1,
        5
      ]
    },
    "spawn": {
      "shape": "hemisphere",
      "radius": 2,
      "innerRadius": 1.6,
      "velocity": {
        "min": [
          -4,
          0.3,
          -4
        ],
        "max": [
          4,
          0.6,
          4
        ]
      }
    },
    "lifetime": [
      0.35,
      0.35
    ],
    "scale": [
      0.1,
      0.15
    ],
    "render": {
      "tint": [
        255,
        210,
        140,
        220
      ],
      "lighting": "emissive"
    },
    "behaviors": {
      "drag": 0.2,
      "alphaCurve": [
        0.8,
        0.6,
        0.2,
        0
      ],
      "scaleCurve": [
        0.5,
        1,
        1.5,
        2
      ]
    },
    "texture": "Assets/Effects/Smoke/Smoke_1"
  },
  "smoke_explosion": {
    "emission": {
      "type": "burst",
      "count": [
        18,
        26
      ]
    },
    "spawn": {
      "shape": "hemisphere",
      "radius": 0.5,
      "velocity": {
        "min": [
          -3,
          1.5,
          -3
        ],
        "max": [
          3,
          4.5,
          3
        ]
      }
    },
    "lifetime": [
      1.5,
      2.3
    ],
    "scale": [
      0.1,
      0.15
    ],
    "render": {
      "tint": [
        80,
        78,
        75,
        220
      ]
    },
    "behaviors": {
      "gravity": [
        0,
        -0.8,
        0
      ],
      "drag": 0.85,
      "alphaCurve": [
        0,
        0.8,
        0.5,
        0
      ],
      "scaleCurve": [
        0.5,
        0.75,
        1,
        1.25
      ],
      "colorCurve": {
        "start": [
          100,
          95,
          90,
          230
        ],
        "mid": [
          65,
          62,
          60,
          200
        ],
        "end": [
          35,
          33,
          32,
          0
        ]
      }
    },
    "texture": "Assets/Effects/Smoke/Smoke_2"
  },
  "fountain": {
    "emission": {
      "type": "continuous",
      "rate": 20,
      "duration": -1
    },
    "spawn": {
      "shape": "cone",
      "direction": [
        0,
        1,
        0
      ],
      "angle": 25,
      "radius": 0.1,
      "velocity": {
        "min": [
          0,
          3,
          0
        ],
        "max": [
          0,
          5,
          0
        ]
      }
    },
    "lifetime": [
      1.0,
      1.6
    ],
    "scale": [
      0.15,
      0.25
    ],
    "render": {
      "tint": [
        180,
        220,
        255,
        220
      ]
    },
    "behaviors": {
      "gravity": [
        0,
        -9.8,
        0
      ],
      "drag": 0.9,
      "alphaCurve": [
        0,
        1,
        1,
        0
      ],
      "collision": {
        "mode": "bounce",
        "bounciness": 0.4,
        "friction": 0.3
      }
    }
  },
  "firework": {
    "emission": {
      "type": "burst",
      "count": [
        1,
        1
      ]
    },
    "spawn": {
      "velocity": {
        "min": [
          0,
          8,
          0
        ],
        "max": [
          0,
          10,
          0
        ]
      }
    },
    "lifetime": [
      0.9,
      1.2
    ],
    "scale": [
      0.2,
      0.3
    ],
    "render": {
      "tint": [
        255,
        240,
        200,
        255
      ],
      "lighting": "emissive"
    },
    "behaviors": {
      "gravity": [
        0,
        -8,
        0
      ],
      "alphaCurve": [
        1,
        1,
        1,
        0
      ]
    },
    "trail": {
      "effect": "trail_dot",
      "rate": 25
    },
    "subEmitters": [
      {
        "event": "death",
        "effect": "shockwave",
        "chance": 1.0
      }
    ]
  },
  "shockwave": {
    "emission": {
      "type": "burst",
      "count": [
        24,
        36
      ]
    },
    "spawn": {
      "shape": "ring",
      "radius": 1.2,
      "innerRadius": 1.0,
      "velocity": {
        "min": [
          -3,
          0.5,
          -3
        ],
        "max": [
          3,
          1.5,
          3
        ]
      }
    },
    "lifetime": [
      0.4,
      0.7
    ],
    "scale": [
      0.15,
      0.25
    ],
    "render": {
      "tint": [
        255,
        200,
        100,
        255
      ],
      "lighting": "emissive"
    },
    "behaviors": {
      "drag": 0.4,
      "alphaCurve": [
        0,
        1,
        0.6,
        0
      ]
    }
  },
  "trail_dot": {
    "emission": {
      "type": "burst",
      "count": [
        1,
        1
      ]
    },
    "lifetime": [
      0.25,
      0.4
    ],
    "scale": [
      0.1,
      0.2
    ],
    "render": {
      "tint": [
        255,
        220,
        120,
        255
      ],
      "lighting": "emissive"
    },
    "behaviors": {
      "alphaCurve": [
        1,
        1,
        0.5,
        0
      ],
      "scaleCurve": [
        0.5,
        0.75,
        1,
        1.25
      ]
    }
  },
  "trail_fire_smoke": {
    "emission": {
      "type": "burst",
      "count": [
        1,
        1
      ]
    },
    "lifetime": [
      0.6,
      0.8
    ],
    "scale": [
      0.3,
      0.4
    ],
    "render": {
      "tint": [
        255,
        200,
        100,
        255
      ],
      "lighting": "emissive"
    },
    "behaviors": {
      "gravity": [
        0,
        0.6,
        0
      ],
      "drag": 0.6,
      "alphaCurve": [
        1,
        0.9,
        0.6,
        0
      ],
      "scaleCurve": [
        0.5,
        0.75,
        1,
        1.25
      ],
      "colorCurve": {
        "start": [
          255,
          220,
          120,
          255
        ],
        "mid": [
          200,
          100,
          60,
          200
        ],
        "end": [
          60,
          60,
          60,
          0
        ]
      }
    }
  },
  "bouncing_debris": {
    "emission": {
      "type": "burst",
      "count": [
        6,
        10
      ]
    },
    "spawn": {
      "shape": "sphere",
      "radius": 0.2,
      "velocity": {
        "min": [
          -3,
          4,
          -3
        ],
        "max": [
          3,
          7,
          3
        ]
      }
    },
    "lifetime": [
      1.5,
      2.5
    ],
    "angularVelocity": [
      -6,
      6
    ],
    "scale": [
      0.15,
      0.3
    ],
    "render": {
      "tint": [
        160,
        130,
        90,
        255
      ],
      "alignToVelocity": true
    },
    "behaviors": {
      "gravity": [
        0,
        -15,
        0
      ],
      "drag": 0.95,
      "alphaCurve": [
        1,
        1,
        1,
        0
      ],
      "collision": {
        "mode": "bounce",
        "bounciness": 0.55,
        "friction": 0.4
      }
    }
  },
  "water_splash": {
    "emission": {
      "type": "burst",
      "count": [
        5,
        8
      ]
    },
    "spawn": {
      "shape": "sphere",
      "radius": 0.15,
      "velocity": {
        "min": [
          -1.5,
          1,
          -1.5
        ],
        "max": [
          1.5,
          2.5,
          1.5
        ]
      }
    },
    "lifetime": [
      0.3,
      0.5
    ],
    "scale": [
      0.1,
      0.2
    ],
    "render": {
      "tint": [
        200,
        225,
        245,
        220
      ]
    },
    "behaviors": {
      "gravity": [
        0,
        -10,
        0
      ],
      "drag": 0.75,
      "alphaCurve": [
        0.8,
        0.9,
        0.4,
        0
      ]
    }
  },
  "stream_fire": {
    "texture": "Assets/Effects/Smoke/Smoke_3",
    "emission": {
      "type": "continuous",
      "rate": 28,
      "duration": -1
    },
    "lifetime": [
      0.75,
      1
    ],
    "scale": [
      0.1,
      0.2
    ],
    "render": {
      "tint": [
        255,
        150,
        60,
        255
      ],
      "lighting": "emissive"
    },
    "behaviors": {
      "drag": 0.3,
      "collision": {
        "mode": "bounce",
        "bounciness": 0.0,
        "friction": 0.9
      },
      "alphaCurve": [
        1,
        0.75,
        0.25,
        0.05
      ],
      "scaleCurve": [
        0.5,
        0.75,
        1,
        1.5
      ],
      "colorCurve": {
        "start": [
          191,
          246,
          255,
          200
        ],
        "mid": [
          255,
          90,
          0,
          220
        ],
        "end": [
          255,
          232,
          8,
          150
        ]
      }
    }
  },
  "debris": {
    "emission": {
      "type": "burst",
      "count": [
        1,
        2
      ]
    },
    "spawn": {
      "shape": "sphere",
      "radius": 0.15,
      "velocity": {
        "min": [
          -0.4,
          -0.5,
          -0.4
        ],
        "max": [
          0.4,
          0,
          0.4
        ]
      }
    },
    "lifetime": [
      0.8,
      1.2
    ],
    "angularVelocity": [
      -4,
      4
    ],
    "scale": [
      0.08,
      0.15
    ],
    "render": {
      "tint": [
        120,
        110,
        100,
        255
      ]
    },
    "behaviors": {
      "gravity": [
        0,
        -15,
        0
      ],
      "drag": 0.98,
      "alphaCurve": [
        1,
        1,
        1,
        0
      ],
      "collision": {
        "mode": "bounce",
        "bounciness": 0.3,
        "friction": 0.6
      }
    }
  },
  "arrow_trail": {
    "emission": {
      "type": "burst",
      "count": [
        1,
        1
      ]
    },
    "lifetime": [
      1.5,
      1.5
    ],
    "spawn": {
      "velocity": {
        "min": [
          12,
          0,
          0
        ],
        "max": [
          12,
          0,
          0
        ]
      }
    },
    "scale": [
      0.2,
      0.2
    ],
    "render": {
      "tint": [
        255,
        255,
        255,
        255
      ],
      "alignToVelocity": true
    },
    "trail": {
      "effect": "trail_dot",
      "rate": 40
    }
  }
};
})(window.Aura ??= {});
