// Places coral models on yellow-marked visuals (tables) and on the floor inside the scanned room
AFRAME.registerComponent('coral-placer', {
  schema: {
    scaleMin: { type: 'number', default: 0.35 },
    scaleMax: { type: 'number', default: 0.65 }
  },

  init: function () {
    this.placed = [];
    var self = this;
    this._onScan = function (e) { self.placeCorals(e.detail); };
    this._onReset = function () { self.clearCorals(); };
    this._onZoneUpdated = function () { self._replaceCoralsAfterReset(); };
    this.el.sceneEl.addEventListener('room-scanned', this._onScan);
    this.el.sceneEl.addEventListener('room-reset', this._onReset);
    this.el.sceneEl.addEventListener('zone-updated', this._onZoneUpdated);

    // If already scanned
    if (window.FISH_ZONE && window.FISH_ZONE.scanned) {
      setTimeout(function () {
        var detail = {
          bounds: window.FISH_ZONE.roomBounds,
          floorY: window.FISH_ZONE.floorY,
          height: window.FISH_ZONE.ceilingY ? (window.FISH_ZONE.ceilingY - window.FISH_ZONE.floorY) : 2.5
        };
        self.placeCorals(detail);
      }, 200);
    }
    // Fallback: if no room-scanned within 7s, place corals using a sensible default for quick testing
    this._fallbackTimer = setTimeout(function () {
      if (self.placed.length === 0 && !(window.FISH_ZONE && window.FISH_ZONE.scanned)) {
        var testData = {
          bounds: { minX: -2, maxX: 2, minZ: -4, maxZ: 0 },
          floorY: 0,
          height: 2.4
        };
        console.warn('coral-placer: no scan — using fallback placement');
        self.placeCorals(testData);
      }
    }, 7000);
  },

  clearCorals: function () {
    this.placed.forEach(function (c) { if (c.parentNode) c.parentNode.removeChild(c); });
    this.placed = [];
  },

  placeCorals: function (roomData) {
    try {
      var scene = this.el.sceneEl;
      var rd = scene && scene.components && scene.components['room-detection'];

      // Place starfish on yellow-marked visuals (planeMeshes)
      if (rd && rd.planeMeshes && rd.planeMeshes.length > 0) {
        for (var i = 0; i < rd.planeMeshes.length; i++) {
          var mesh = rd.planeMeshes[i];
          if (!mesh || !mesh.material) continue;
          var mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          if (!mat || !mat.color) continue;
          var hex = (typeof mat.color.getHex === 'function') ? mat.color.getHex() : (mat.color & 0xffffff);

          if (hex === 0xffdd00 || hex === 0xffff00) {
            var pos = new AFRAME.THREE.Vector3();
            mesh.getWorldPosition(pos);
            pos.y += 0.04;
            var near = this.placed.some(function (c) {
              try { var p = c.object3D.getWorldPosition(new AFRAME.THREE.Vector3()); return p.distanceTo(pos) < 0.18; }
              catch (e) { return false; }
            });
            if (!near) this._spawnCoralAt(pos, '#starfish');
          }
        }
      }
    } catch (e) {
      console.warn('coral-placer: placement failed', e);
    }
  },

  _spawnCoralAt: function (posVec3, modelId) {
    var ent = document.createElement('a-entity');
    var model = modelId || '#starfish';
    ent.setAttribute('gltf-model', model);

    var base = this.data.scaleMin + Math.random() * (this.data.scaleMax - this.data.scaleMin);
    var s = base;
    if (model === '#starfish') {
      s = Math.max(0.005, base * 0.0467);
    }
    ent.setAttribute('scale', s + ' ' + s + ' ' + s);
    // Clamp X/Z inside room bounds
    try {
      var rb = (window.FISH_ZONE && window.FISH_ZONE.roomBounds) ? window.FISH_ZONE.roomBounds : null;
      if (rb) {
        var sizeMargin = Math.max(0.05, s * 0.4);
        var minX = rb.minX + sizeMargin;
        var maxX = rb.maxX - sizeMargin;
        var minZ = rb.minZ + sizeMargin;
        var maxZ = rb.maxZ - sizeMargin;
        if (isFinite(minX) && isFinite(maxX) && minX < maxX) posVec3.x = Math.min(Math.max(posVec3.x, minX), maxX);
        if (isFinite(minZ) && isFinite(maxZ) && minZ < maxZ) posVec3.z = Math.min(Math.max(posVec3.z, minZ), maxZ);
        if (rb.minY != null && rb.maxY != null) {
          posVec3.y = Math.max(posVec3.y, rb.minY + 0.02);
        }
      }
    } catch (e) { /* ignore clamping errors */ }

    ent.setAttribute('position', posVec3.x.toFixed(3) + ' ' + posVec3.y.toFixed(3) + ' ' + posVec3.z.toFixed(3));
    var ry = Math.random() * 360;
    ent.setAttribute('rotation', '0 ' + ry.toFixed(1) + ' 0');
    ent.classList.add('coral');

    var parent = document.querySelector('#world-anchor') || this.el.sceneEl;
    parent.appendChild(ent);
    this.placed.push(ent);
  },

  remove: function () {
    this.clearCorals();
    this.el.sceneEl.removeEventListener('room-scanned', this._onScan);
    this.el.sceneEl.removeEventListener('room-reset', this._onReset);
    this.el.sceneEl.removeEventListener('zone-updated', this._onZoneUpdated);
    clearTimeout(this._fallbackTimer);
  },

  /**
   * Après un reset du reference space, replace les étoiles de mer sur les nouveaux meshes.
   */
  _replaceCoralsAfterReset: function () {
    if (this.placed.length === 0) return;
    this.clearCorals();
    var detail = {
      bounds: window.FISH_ZONE ? window.FISH_ZONE.roomBounds : null,
      floorY: window.FISH_ZONE ? window.FISH_ZONE.floorY : 0,
      height: window.FISH_ZONE ? (window.FISH_ZONE.ceilingY - window.FISH_ZONE.floorY) : 2.5
    };
    this.placeCorals(detail);
  }
});
