// Adapte la taille et position de l'eau selon les dimensions de la pièce
AFRAME.registerComponent('water-adapter', {
  schema: {
    margin: { type: 'number', default: 0.5 }
  },

  init: function () {
    this.roomData = null;
    this.waterLayers = [];
    this.el.sceneEl.addEventListener('room-scanned', this._onRoomScanned.bind(this));
  },

  _onRoomScanned: function (event) {
    var data = event.detail;
    if (!data || !data.bounds) return;
    this.roomData = data;

    // Prepare water but do NOT start rise — triggered by startRise()
    this._updateWaterGeometry();
    this._updateWaterPosition();
    this._applyRotation();
    this._prepareAnimationParams();
  },

  _updateWaterGeometry: function () {
    if (!this.roomData) return;

    var margin = this.data.margin;
    var trim = 0.02;
    var width = Math.max(0.1, this.roomData.width + (margin * 2) - (trim * 2));
    var depth = Math.max(0.1, this.roomData.depth + (margin * 2) - (trim * 2));

    var waterEntities = this.el.querySelectorAll('[water-shader]');
    waterEntities.forEach(function (entity) {
      entity.setAttribute('water-shader', { width: width, depth: depth });
      try { entity.setAttribute('visible', 'false'); } catch (e) { }
    });
  },

  _updateWaterPosition: function () {
    if (!this.roomData) return;
    var pos = this.roomData.centerX + ' ' + this.roomData.floorY + ' ' + this.roomData.centerZ;
    this.el.setAttribute('position', pos);
  },

  _prepareAnimationParams: function () {
    if (!this.roomData) return;
    var cx = this.roomData.centerX;
    var cz = this.roomData.centerZ;
    var fy = this.roomData.floorY;
    var h = this.roomData.height || 2.5;
    // Stocker from/to comme chaînes "x y z" pour GSAP
    this._riseParams = {
      from: cx + ' ' + fy + ' ' + cz,
      to: cx + ' ' + (fy + h) + ' ' + cz,
      dur: 10000
    };
  },

  startRise: function () {
    if (this._riseStarted) return;
    this._riseStarted = true;

    var waterEntities = this.el.querySelectorAll('[water-shader]');
    waterEntities.forEach(function (entity) { try { entity.setAttribute('visible', 'true'); } catch (e) { } });

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
