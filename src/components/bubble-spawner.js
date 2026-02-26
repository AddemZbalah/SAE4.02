// Spawns occasional bubbles under the water within the scanned room bounds
AFRAME.registerComponent('bubble-spawner', {
  schema: {
    interval: { type: 'int', default: 700 }, // ms between spawn checks
    burstChance: { type: 'number', default: 0.20 },
    burstCount: { type: 'int', default: 3 },
    maxBubbles: { type: 'int', default: 80 },
    lifetime: { type: 'int', default: 3200 },
    minRadius: { type: 'number', default: 0.008 },
    maxRadius: { type: 'number', default: 0.028 },
    padding: { type: 'number', default: 0.25 }, // meters to shrink spawn area inside detected room
    requireScan: { type: 'boolean', default: true } // only spawn after room-scanned
  },

  init: function () {
    this.bubbles = [];
    this.bounds = null; // {minX,maxX,minZ,maxZ,floorY,height}
    this._running = true;

    var self = this;
    this._onRoom = function (e) { self._setBoundsFromRoom(e.detail); };
    this.el.sceneEl.addEventListener('room-scanned', this._onRoom);

    // If room already scanned globally
    if (window.FISH_ZONE && window.FISH_ZONE.scanned) {
      var rb = window.FISH_ZONE.roomBounds;
      if (rb) {
        this.bounds = {
          minX: rb.minX,
          maxX: rb.maxX,
          minZ: rb.minZ,
          maxZ: rb.maxZ,
          floorY: window.FISH_ZONE.floorY || 0,
          height: (window.FISH_ZONE.ceilingY || (window.FISH_ZONE.floorY + 2.5)) - (window.FISH_ZONE.floorY || 0)
        };
      }
    }

    this._tickHandle = setInterval(function () { self._maybeSpawn(); }, this.data.interval);
  },

  _setBoundsFromRoom: function (roomData) {
    if (roomData.bounds) {
      this.bounds = Object.assign({}, roomData.bounds);
      this.bounds.floorY = roomData.floorY || this.bounds.minY || 0;
      this.bounds.height = roomData.height || (this.bounds.maxY - this.bounds.minY) || 2.5;
    } else {
      var centerX = roomData.centerX || 0;
      var centerZ = roomData.centerZ || -2;
      var width = roomData.width || 4;
      var depth = roomData.depth || 4;
      var floorY = roomData.floorY || 0;
      var height = roomData.height || 2.5;
      this.bounds = {
        minX: centerX - width / 2,
        maxX: centerX + width / 2,
        minZ: centerZ - depth / 2,
        maxZ: centerZ + depth / 2,
        floorY: floorY,
        height: height
      };
    }
  },

  _maybeSpawn: function () {
    if (!this._running) return;
    if (this.data.requireScan && !(window.FISH_ZONE && window.FISH_ZONE.scanned)) return;
    if (!this.bounds) return;
    if (this.bubbles.length >= this.data.maxBubbles) return;

    var roll = Math.random();
    var doBurst = roll < this.data.burstChance;
    var count = doBurst ? Math.min(this.data.burstCount, this.data.maxBubbles - this.bubbles.length) : 1;

    for (var i = 0; i < count; i++) {
      this._spawnBubble();
    }
  },

  _spawnBubble: function () {
    if (!this.bounds) return;
    var THREE = AFRAME.THREE;
    var pad = Math.abs(this.data.padding || 0.25);
    var minX = this.bounds.minX + pad;
    var maxX = this.bounds.maxX - pad;
    var minZ = this.bounds.minZ + pad;
    var maxZ = this.bounds.maxZ - pad;
    var floorY = (this.bounds.floorY != null) ? this.bounds.floorY : 0;
    var maxY = floorY + Math.min(1.6, (this.bounds.height || 2.5) * 0.7);

    var xMin = minX, xMax = maxX, zMin = minZ, zMax = maxZ;
    if (xMax <= xMin) {
      var cx = (this.bounds.minX + this.bounds.maxX) / 2;
      xMin = cx - 0.25; xMax = cx + 0.25;
    }
    if (zMax <= zMin) {
      var cz = (this.bounds.minZ + this.bounds.maxZ) / 2;
      zMin = cz - 0.25; zMax = cz + 0.25;
    }

    var x = xMin + Math.random() * (xMax - xMin);
    var z = zMin + Math.random() * (zMax - zMin);
    var y = floorY + 0.05 + Math.random() * Math.max(0.05, (maxY - floorY - 0.05));
    var r = this.data.minRadius + Math.random() * (this.data.maxRadius - this.data.minRadius);

    var bubble = document.createElement('a-sphere');
    bubble.classList.add('bubble');
    bubble.setAttribute('radius', r);
    bubble.setAttribute('segments', '8');
    bubble.setAttribute('material', `color: #dff9ff; opacity: 0.85; transparent: true; metalness: 0.0; roughness: 0.9`);
    bubble.setAttribute('position', `${x} ${y} ${z}`);

    // Montée + fondu
    var rise = 0.6 + Math.random() * 0.6;
    var dur = Math.max(600, Math.min(this.data.lifetime, Math.floor(this.data.lifetime * (0.6 + Math.random() * 0.5))));

    bubble.object3D.position.set(x, y, z);

    var parent = document.querySelector('#world-anchor') || this.el.sceneEl;
    parent.appendChild(bubble);
    this.bubbles.push(bubble);

    // Animation GSAP
    if (window.GameAnimations) {
      GameAnimations.bubbleFloat(bubble, y + rise, dur);
    }

    // Cleanup
    var self = this;
    setTimeout(function () {
      var idx = self.bubbles.indexOf(bubble);
      if (idx !== -1) self.bubbles.splice(idx, 1);
      if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
    }, dur + 120);
  },

  remove: function () {
    this._running = false;
    clearInterval(this._tickHandle);
    this.el.sceneEl.removeEventListener('room-scanned', this._onRoom);
    this.bubbles.forEach(function (b) { if (b.parentNode) b.parentNode.removeChild(b); });
    this.bubbles = [];
  }
});
