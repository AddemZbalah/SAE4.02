// Zone de jeu partagée entre spawner et fish-movement
window.FISH_ZONE = {
  roomBounds: null,
  orientedBox: null,
  floorY: 0,
  ceilingY: 2.5,
  scanned: false,
  obstacles: [],
  wallPlanes: [],
  openings: []
};

function isPointInsideObstacle(point, obstacles, floorY, fishRadius) {
  if (!obstacles || obstacles.length === 0) return false;
  var radius = fishRadius || 0.03;

  for (var i = 0; i < obstacles.length; i++) {
    var obsData = obstacles[i].data;
    var bounds = obsData.bounds;
    if (!bounds) continue;

    var effectiveMinY = bounds.minY;
    var effectiveMaxY = bounds.maxY;
    var obsType = obsData.obstacleType || '';
    if (obsType === 'table' || obsType === 'meuble_bas' || obsType === 'etagere' || obsType === 'obstacle') {
      effectiveMinY = floorY;
      effectiveMaxY = bounds.maxY + 0.05;
    }

    var inX = point.x > bounds.minX - radius && point.x < bounds.maxX + radius;
    var inY = point.y > effectiveMinY - radius && point.y < effectiveMaxY + radius;
    var inZ = point.z > bounds.minZ - radius && point.z < bounds.maxZ + radius;
    if (inX && inY && inZ) return true;
  }
  return false;
}


