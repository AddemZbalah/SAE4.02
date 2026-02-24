// Animations centralisées (GSAP)
(function () {

  /** Place un élément A-Frame en coordonnées monde, en tenant compte du parent */
  function setWorldPos(el, worldPos) {
    var parent = el.object3D.parent;
    if (parent) {
      el.object3D.position.copy(parent.worldToLocal(worldPos.clone()));
    } else {
      el.object3D.position.copy(worldPos);
    }
  }

  /** Multiplie la vélocité d'un physics body par un facteur */
  function scaleVelocity(el, factor) {
    try {
      if (!el.body || !el.body.velocity) return;
      if (typeof el.body.velocity.set === 'function') {
        el.body.velocity.set(
          (el.body.velocity.x || 0) * factor,
          (el.body.velocity.y || 0) * factor,
          (el.body.velocity.z || 0) * factor
        );
      } else {
        el.body.velocity.x *= factor;
        el.body.velocity.y *= factor;
        el.body.velocity.z *= factor;
      }
    } catch (e) { /* ignore */ }
  }

  function nudgeVelocity(el, dir, strength) {
    try {
      if (!el.body || !el.body.velocity) return;
      var nx = (el.body.velocity.x || 0) + dir.x * strength;
      var ny = (el.body.velocity.y || 0) + dir.y * strength;
      var nz = (el.body.velocity.z || 0) + dir.z * strength;
      if (typeof el.body.velocity.set === 'function') {
        el.body.velocity.set(nx, ny, nz);
      } else {
        el.body.velocity.x = nx;
        el.body.velocity.y = ny;
        el.body.velocity.z = nz;
      }
    } catch (e) { /* ignore */ }
  }

  window.GameAnimations = {
    setWorldPosition: setWorldPos,
    scaleVelocity: scaleVelocity,
    nudgeVelocity: nudgeVelocity,

    waterRise: function (el, fromStr, toStr, durationMs, onComplete) {
      if (fromStr) {
        var f = fromStr.split(' ').map(Number);
        el.object3D.position.set(f[0], f[1], f[2]);
      }
      var t = toStr.split(' ').map(Number);
      return gsap.to(el.object3D.position, {
        x: t[0],
        y: t[1],
        z: t[2],
        duration: durationMs / 1000,
        ease: 'power2.inOut',
        onComplete: function () {
          try { el.emit('animationcomplete'); } catch (e) { /* ignore */ }
          if (onComplete) onComplete();
        }
      });
    },

    bubbleFloat: function (el, toY, durationMs) {
      gsap.to(el.object3D.position, {
        y: toY,
        duration: durationMs / 1000,
        ease: 'none'
      });

      var startFade = function () {
        var mesh = el.getObject3D('mesh');
        if (mesh && mesh.material) {
          mesh.material.transparent = true;
          gsap.to(mesh.material, {
            opacity: 0,
            duration: durationMs / 1000,
            ease: 'power2.out'
          });
        }
      };

      if (el.getObject3D('mesh')) {
        startFade();
      } else {
        el.addEventListener('loaded', startFade, { once: true });
      }
    },

    spearLaunch: function (el, startPos, targetPos, durationMs, onFrameCheck, onDone) {
      var proxy = { t: 0 };
      var killed = false;

      var tween = gsap.to(proxy, {
        t: 1,
        duration: Math.max(0.01, durationMs / 1000),
        ease: 'none',
        onUpdate: function () {
          if (killed) return;
          var pos = startPos.clone().lerp(targetPos, proxy.t);
          setWorldPos(el, pos);

          // Vérifier collision
          if (onFrameCheck && onFrameCheck(pos, proxy.t)) {
            killed = true;
            tween.kill();
            if (onDone) onDone(true); // true = interrompu par collision
          }
        },
        onComplete: function () {
          if (!killed && onDone) onDone(false); // false = fin naturelle
        }
      });

      return tween;
    },

    spearTether: function (el, origin, radius, force, durationMs) {
      var proxy = { t: 0 };

      return gsap.to(proxy, {
        t: 1,
        duration: Math.max(0.2, durationMs / 1000),
        ease: 'none',
        onUpdate: function () {
          if (!el) return;

          var curPos = new AFRAME.THREE.Vector3();
          el.object3D.getWorldPosition(curPos);
          var dist = curPos.distanceTo(origin);

          // Si le harpon est trop loin, le ramener
          if (dist > radius) {
            var dir = origin.clone().sub(curPos).normalize();
            try {
              if (el.body && typeof el.body.applyForce === 'function') {
                el.body.applyForce(dir.clone().multiplyScalar(force * 0.15), el.body.position);
              } else if (el.body && el.body.velocity) {
                nudgeVelocity(el, dir, 0.08);
              } else {
                setWorldPos(el, curPos.clone().add(dir.multiplyScalar(0.02)));
              }
            } catch (e) { /* ignore */ }
          }
        }
      });
    },

    spearWaterSway: function (el, forwardVec, options) {
      var THREE = AFRAME.THREE;
      var opts = options || {};
      var amplitude = opts.amplitude || 0.01;
      var freq = opts.freq || 2.5;
      var duration = opts.duration || 1600;

      // Axes perpendiculaires au vecteur de lancer
      var fwd = forwardVec.clone();
      if (fwd.length() === 0) fwd.set(0, 0, -1);
      var up = new THREE.Vector3(0, 1, 0);
      var right = new THREE.Vector3().crossVectors(fwd, up).normalize();
      if (right.length() < 0.001) right = new THREE.Vector3(1, 0, 0);
      var lateral = new THREE.Vector3().crossVectors(right, fwd).normalize();

      var proxy = { time: 0 };
      return gsap.to(proxy, {
        time: duration / 1000,
        duration: duration / 1000,
        ease: 'none',
        onUpdate: function () {
          if (!el) return;

          var phase = proxy.time * Math.PI * 2 * freq;
          var sway = right.clone().multiplyScalar(Math.sin(phase) * amplitude)
            .add(lateral.clone().multiplyScalar(Math.cos(phase * 0.7) * amplitude * 0.6));

          try {
            if (el.body) {
              if (typeof el.body.applyForce === 'function') {
                el.body.applyForce(sway.clone().multiplyScalar(2.5), el.body.position);
              }
              scaleVelocity(el, 0.98);
            } else {
              var worldPos = new THREE.Vector3();
              el.object3D.getWorldPosition(worldPos);
              setWorldPos(el, worldPos.clone().add(sway));
            }
          } catch (e) { /* ignore */ }
        }
      });
    },

    hoverIn: function (el, s) {
      s = s || 1.1;
      gsap.to(el.object3D.scale, {
        x: s, y: s, z: s,
        duration: 0.2,
        ease: 'power2.out'
      });
    },

    hoverOut: function (el) {
      gsap.to(el.object3D.scale, {
        x: 1, y: 1, z: 1,
        duration: 0.2,
        ease: 'power2.out'
      });
    },

    fadeIn: function (htmlEl, durationMs) {
      gsap.fromTo(htmlEl,
        { opacity: 0 },
        { opacity: 1, duration: (durationMs || 500) / 1000, ease: 'power1.in' }
      );
    },

    startPulse: function (htmlEl) {
      if (htmlEl._pulseTween) return;
      htmlEl._pulseTween = gsap.to(htmlEl, {
        scale: 1.08,
        duration: 0.3,
        yoyo: true,
        repeat: -1,
        ease: 'power1.inOut'
      });
    },

    stopPulse: function (htmlEl) {
      if (!htmlEl._pulseTween) return;
      htmlEl._pulseTween.kill();
      htmlEl._pulseTween = null;
      gsap.set(htmlEl, { clearProps: 'transform' });
    },

    setupButtonHovers: function () {
      var self = this;
      var ids = ['btn-restart-3d', 'btn-quit-3d'];
      ids.forEach(function (id) {
        var el = document.querySelector('#' + id);
        if (!el) return;
        el.addEventListener('mouseenter', function () { self.hoverIn(el); });
        el.addEventListener('mouseleave', function () { self.hoverOut(el); });
      });
      console.log('GSAP button hovers setup');
    },

    setupHTMLButtonHovers: function () {
      var buttons = document.querySelectorAll('.btn-end');
      buttons.forEach(function (btn) {
        btn.addEventListener('mouseenter', function () {
          gsap.to(btn, {
            scale: 1.05,
            duration: 0.3,
            ease: 'power2.out'
          });
          // Glow spécifique au bouton restart
          if (btn.classList.contains('btn-restart')) {
            gsap.to(btn, {
              boxShadow: '0 0 15px rgba(255, 215, 0, 0.7)',
              background: '#FFC700',
              duration: 0.3
            });
          } else if (btn.classList.contains('btn-quit')) {
            gsap.to(btn, {
              background: 'rgba(255, 215, 0, 0.2)',
              duration: 0.3
            });
          }
        });
        btn.addEventListener('mouseleave', function () {
          gsap.to(btn, {
            scale: 1,
            boxShadow: 'none',
            duration: 0.3,
            ease: 'power2.out'
          });
          if (btn.classList.contains('btn-restart')) {
            gsap.to(btn, { background: '#FFD700', duration: 0.3 });
          } else if (btn.classList.contains('btn-quit')) {
            gsap.to(btn, { background: 'transparent', duration: 0.3 });
          }
        });
      });
    },

    delayedShow: function (el, delayMs) {
      return gsap.delayedCall(delayMs / 1000, function () {
        if (el && el.setAttribute) el.setAttribute('visible', 'true');
      });
    },

    delayedRemove: function (el, delayMs) {
      return gsap.delayedCall(delayMs / 1000, function () {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
    },

    delay: function (callback, delayMs) {
      return gsap.delayedCall(delayMs / 1000, callback);
    }
  };

  // GSAP <-> A-Frame ticker sync (WebXR compatibility)
  if (typeof AFRAME !== 'undefined' && typeof gsap !== 'undefined') {
    gsap.ticker.sleep();

    AFRAME.registerSystem('gsap-ticker', {
      tick: function (time) { gsap.updateRoot(time / 1000); }
    });

    console.log('GSAP ticker synced with A-Frame render loop');
  }

  function setupWhenReady() {
    var scene = document.querySelector('a-scene');
    if (!scene) return;
    if (scene.hasLoaded) {
      window.GameAnimations.setupButtonHovers();
      window.GameAnimations.setupHTMLButtonHovers();
    } else {
      scene.addEventListener('loaded', function () {
        window.GameAnimations.setupButtonHovers();
        window.GameAnimations.setupHTMLButtonHovers();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupWhenReady);
  } else {
    setupWhenReady();
  }

  console.log('Animations GSAP loaded');
})();
