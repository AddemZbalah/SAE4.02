AFRAME.registerComponent('grab-manager', {
  schema: {
    throwPower: { type: 'number', default: 0.6 },
    launchDistance: { type: 'number', default: 0.12 },
    launchDuration: { type: 'number', default: 350 },
    physicsLaunch: { type: 'boolean', default: true },
    maxLaunchSpeed: { type: 'number', default: 0.6 },
    autoStopMs: { type: 'number', default: 280 },
    tetherRadius: { type: 'number', default: 0.6 },
    tetherForce: { type: 'number', default: 0.6 },
    tetherDuration: { type: 'number', default: 1400 },
    hitRadius: { type: 'number', default: 0.28 }
  },

  init: function () {
    this.grabRadius = 0.4;
    this.grabbedSpear = null;
    this.grabbingHand = null;
    this.offset = new AFRAME.THREE.Vector3(0, 0, -0.2);
    this.collisionRadius = this.data.hitRadius || 0.18;

    // Vecteurs pré-alloués (évite le garbage collector dans tick)
    var THREE = AFRAME.THREE;
    this._v = {
      handPos: new THREE.Vector3(),
      handQuat: new THREE.Quaternion(),
      handUp: new THREE.Vector3(),
      offsetWorld: new THREE.Vector3(),
      targetPos: new THREE.Vector3(),
      baseRotation: new THREE.Quaternion(),
      spearPos: new THREE.Vector3(),
      spearQuat: new THREE.Quaternion(),
      tipOffset: new THREE.Vector3(),
      tipPos: new THREE.Vector3(),
      fishPos: new THREE.Vector3()
    };
    this._yFlipQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    this._xFlipQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

    var self = this;
    var scene = this.el.sceneEl;
    scene.addEventListener('loaded', function () {
      var hands = scene.querySelectorAll('a-entity[hand-controls], a-entity[oculus-touch-controls]');
      hands.forEach(function (hand) {
        hand.addEventListener('triggerdown', function () { self.tryGrab(hand); });
        hand.addEventListener('triggerup', function () { self.tryRelease(hand); });
      });
    });
  },

  tryGrab: function (hand) {
    if (this.grabbedSpear) return;

    var THREE = AFRAME.THREE;
    var handPos = new THREE.Vector3();
    hand.object3D.getWorldPosition(handPos);

    var scene = this.el.sceneEl;
    var weapons = Array.from(scene.querySelectorAll('[weapon], .weapon, #spear'));
    var fishes = Array.from(scene.querySelectorAll('.fish, .fish-target'));
    var candidates = weapons.length ? weapons : fishes;

    var nearest = null;
    var minDist = Infinity;
    candidates.forEach(function (obj) {
      if (!obj.object3D) return;
      var objPos = new THREE.Vector3();
      obj.object3D.getWorldPosition(objPos);
      var dist = handPos.distanceTo(objPos);
      if (dist < minDist) { minDist = dist; nearest = obj; }
    });

    if (nearest && minDist < this.grabRadius) {
      this.grabbedSpear = nearest;
      this.grabbingHand = hand;
      if (this.grabbedSpear.removeAttribute) this.grabbedSpear.removeAttribute('dynamic-body');
      if (this.grabbedSpear.setAttribute) this.grabbedSpear.setAttribute('kinematic-body', '');
      this.lastHandPos = null;
      this.lastHandTime = null;
      this.lastHandVel = new THREE.Vector3(0, 0, 0);
    }
  },

  tryRelease: function (hand) {
    if (this.grabbingHand !== hand || !this.grabbedSpear) return;

    var el = this.grabbedSpear;
    if (el.removeAttribute) el.removeAttribute('kinematic-body');

    var savedHandVel = this.lastHandVel ? this.lastHandVel.clone() : new AFRAME.THREE.Vector3();

    // Réinitialiser l'état
    this.grabbedSpear = null;
    this.grabbingHand = null;
    this.lastHandPos = null;
    this.lastHandTime = null;

    if (this.data.physicsLaunch) {
      this._doPhysicsLaunch(el, savedHandVel);
    } else {
      this._doScriptedLaunch(el);
    }
  },

  _doPhysicsLaunch: function (el, handVelocity) {
    var self = this;
    if (el.setAttribute) el.setAttribute('dynamic-body', 'mass:1; shape: box');

    var launchOrigin = new AFRAME.THREE.Vector3();
    el.object3D.getWorldPosition(launchOrigin);

    // Petit délai GSAP pour laisser le physics body se créer
    gsap.delayedCall(0.05, function () {
      var forward = self._getForwardDirection(el);
      var speedVec = new AFRAME.THREE.Vector3();
      if (handVelocity && handVelocity.length() > 0.02) {
        speedVec.copy(handVelocity).multiplyScalar(0.6 * self.data.throwPower);
      } else {
        speedVec.copy(forward).multiplyScalar(1.2 * self.data.throwPower);
      }
      self._clampSpeed(speedVec, self.data.maxLaunchSpeed);
      self._applyVelocity(el, speedVec);

      // Animations GSAP
      GameAnimations.spearTether(el, launchOrigin, self.data.tetherRadius, self.data.tetherForce, self.data.tetherDuration);
      self._scheduleSlowdown(el, self.data.autoStopMs);
      self._attachCollisionListener(el);
      GameAnimations.spearWaterSway(el, forward, { amplitude: 0.01, freq: 2.5, duration: 1600 });
    });
  },

  _doScriptedLaunch: function (el) {
    var self = this;
    var THREE = AFRAME.THREE;
    var startPos = new THREE.Vector3();
    el.object3D.getWorldPosition(startPos);

    var forward = this._getForwardDirection(el);
    var targetPos = startPos.clone().add(forward.clone().multiplyScalar(this.data.launchDistance));
    var duration = Math.max(10, this.data.launchDuration);
    GameAnimations.spearLaunch(el, startPos, targetPos, duration,
      function () { return self._checkSpearTipCollision(el); },
      function () {
        if (el.setAttribute) el.setAttribute('dynamic-body', 'mass:1');
        self._scheduleSlowdown(el, self.data.autoStopMs);
      }
    );

    // Tether + sway
    gsap.delayedCall(0.03, function () {
      var fwd = self._getForwardDirection(el);
      GameAnimations.spearWaterSway(el, fwd, { amplitude: 0.01, freq: 2.5, duration: 1600 });

      var origin = new THREE.Vector3();
      el.object3D.getWorldPosition(origin);
      GameAnimations.spearTether(el, origin, self.data.tetherRadius, self.data.tetherForce, self.data.tetherDuration);
    });
  },

  _getForwardDirection: function (el) {
    var forwardLocal = new AFRAME.THREE.Vector3(0, 0, -1);
    var worldQuat = new AFRAME.THREE.Quaternion();
    el.object3D.getWorldQuaternion(worldQuat);
    return forwardLocal.applyQuaternion(worldQuat).normalize();
  },

  _clampSpeed: function (vec, maxSpeed) {
    var max = Math.max(0.1, maxSpeed);
    if (vec.length() > max) {
      vec.multiplyScalar(max / vec.length());
    }
  },

  _applyVelocity: function (el, speedVec) {
    try {
      if (el.body && el.body.velocity && typeof el.body.velocity.set === 'function') {
        el.body.velocity.set(speedVec.x, speedVec.y, speedVec.z);
      } else if (el.body && typeof el.body.applyImpulse === 'function') {
        var mass = el.body.mass || 1;
        var impulse = speedVec.clone().multiplyScalar(mass * 0.02);
        el.body.applyImpulse(
          new AFRAME.THREE.Vector3(impulse.x, impulse.y, impulse.z),
          el.body.position
        );
      }
    } catch (e) { /* ignore */ }
  },

  _scheduleSlowdown: function (el, delayMs) {
    gsap.delayedCall(Math.max(50, delayMs) / 1000, function () {
      try {
        if (!el.body) return;
        GameAnimations.scaleVelocity(el, 0.45);
        if (el.body.angularVelocity && typeof el.body.angularVelocity.set === 'function') {
          el.body.angularVelocity.set(0, 0, 0);
        }
        el.body.linearDamping = 0.35;
        el.body.angularDamping = 0.35;
      } catch (e) { /* ignore */ }
    });
  },

  _attachCollisionListener: function (el) {
    var self = this;
    var onCollide = function (evt) {
      try {
        var other = (evt.detail && evt.detail.body && evt.detail.body.el) ||
          (evt.detail && evt.detail.target) ||
          (evt.detail && evt.detail.el);
        var otherEl = (other && other.el) ? other.el : other;
        if (otherEl && otherEl.classList && otherEl.classList.contains('fish-target')) {
          self.processCaughtFish(otherEl, el);
          el.removeEventListener('collide', onCollide);
        }
      } catch (e) { console.warn('collide handler error', e); }
    };
    if (el.addEventListener) el.addEventListener('collide', onCollide);
  },

  tick: function () {
    if (!this.grabbedSpear || !this.grabbingHand) return;

    var v = this._v;
    this.grabbingHand.object3D.getWorldPosition(v.handPos);
    this.grabbingHand.object3D.getWorldQuaternion(v.handQuat);

    // Calculer la vélocité de la main
    var now = performance.now();
    if (this.lastHandPos && this.lastHandTime) {
      var dt = (now - this.lastHandTime) / 1000;
      if (dt > 0) {
        this.lastHandVel.copy(v.handPos).sub(this.lastHandPos).divideScalar(dt);
      }
    }
    if (!this.lastHandPos) this.lastHandPos = new AFRAME.THREE.Vector3();
    this.lastHandPos.copy(v.handPos);
    this.lastHandTime = now;

    // Vérifier si la main est retournée
    v.handUp.set(0, 1, 0).applyQuaternion(v.handQuat);
    var isFlipped = v.handUp.y < 0;

    // Position et rotation cibles
    if (isFlipped) {
      v.offsetWorld.set(0, 0, 0.2).applyQuaternion(v.handQuat);
    } else {
      v.offsetWorld.copy(this.offset).applyQuaternion(v.handQuat);
    }
    v.targetPos.copy(v.handPos).add(v.offsetWorld);

    v.baseRotation.copy(v.handQuat).multiply(this._yFlipQuat);
    if (isFlipped) v.baseRotation.multiply(this._xFlipQuat);

    // Appliquer la position et rotation
    var spear = this.grabbedSpear;
    try {
      if (spear.body) {
        if (spear.body.position && typeof spear.body.position.set === 'function') {
          spear.body.position.set(v.targetPos.x, v.targetPos.y, v.targetPos.z);
        }
        if (spear.body.quaternion && typeof spear.body.quaternion.set === 'function') {
          spear.body.quaternion.set(v.baseRotation.x, v.baseRotation.y, v.baseRotation.z, v.baseRotation.w);
        }
      } else {
        spear.object3D.position.copy(v.targetPos);
        spear.object3D.quaternion.copy(v.baseRotation);
      }
    } catch (e) {
      try { spear.object3D.position.copy(v.targetPos); spear.object3D.quaternion.copy(v.baseRotation); } catch (err) { /* ignore */ }
    }

    // Vérifier collision pendant le grab
    this._checkSpearTipCollision(spear);
  },

  _checkSpearTipCollision: function (spear) {
    if (!spear || !spear.object3D) return false;

    var v = this._v;
    spear.object3D.getWorldPosition(v.spearPos);
    spear.object3D.getWorldQuaternion(v.spearQuat);
    v.tipOffset.set(0, 0, 0.2).applyQuaternion(v.spearQuat);
    v.tipPos.copy(v.spearPos).add(v.tipOffset);

    var fishTargets = this.el.sceneEl.querySelectorAll('.fish-target');
    for (var i = 0; i < fishTargets.length; i++) {
      var fish = fishTargets[i];
      if (!fish.object3D) continue;
      fish.object3D.getWorldPosition(v.fishPos);
      if (v.tipPos.distanceTo(v.fishPos) < this.collisionRadius) {
        this.processCaughtFish(fish, spear);
        return true;
      }
    }
    return false;
  },

  processCaughtFish: function (fishEl, spearEl) {
    if (!fishEl || fishEl._caught) return;
    fishEl._caught = true;

    try {
      var caughtType = fishEl.getAttribute('data-fish-type') || fishEl.getAttribute('data-fish') || 'unknown';

      var bonusType = null;
      var bonusEntity = document.querySelector('#fish-3d');
      if (bonusEntity) {
        var rotator = bonusEntity.components && bonusEntity.components['fish-rotator'];
        if (rotator && rotator.getCurrentFish) {
          bonusType = rotator.getCurrentFish();
        } else {
          var m = bonusEntity.getAttribute('gltf-model');
          if (typeof m === 'string') bonusType = m.replace('#', '');
        }
      }

      // Calculer les points
      var config = window.GAME_CONFIG || {};
      var isCorrect = (caughtType && bonusType && caughtType === bonusType);
      var points = isCorrect ? (config.POINTS_CORRECT_FISH || 10) : (config.POINTS_WRONG_FISH || -5);

      // Enregistrer dans le timer
      if (window.gameTimer && window.gameTimer.isGameActive && window.gameTimer.isGameActive()) {
        window.gameTimer.addCaughtFish(caughtType, isCorrect, points);
      }

      // Si correct, passer au prochain poisson bonus
      if (isCorrect && bonusEntity) {
        try {
          var rot = bonusEntity.components && bonusEntity.components['fish-rotator'];
          if (rot && rot.nextFish) rot.nextFish();
        } catch (e) { /* ignore */ }
      }

      // Retirer le poisson
      fishEl.setAttribute('visible', 'false');
      GameAnimations.delayedRemove(fishEl, 80);

      // Ralentir le harpon
      if (spearEl) GameAnimations.scaleVelocity(spearEl, 0.25);

    } catch (e) { console.warn('processCaughtFish error', e); }
  }
});