AFRAME.registerComponent('fish-movement', {
  schema: {
    speed: { type: 'number', default: 0.05 },
    bounds: { type: 'number', default: 2 },
    entryMode: { type: 'boolean', default: false },
    entryDuration: { type: 'number', default: 4000 },
    initialVelocity: { type: 'vec3', default: { x: 0, y: 0, z: 0 } }
  },

  init: function () {
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.speed = this.data.speed * (0.001 + Math.random() * 0.0006);
    this.bounds = this.data.bounds;
    this.target = new THREE.Vector3();
    this._pickNewTarget();
    this.swayPhase = Math.random() * Math.PI * 2;
    this.bobAmplitude = 0.003 + Math.random() * 0.006;
    this.bobOffset = Math.random() * Math.PI * 2;
    this._collisionCooldown = 0;

    this._entryMode = this.data.entryMode;
    this._entryStartTime = this._entryMode ? Date.now() : null;
    this._entryDuration = this.data.entryDuration;
    if (this._entryMode && this.data.initialVelocity) {
      this.velocity.set(this.data.initialVelocity.x, this.data.initialVelocity.y, this.data.initialVelocity.z);
    }

    this.roomBounds = null;
    this.orientedBox = null;
    this.obstacles = [];
    this.wallPlanes = [];
    this.floorY = 0;
    this.ceilingY = 2.5;

    this._collisionConfig = {
      coneAngle: 175,
      dampingFactor: 0.9,
      minReflectionSpeed: 0.000005
    };

    var self = this;
    this.el.sceneEl.addEventListener('room-scanned', function (e) { self._updateZoneFromEvent(e.detail); });
    this.el.sceneEl.addEventListener('room-reset', function () {
      self.spawned = false;
      if (self.fishes && self.fishes.length > 0) {
        self.fishes.forEach(function (f) { if (f.parentNode) f.parentNode.removeChild(f); });
        self.fishes = [];
      }
    });
    this.el.sceneEl.addEventListener('zone-updated', function () { self._updateZoneFromGlobal(); });

    if (window.FISH_ZONE.scanned) this._updateZoneFromGlobal();
  },

  _updateZoneFromEvent: function (data) {
    var centerX = data.centerX || 0;
    var centerZ = data.centerZ || -2;
    var width = data.width || 4;
    var depth = data.depth || 4;
    var height = data.height || 2.5;
    var floorY = data.floorY || 0;

    this.roomBounds = {
      minX: centerX - width / 2, maxX: centerX + width / 2,
      minZ: centerZ - depth / 2, maxZ: centerZ + depth / 2,
      minY: floorY, maxY: floorY + height
    };
    this.orientedBox = data.orientedBox || null;
    this.obstacles = data.obstaclePlanes || [];
    this.wallPlanes = data.wallPlanes || [];
    this.floorY = floorY;
    this.ceilingY = floorY + height - 0.3;
    this._ensureInBounds();
  },

  _updateZoneFromGlobal: function () {
    this.roomBounds = window.FISH_ZONE.roomBounds;
    this.orientedBox = window.FISH_ZONE.orientedBox;
    this.obstacles = window.FISH_ZONE.obstacles;
    this.wallPlanes = window.FISH_ZONE.wallPlanes;
    this.floorY = window.FISH_ZONE.floorY;
    this.ceilingY = window.FISH_ZONE.ceilingY;
  },

  _generateConeReflection: function (normal, speed, coneAngle, damping) {
    var direction = normal.clone().normalize();

    var helper = new THREE.Vector3(0, 1, 0);
    if (Math.abs(direction.dot(helper)) > 0.9) helper = new THREE.Vector3(1, 0, 0);
    var u = new THREE.Vector3().crossVectors(direction, helper).normalize();
    var v = new THREE.Vector3().crossVectors(direction, u).normalize();

    var phi = Math.random() * Math.PI * 2;
    var coneRad = coneAngle * (Math.PI / 180);
    var theta = Math.acos(1 - Math.random() * (1 - Math.cos(coneRad)));
    var sinTheta = Math.sin(theta);
    var cosTheta = Math.cos(theta);

    var newDir = new THREE.Vector3()
      .addScaledVector(direction, cosTheta)
      .addScaledVector(u, sinTheta * Math.cos(phi))
      .addScaledVector(v, sinTheta * Math.sin(phi));
    newDir.normalize();

    var newSpeed = Math.max(speed * damping, this._collisionConfig.minReflectionSpeed);
    return newDir.multiplyScalar(newSpeed);
  },

  _pickNewTarget: function () {
    if (this.roomBounds && isFinite(this.roomBounds.minX)) {
      var margin = 0.3;
      var minX = this.roomBounds.minX + margin;
      var maxX = this.roomBounds.maxX - margin;
      var minZ = this.roomBounds.minZ + margin;
      var maxZ = this.roomBounds.maxZ - margin;
      var minY = Math.max(this.floorY + 0.3, 0.2);
      var maxY = Math.min(this.ceilingY - 0.3, this.floorY + 2.0);

      for (var attempt = 0; attempt < 10; attempt++) {
        this.target.set(
          minX + Math.random() * (maxX - minX),
          minY + Math.random() * (maxY - minY),
          minZ + Math.random() * (maxZ - minZ)
        );
        if (!isPointInsideObstacle(this.target, this.obstacles, this.floorY)) break;
      }
    } else {
      var b = this.bounds;
      this.target.set(
        (Math.random() - 0.5) * b * 2,
        0.2 + Math.random() * (b - 0.2),
        (Math.random() - 0.5) * b * 2 - 1.0
      );
    }
  },

  _ensureInBounds: function () {
    if (!this.roomBounds || !isFinite(this.roomBounds.minX)) return;
    var pos = this.el.object3D.position;
    var margin = 0.2;
    pos.x = Math.max(this.roomBounds.minX + margin, Math.min(this.roomBounds.maxX - margin, pos.x));
    pos.y = Math.max(this.floorY + 0.2, Math.min(this.ceilingY - 0.2, pos.y));
    pos.z = Math.max(this.roomBounds.minZ + margin, Math.min(this.roomBounds.maxZ - margin, pos.z));
  },

  _checkFloorCeilingCollision: function (nextPos) {
    var collision = false;
    var cfg = this._collisionConfig;

    if (nextPos.y <= this.floorY + 0.2) {
      var floorNormal = new THREE.Vector3(0, 1, 0);
      var newVel = this._generateConeReflection(floorNormal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor);
      this.velocity.copy(newVel);
      nextPos.y = this.floorY + 0.25;
      collision = true;
    } else if (nextPos.y >= this.ceilingY - 0.2) {
      var ceilNormal = new THREE.Vector3(0, -1, 0);
      var newVel2 = this._generateConeReflection(ceilNormal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor);
      this.velocity.copy(newVel2);
      nextPos.y = this.ceilingY - 0.25;
      collision = true;
    }

    return collision;
  },

  _checkWallCollision: function (pos, nextPos) {
    if (!this.roomBounds || !isFinite(this.roomBounds.minX)) return false;

    if (this.orientedBox) {
      return this._checkOrientedBoxCollision(pos, nextPos);
    }
    return this._checkAxisAlignedCollision(pos, nextPos);
  },

  _checkOrientedBoxCollision: function (pos, nextPos) {
    var box = this.orientedBox;
    var margin = 0.2;
    var cfg = this._collisionConfig;

    var localX, localZ, velLocalX, velLocalZ, cos, sin;
    if (box.inverseMatrix) {
      var local = new THREE.Vector3(nextPos.x, nextPos.y, nextPos.z).applyMatrix4(box.inverseMatrix);
      localX = local.x;
      localZ = local.z;
      var rotInv = box.inverseMatrix.clone();
      rotInv.setPosition(0, 0, 0);
      var localVel = new THREE.Vector3(this.velocity.x, this.velocity.y, this.velocity.z).applyMatrix4(rotInv);
      velLocalX = localVel.x;
      velLocalZ = localVel.z;
      cos = Math.cos(box.rotationY);
      sin = Math.sin(box.rotationY);
    } else {
      var dx = nextPos.x - box.centerX;
      var dz = nextPos.z - box.centerZ;
      cos = Math.cos(box.rotationY);
      sin = Math.sin(box.rotationY);
      localX = dx * cos + dz * sin;
      localZ = -dx * sin + dz * cos;
      velLocalX = this.velocity.x * cos + this.velocity.z * sin;
      velLocalZ = -this.velocity.x * sin + this.velocity.z * cos;
    }

    var localMinX = (box.localMinX !== undefined) ? box.localMinX + margin : -box.halfWidth + margin;
    var localMaxX = (box.localMaxX !== undefined) ? box.localMaxX - margin : box.halfWidth - margin;
    var localMinZ = (box.localMinZ !== undefined) ? box.localMinZ + margin : -box.halfDepth + margin;
    var localMaxZ = (box.localMaxZ !== undefined) ? box.localMaxZ - margin : box.halfDepth - margin;

    var correctedLocalX = localX;
    var correctedLocalZ = localZ;
    var bounced = false;
    var localNormal = new THREE.Vector3(0, 0, 0);

    if (localX < localMinX) {
      correctedLocalX = localMinX + 0.15;
      localNormal.x = 1;
      bounced = true;
    } else if (localX > localMaxX) {
      correctedLocalX = localMaxX - 0.15;
      localNormal.x = -1;
      bounced = true;
    }
    if (localZ < localMinZ) {
      correctedLocalZ = localMinZ + 0.15;
      localNormal.z = 1;
      bounced = true;
    } else if (localZ > localMaxZ) {
      correctedLocalZ = localMaxZ - 0.15;
      localNormal.z = -1;
      bounced = true;
    }

    if (bounced) {
      localNormal.normalize();
      var localVelVec = new THREE.Vector3(velLocalX, this.velocity.y, velLocalZ);
      var newVel = this._generateConeReflection(localNormal, localVelVec.length(), cfg.coneAngle, cfg.dampingFactor);

      if (box.matrix) {
        var correctedLocal = new THREE.Vector3(correctedLocalX, nextPos.y, correctedLocalZ);
        var worldCorrected = correctedLocal.applyMatrix4(box.matrix);
        nextPos.x = worldCorrected.x;
        nextPos.z = worldCorrected.z;

        var rot = box.matrix.clone();
        rot.setPosition(0, 0, 0);
        var worldVel = new THREE.Vector3(newVel.x, this.velocity.y, newVel.z).applyMatrix4(rot);
        this.velocity.x = worldVel.x;
        this.velocity.z = worldVel.z;
      } else {
        nextPos.x = box.centerX + (correctedLocalX * cos - correctedLocalZ * sin);
        nextPos.z = box.centerZ + (correctedLocalX * sin + correctedLocalZ * cos);
        this.velocity.x = newVel.x * cos - newVel.z * sin;
        this.velocity.z = newVel.x * sin + newVel.z * cos;
      }
    }

    return bounced || this._checkFloorCeilingCollision(nextPos);
  },

  _checkAxisAlignedCollision: function (pos, nextPos) {
    var margin = 0.15;
    var cfg = this._collisionConfig;
    var wallNormal = new THREE.Vector3(0, 0, 0);
    var wallHit = false;

    if (nextPos.x <= this.roomBounds.minX + margin) {
      wallNormal.x = 1;
      nextPos.x = this.roomBounds.minX + margin + 0.02;
      wallHit = true;
    } else if (nextPos.x >= this.roomBounds.maxX - margin) {
      wallNormal.x = -1;
      nextPos.x = this.roomBounds.maxX - margin - 0.02;
      wallHit = true;
    }
    if (nextPos.z <= this.roomBounds.minZ + margin) {
      wallNormal.z = 1;
      nextPos.z = this.roomBounds.minZ + margin + 0.02;
      wallHit = true;
    } else if (nextPos.z >= this.roomBounds.maxZ - margin) {
      wallNormal.z = -1;
      nextPos.z = this.roomBounds.maxZ - margin - 0.02;
      wallHit = true;
    }

    if (wallHit) {
      wallNormal.normalize();
      this.velocity.copy(this._generateConeReflection(wallNormal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor));
    }
    return wallHit || this._checkFloorCeilingCollision(nextPos);
  },

  _checkObstacleCollision: function (pos, nextPos) {
    if (!this.obstacles || this.obstacles.length === 0) return false;

    var collision = false;
    var fishRadius = 0.03;
    var cfg = this._collisionConfig;

    this.obstacles.forEach(function (obstacle) {
      var obsData = obstacle.data;
      if (!obsData.position || !obsData.bounds) return;
      var bounds = obsData.bounds;

      var effectiveMinY = bounds.minY;
      var effectiveMaxY = bounds.maxY;
      var obsType = obsData.obstacleType || '';
      if (obsType === 'table' || obsType === 'meuble_bas' || obsType === 'etagere' || obsType === 'obstacle') {
        effectiveMinY = this.floorY;
        effectiveMaxY = bounds.maxY + 0.05;
      }

      var inX = nextPos.x > bounds.minX - fishRadius && nextPos.x < bounds.maxX + fishRadius;
      var inY = nextPos.y > effectiveMinY - fishRadius && nextPos.y < effectiveMaxY + fishRadius;
      var inZ = nextPos.z > bounds.minZ - fishRadius && nextPos.z < bounds.maxZ + fishRadius;

      if (inX && inY && inZ) {
        var pens = [
          { axis: 'x', pen: nextPos.x - (bounds.minX - fishRadius), sign: -1 },
          { axis: 'x', pen: (bounds.maxX + fishRadius) - nextPos.x, sign: 1 },
          { axis: 'y', pen: nextPos.y - (effectiveMinY - fishRadius), sign: -1 },
          { axis: 'y', pen: (effectiveMaxY + fishRadius) - nextPos.y, sign: 1 },
          { axis: 'z', pen: nextPos.z - (bounds.minZ - fishRadius), sign: -1 },
          { axis: 'z', pen: (bounds.maxZ + fishRadius) - nextPos.z, sign: 1 }
        ];
        pens.sort(function (a, b) { return a.pen - b.pen; });
        var best = pens[0];

        var normal = new THREE.Vector3(0, 0, 0);
        if (best.axis === 'x') {
          nextPos.x = (best.sign === -1) ? bounds.minX - fishRadius - 0.15 : bounds.maxX + fishRadius + 0.15;
          normal.x = best.sign === -1 ? -1 : 1;
        } else if (best.axis === 'y') {
          nextPos.y = (best.sign === -1) ? effectiveMinY - fishRadius - 0.15 : effectiveMaxY + fishRadius + 0.15;
          normal.y = best.sign === -1 ? -1 : 1;
        } else {
          nextPos.z = (best.sign === -1) ? bounds.minZ - fishRadius - 0.15 : bounds.maxZ + fishRadius + 0.15;
          normal.z = best.sign === -1 ? -1 : 1;
        }

        var newVel = this._generateConeReflection(normal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor);
        this.velocity.copy(newVel);
        collision = true;
      }
    }.bind(this));

    return collision;
  },

  _setTargetAfterBounce: function (pos) {
    var reboundDir = this.velocity.clone().normalize();
    var distToTarget = 1.5 + Math.random() * 2.0;
    this.target.copy(pos).addScaledVector(reboundDir, distToTarget);
    this._clampTargetInBounds();
  },

  _clampTargetInBounds: function () {
    if (!this.roomBounds || !isFinite(this.roomBounds.minX)) return;
    var m = 0.4;
    this.target.x = Math.max(this.roomBounds.minX + m, Math.min(this.roomBounds.maxX - m, this.target.x));
    this.target.z = Math.max(this.roomBounds.minZ + m, Math.min(this.roomBounds.maxZ - m, this.target.z));
    this.target.y = Math.max(this.floorY + 0.3, Math.min(this.ceilingY - 0.3, this.target.y));
  },

  _applySafetyBounce: function (pos) {
    if (!this.roomBounds || !isFinite(this.roomBounds.minX)) return;
    var safeMar = 0.1;
    var safetyBounce = false;
    var safeNormal = new THREE.Vector3(0, 0, 0);

    if (pos.x < this.roomBounds.minX + safeMar) { pos.x = this.roomBounds.minX + safeMar; safeNormal.x += 1; safetyBounce = true; }
    if (pos.x > this.roomBounds.maxX - safeMar) { pos.x = this.roomBounds.maxX - safeMar; safeNormal.x -= 1; safetyBounce = true; }
    if (pos.y < this.floorY + 0.15) { pos.y = this.floorY + 0.15; safeNormal.y += 1; safetyBounce = true; }
    if (pos.y > this.ceilingY - 0.15) { pos.y = this.ceilingY - 0.15; safeNormal.y -= 1; safetyBounce = true; }
    if (pos.z < this.roomBounds.minZ + safeMar) { pos.z = this.roomBounds.minZ + safeMar; safeNormal.z += 1; safetyBounce = true; }
    if (pos.z > this.roomBounds.maxZ - safeMar) { pos.z = this.roomBounds.maxZ - safeMar; safeNormal.z -= 1; safetyBounce = true; }

    if (safetyBounce) {
      safeNormal.normalize();
      var cfg = this._collisionConfig;
      var safeVel = this._generateConeReflection(safeNormal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor);
      this.velocity.copy(safeVel);
      this._collisionCooldown = 1.5;
      this._setTargetAfterBounce(pos);
    }
  },

  tick: function (time, delta) {
    if (!delta) return;
    if (this.el.__isGrabbed) return;

    var dt = delta / 1000;
    var pos = this.el.object3D.position;

    // Mode d'entrée
    if (this._entryMode) {
      var elapsed = Date.now() - this._entryStartTime;
      var endEntry = elapsed > this._entryDuration;
      if (!endEntry && this.roomBounds && isFinite(this.roomBounds.minX)) {
        var margin = 0.3;
        var insideRoom =
          pos.x > this.roomBounds.minX + margin && pos.x < this.roomBounds.maxX - margin &&
          pos.z > this.roomBounds.minZ + margin && pos.z < this.roomBounds.maxZ - margin;

        if (insideRoom) {
          var nextX = pos.x + this.velocity.x * dt;
          var nextZ = pos.z + this.velocity.z * dt;
          if (nextX <= this.roomBounds.minX + margin || nextX >= this.roomBounds.maxX - margin ||
            nextZ <= this.roomBounds.minZ + margin || nextZ >= this.roomBounds.maxZ - margin) {
            endEntry = true;
          }
        }
      }

      if (endEntry) {
        this._entryMode = false;
        this._pickNewTarget();
      } else {
        var safeDt = Math.min(dt, 0.05);
        pos.addScaledVector(this.velocity, safeDt);
        this.swayPhase += safeDt * 1.5;
        pos.y += Math.sin(this.swayPhase * 2.0) * 0.015 * safeDt * 60;

        if (this.velocity.length() > 0.001) {
          var dir = this.velocity.clone().normalize();
          this.el.object3D.rotation.y = Math.atan2(dir.x, dir.z);
          this.el.object3D.rotation.x = -Math.atan2(this.velocity.y,
            Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z)) * 0.3;
        }
        return;
      }
    }

    // --- Comportement normal ---
    if (pos.distanceTo(this.target) < 0.4) this._pickNewTarget();
    if (this._collisionCooldown > 0) this._collisionCooldown -= dt;

    // Direction vers la cible
    var desired = this.target.clone().sub(pos).normalize().multiplyScalar(this.speed);
    var lerpFactor = (this._collisionCooldown > 0) ? Math.min(1, dt * 0.05) : Math.min(1, dt * 0.8);
    this.velocity.lerp(desired, lerpFactor);

    this.swayPhase += dt * (0.35 + Math.random() * 0.2);
    var lateral = new THREE.Vector3().crossVectors(this.velocity, new THREE.Vector3(0, 1, 0)).normalize();
    var sway = lateral.multiplyScalar(Math.sin(this.swayPhase) * 0.01);
    var verticalBob = Math.sin(this.swayPhase * 0.6 + this.bobOffset) * this.bobAmplitude;
    if (this.roomBounds && Math.random() < dt * 0.25) {
      var minY = this.floorY + 0.2;
      var maxY = this.ceilingY - 0.2;
      this.target.y = Math.max(minY, Math.min(maxY, this.target.y + (Math.random() - 0.5) * 0.6));
    }

    // Calculer la prochaine position
    var nextPos = pos.clone();
    nextPos.addScaledVector(this.velocity, dt);
    nextPos.addScaledVector(sway, 1);
    var wallHit = this._checkWallCollision(pos, nextPos);
    var obstacleHit = this._checkObstacleCollision(pos, nextPos);

    if (wallHit || obstacleHit) {
      this._collisionCooldown = 1.5;
      this._setTargetAfterBounce(pos);
    }

    nextPos.y += verticalBob;
    pos.copy(nextPos);
    this._applySafetyBounce(pos);

    // Rotation douce vers la direction du mouvement
    if (this.velocity.lengthSq() > 0.0001) {
      var maxPitch = Math.PI / 4;
      var vel = this.velocity.clone();
      var horizLen = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      var safeHoriz = Math.max(horizLen, 0.0001);
      var maxVY = Math.tan(maxPitch) * safeHoriz;
      var clampedY = Math.max(-maxVY, Math.min(maxVY, vel.y));
      var constrainedDir = new THREE.Vector3(vel.x, clampedY, vel.z).normalize();
      var lookTarget = pos.clone().add(constrainedDir);

      var currentQuat = this.el.object3D.quaternion.clone();
      this.el.object3D.lookAt(lookTarget);
      var targetQuat = this.el.object3D.quaternion.clone();
      this.el.object3D.quaternion.copy(currentQuat);
      this.el.object3D.quaternion.slerp(targetQuat, Math.min(1, dt * 1.6));
    }
  }
});


