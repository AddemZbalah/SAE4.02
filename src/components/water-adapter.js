// Adapte la taille et position de l'eau selon les dimensions de la pièce
AFRAME.registerComponent('water-adapter', {
  schema: {
    margin: { type: 'number', default: 0.5 }
  },

  init: function () {
    this.roomData = null;
    this._geometryApplied = false;
    var self = this;
    this.el.sceneEl.addEventListener('room-scanned', function (event) { self._onRoomScanned(event); });
    this.el.sceneEl.addEventListener('zone-updated', function (event) { self._onZoneUpdated(event); });
  },

  _onRoomScanned: function (event) {
    var data = event.detail;
    if (!data) return;
    this.roomData = data;
    this._applyRoomDimensions();
  },

  _onZoneUpdated: function (event) {
    var data = event.detail;
    if (!data) return;
    // Mettre à jour la position si les bounds changent (ex: headset reset)
    if (data.bounds) {
      if (!this.roomData) this.roomData = {};
      this.roomData.bounds = data.bounds;
      this.roomData.orientedBox = data.orientedBox || this.roomData.orientedBox;
      this.roomData.floorY = data.floorY != null ? data.floorY : this.roomData.floorY;
      this.roomData.height = data.height || this.roomData.height;
      this._applyRoomDimensions();
    }
  },

  /**
   * Tente de récupérer les dimensions de la pièce depuis FISH_ZONE
   * si room-scanned n'a pas fourni les bonnes données.
   */
  _ensureRoomData: function () {
    if (this._geometryApplied) return;

    var fz = window.FISH_ZONE;
    if (!fz || !fz.scanned || !fz.roomBounds) return;

    var b = fz.roomBounds;
    var ob = fz.orientedBox;

    // Construire roomData depuis FISH_ZONE
    this.roomData = {
      bounds: b,
      width: (ob && ob.width) ? ob.width : (b.maxX - b.minX),
      depth: (ob && ob.depth) ? ob.depth : (b.maxZ - b.minZ),
      height: (fz.ceilingY - fz.floorY) || 2.5,
      centerX: (ob && ob.centerX !== undefined) ? ob.centerX : ((b.minX + b.maxX) / 2),
      centerZ: (ob && ob.centerZ !== undefined) ? ob.centerZ : ((b.minZ + b.maxZ) / 2),
      floorY: fz.floorY || 0,
      orientedBox: ob || null
    };

    console.log('[water-adapter] Fallback: dimensions from FISH_ZONE w=' +
      this.roomData.width.toFixed(2) + ' d=' + this.roomData.depth.toFixed(2));
    this._applyRoomDimensions();
  },

  _applyRoomDimensions: function () {
    if (!this.roomData) return;
    this._updateWaterGeometry();
    this._updateWaterPosition();
    this._applyRotation();
    this._prepareAnimationParams();
  },

  _updateWaterGeometry: function () {
    if (!this.roomData) return;

    var margin = this.data.margin;
    var trim = 0.02;

    // Utiliser les dimensions de la box orientée si disponible
    var ob = this.roomData.orientedBox;
    var w = (ob && ob.width) ? ob.width : this.roomData.width;
    var d = (ob && ob.depth) ? ob.depth : this.roomData.depth;

    if (!w || !d || !isFinite(w) || !isFinite(d)) {
      console.warn('[water-adapter] Invalid dimensions: w=' + w + ' d=' + d);
      return;
    }

    var width = Math.max(0.1, w + (margin * 2) - (trim * 2));
    var depth = Math.max(0.1, d + (margin * 2) - (trim * 2));

    console.log('[water-adapter] Applying geometry: ' + width.toFixed(2) + 'x' + depth.toFixed(2));

    var waterEntities = this.el.querySelectorAll('[water-shader]');
    for (var i = 0; i < waterEntities.length; i++) {
      var entity = waterEntities[i];
      entity.setAttribute('water-shader', 'width', width);
      entity.setAttribute('water-shader', 'depth', depth);
      try { entity.setAttribute('visible', 'false'); } catch (e) { }
    }

    this._geometryApplied = true;
  },

  _updateWaterPosition: function () {
    if (!this.roomData) return;
    var ob = this.roomData.orientedBox;
    var cx = (ob && ob.centerX !== undefined) ? ob.centerX : this.roomData.centerX;
    var cz = (ob && ob.centerZ !== undefined) ? ob.centerZ : this.roomData.centerZ;
    if (!isFinite(cx) || !isFinite(cz)) return;
    var pos = cx + ' ' + (this.roomData.floorY || 0) + ' ' + cz;
    this.el.setAttribute('position', pos);
  },

  _prepareAnimationParams: function () {
    if (!this.roomData) return;
    var ob = this.roomData.orientedBox;
    var cx = (ob && ob.centerX !== undefined) ? ob.centerX : this.roomData.centerX;
    var cz = (ob && ob.centerZ !== undefined) ? ob.centerZ : this.roomData.centerZ;
    var fy = this.roomData.floorY || 0;
    var h = this.roomData.height || 2.5;
    this._riseParams = {
      from: cx + ' ' + fy + ' ' + cz,
      to: cx + ' ' + (fy + h) + ' ' + cz,
      dur: 10000
    };
  },

  startRise: function () {
    if (this._riseStarted) return;
    this._riseStarted = true;

    // Fallback : si room-scanned n'a pas été reçu, essayer FISH_ZONE
    if (!this._geometryApplied) {
      this._ensureRoomData();
    }

    var waterEntities = this.el.querySelectorAll('[water-shader]');
    for (var i = 0; i < waterEntities.length; i++) {
      try { waterEntities[i].setAttribute('visible', 'true'); } catch (e) { }
    }

    var to = this._riseParams ? this._riseParams.to : '0 2.5 -2';
    var dur = this._riseParams ? this._riseParams.dur : 10000;
    var from = this._riseParams ? this._riseParams.from : null;

    if (window.GameAnimations) {
      GameAnimations.waterRise(this.el, from, to, dur);
    }
    try { this.el.emit('water-rise-started'); } catch (e) { }
  },

  _applyRotation: function () {
    if (!this.roomData || !this.roomData.orientedBox) return;
    var rotationY = this.roomData.orientedBox.rotationY;
    if (rotationY && Math.abs(rotationY) > 0.01) {
      var degrees = rotationY * (180 / Math.PI);
      this.el.setAttribute('rotation', '0 ' + degrees + ' 0');
    }
  }
});
