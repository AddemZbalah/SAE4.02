// Shims de compatibilité pour THREE.js et CANNON.js

// SHIM 1: THREE.Geometry — recrée pour les anciens addons
(function () {
  try {
    if (window.AFRAME && AFRAME.THREE && !AFRAME.THREE.Geometry) {
      const THREE = AFRAME.THREE;
      // ES6 class extends BufferGeometry to avoid calling super as a function
      class Geometry extends THREE.BufferGeometry {
        constructor() {
          super();
          this.vertices = [];
        }

        static fromBufferGeometry(bufferGeometry) {
          const g = new Geometry();
          const pos = bufferGeometry.attributes && bufferGeometry.attributes.position;
          if (pos && pos.array) {
            const a = pos.array;
            for (let i = 0; i < a.length; i += 3) {
              g.vertices.push(new THREE.Vector3(a[i], a[i + 1], a[i + 2]));
            }
          }
          return g;
        }
        // instance method expected by older plugins: tmp.fromBufferGeometry(...)
        fromBufferGeometry(bufferGeometry) {
          this.vertices.length = 0;
          const pos = bufferGeometry.attributes && bufferGeometry.attributes.position;
          if (pos && pos.array) {
            const a = pos.array;
            for (let i = 0; i < a.length; i += 3) {
              this.vertices.push(new THREE.Vector3(a[i], a[i + 1], a[i + 2]));
            }
          }
          return this;
        }
      }
      THREE.Geometry = Geometry;
    }
  } catch (e) {
    console.warn('Geometry shim failed', e);
  }
})();

// SHIM 2: Box3.getCenter — crée un Vector3 si la cible est manquante
(function () {
  try {
    if (window.AFRAME && AFRAME.THREE && AFRAME.THREE.Box3) {
      const THREE = AFRAME.THREE;
      const proto = THREE.Box3.prototype;
      if (proto && typeof proto.getCenter === 'function') {
        var origGetCenter = proto.getCenter;
        proto.getCenter = function (target) {
          if (target === undefined || target === null) target = new THREE.Vector3();
          return origGetCenter.call(this, target);
        };
      }
    }
  } catch (e) {
    console.warn('Box3.getCenter shim failed', e);
  }
})();

// SHIM 3: Quaternion.inverse() pour THREE et CANNON
window.addEventListener('load', function () {
  setTimeout(function () {
    try {
      // THREE.Quaternion: alias inverse -> invert()
      if (window.AFRAME && AFRAME.THREE && AFRAME.THREE.Quaternion) {
        var Q = AFRAME.THREE.Quaternion.prototype;
        if (!Q.inverse) {
          Q.inverse = Q.invert || function () { return this.conjugate(); };
        }
      }

      // CANNON.Quaternion: provide inverse() returning a new quaternion
      if (window.CANNON && CANNON.Quaternion) {
        if (!CANNON.Quaternion.prototype.inverse) {
          CANNON.Quaternion.prototype.inverse = function () {
            return new CANNON.Quaternion(-this.x, -this.y, -this.z, this.w);
          };
        }
      }
    } catch (e) {
      console.warn('Quaternion shim failed', e);
    }
  }, 100);
});

// Nettoyage au chargement : supprimer les éléments résiduels d’une session précédente
window.addEventListener('load', function () {
  setTimeout(function () {
    try {
      document.querySelectorAll('#spawn-zone-bounds').forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
      document.querySelectorAll('.fish').forEach(function (f) { if (f.parentNode) f.parentNode.removeChild(f); });
      document.querySelectorAll('#bubbles, .bubble').forEach(function (b) { if (b.parentNode) b.parentNode.removeChild(b); });

      // Réinitialiser FISH_ZONE
      if (window && window.FISH_ZONE) {
        window.FISH_ZONE.roomBounds = null;
        window.FISH_ZONE.orientedBox = null;
        window.FISH_ZONE.floorY = 0;
        window.FISH_ZONE.ceilingY = 2.5;
        window.FISH_ZONE.scanned = false;
        window.FISH_ZONE.obstacles = [];
        window.FISH_ZONE.wallPlanes = [];
      }
    } catch (e) {
      console.warn('Cleanup failed', e);
    }
  }, 200);
});