AFRAME.registerComponent('fish-spawner', {
  schema: {
    count: { type: 'int', default: 8 },
    area: { type: 'number', default: 2 }
  },

  init: function () {
    this.fishes = [];
    this.roomBounds = null;
    this.floorY = 0;
    this.ceilingY = 2.5;
    this.spawned = false;
    this._pendingRoomData = null;

    var self = this;
    this.el.sceneEl.addEventListener('room-scanned', function (e) { self._pendingRoomData = e.detail; });
    this.el.sceneEl.addEventListener('zone-updated', function (e) {
      if (self.spawned && e.detail) {
        self.roomBounds = e.detail.bounds || self.roomBounds;
        self.floorY = e.detail.floorY != null ? e.detail.floorY : self.floorY;
        self.ceilingY = e.detail.ceilingY != null ? e.detail.ceilingY : self.ceilingY;
      }
    });

    setTimeout(function () {
      if (!self.spawned && !self._pendingRoomData) {
        var config = window.GAME_CONFIG || {};
        self._pendingRoomData = config.DEFAULT_ROOM || {
          centerX: 0, centerZ: -2, width: 4, depth: 4, height: 2.5, floorY: 0,
          bounds: { minX: -2, maxX: 2, minZ: -3, maxZ: 1 }
        };
      }
    }, 20000);
  },

  /** Déclenché par le bouton PLAY */
  startSpawn: function () {
    if (this.spawned) return;
    var config = window.GAME_CONFIG || {};
    var roomData = this._pendingRoomData || config.DEFAULT_ROOM || {
      centerX: 0, centerZ: -2, width: 4, depth: 4, height: 2.5, floorY: 0,
      bounds: { minX: -2, maxX: 2, minZ: -3, maxZ: 1 }
    };
    this._spawnFishesInRoom(roomData);
    this._pendingRoomData = null;
  },

  _spawnFishesInRoom: function (roomData) {
    if (this.spawned) return;
    this.spawned = true;
    this._initialFishCount = this.data.count || 0;
    this._spawnStartTime = performance.now();

    var floorY = roomData.floorY || 0;
    var height = roomData.height || 2.5;
    var bounds = roomData.bounds || { minX: -2, maxX: 2, minZ: -3, maxZ: 1 };

    var margin = 0.3;
    var minX = bounds.minX + margin;
    var maxX = bounds.maxX - margin;
    var minZ = bounds.minZ + margin;
    var maxZ = bounds.maxZ - margin;
    var maxY = floorY + height - 0.4;

    this.orientedBox = roomData.orientedBox || null;
    this.roomBounds = { minX: minX, maxX: maxX, minY: floorY + 0.3, maxY: maxY, minZ: minZ, maxZ: maxZ };
    this.floorY = floorY;
    this.ceilingY = maxY;
    this.obstacles = roomData.obstaclePlanes || [];

    window.FISH_ZONE.orientedBox = this.orientedBox;
    window.FISH_ZONE.floorY = floorY;
    window.FISH_ZONE.ceilingY = maxY;
    window.FISH_ZONE.roomBounds = this.roomBounds;
    window.FISH_ZONE.obstacles = this.obstacles;

    // Vérifier les ouvertures disponibles
    var openings = window.FISH_ZONE.openings || [];
    if (openings.length === 0) {
      var cx = roomData.centerX || 0;
      var cz = roomData.centerZ || -2;
      openings = [
        { type: 'door', position: { x: cx, y: floorY + 1.0, z: bounds.minZ }, normal: { x: 0, y: 0, z: -1 }, size: { width: 1.0, height: 2.0 }, wall: 'north' },
        { type: 'window', position: { x: bounds.maxX, y: floorY + 1.8, z: cz }, normal: { x: 1, y: 0, z: 0 }, size: { width: 1.2, height: 1.2 }, wall: 'east' }
      ];
      window.FISH_ZONE.openings = openings;
    }

    var scene = this.el.sceneEl;
    var parent = document.querySelector('#world-anchor') || scene;

    // Récupérer la liste des modèles
    var config = window.GAME_CONFIG || {};
    var fishModels = config.FISH_MODELS || [
      { type: 'goldfish', model: '#goldfish', scaleAdjust: 0.5 },
      { type: 'piranha', model: '#piranha', scaleAdjust: 4.0 },
      { type: 'thon', model: '#thon', scaleAdjust: 0.5 },
      { type: 'thon_bleu', model: '#thon_bleu', scaleAdjust: 4.0 }
    ];

    console.log('Spawning', this.data.count, 'fish from', openings.length, 'opening(s)');

    for (var i = 0; i < this.data.count; i++) {
      var fish = document.createElement('a-entity');

      // Choisir un modèle aléatoire
      var chosen = fishModels[Math.floor(Math.random() * fishModels.length)];
      fish.setAttribute('gltf-model', chosen.model);

      var baseScale = (0.6 + Math.random() * 0.6) / 72.0;
      var finalScale = baseScale * chosen.scaleAdjust;
      fish.setAttribute('scale', finalScale + ' ' + finalScale + ' ' + finalScale);

      // Spawn depuis une ouverture aléatoire
      var opening = openings[Math.floor(Math.random() * openings.length)];
      var spawnData = this._computeSpawnFromOpening(opening, bounds);

      var vx = spawnData.velocity.x;
      var vz = spawnData.velocity.z;
      var ry = THREE.MathUtils.radToDeg(Math.atan2(vx, vz));
      fish.setAttribute('rotation', '0 ' + ry + ' 0');

      fish.setAttribute('position', spawnData.position.x + ' ' + spawnData.position.y + ' ' + spawnData.position.z);

      // Classes et attributs
      fish.classList.add('fish', 'fish-target');
      fish.setAttribute('grabbable', '');
      fish.setAttribute('data-fish-type', chosen.type);

      // Configurer le mouvement
      var baseSpeed = 0.00001;
      var mc = 'speed: ' + baseSpeed + '; bounds: ' + this.data.area
        + '; entryMode: true; entryDuration: ' + spawnData.entryDuration
        + '; initialVelocity: ' + spawnData.velocity.x + ' ' + spawnData.velocity.y + ' ' + spawnData.velocity.z;
      fish.setAttribute('fish-movement', mc);

      parent.appendChild(fish);
      this.fishes.push(fish);
    }

    console.log(this.fishes.length, 'fishes spawned');
    this._startFishRemainingObserver(parent);
  },

  /**
   * Calcule position et vélocité de spawn depuis une ouverture.
   */
  _computeSpawnFromOpening: function (opening) {
    var spawnDistance = 2.0 + Math.random() * 1.5;
    var nx = opening.normal.x;
    var nz = opening.normal.z;
    var perpX = -nz;
    var perpZ = nx;
    var halfW = (opening.size.width || 1.0) * 0.5 * 0.8;
    var spread = (Math.random() - 0.5) * 2.0 * halfW;
    var startPos = {
      x: opening.position.x + nx * spawnDistance + perpX * spread,
      y: opening.position.y + (Math.random() - 0.5) * (opening.size.height || 1.0) * 0.4,
      z: opening.position.z + nz * spawnDistance + perpZ * spread
    };

    var speed = 0.35 + Math.random() * 0.15;
    var velocity = {
      x: -nx * speed,
      y: (Math.random() - 0.5) * speed * 0.1,
      z: -nz * speed
    };

    var travelTime = (spawnDistance + 2.0) / speed;

    return {
      position: startPos,
      velocity: velocity,
      entryDuration: travelTime * 1000
    };
  },

  _startFishRemainingObserver: function (parent) {
    try {
      if (this._observer) this._observer.disconnect();
      var self = this;

      function checkAndEnd() {
        var remaining = parent.querySelectorAll('.fish-target').length;
        var spawnAge = self._spawnStartTime ? (performance.now() - self._spawnStartTime) : Infinity;
        if (remaining === 0 && self._initialFishCount > 0 && spawnAge > 1500) {
          if (window.gameTimer && window.gameTimer.isGameActive && window.gameTimer.isGameActive()) {
            try { window.gameTimer.endGame(); } catch (e) { /* ignore */ }
          }
        }
      }

      checkAndEnd();

      this._observer = new MutationObserver(function (mutations) {
        for (var m of mutations) {
          if (m.type === 'childList' && m.removedNodes && m.removedNodes.length > 0) {
            checkAndEnd();
            break;
          }
        }
      });
      this._observer.observe(parent, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }
});
