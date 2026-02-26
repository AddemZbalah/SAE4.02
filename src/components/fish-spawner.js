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
    this.speed = this.data.speed * (0.8 + Math.random() * 0.4);
    this.bounds = this.data.bounds;
    this.target = new THREE.Vector3();
    this._pickNewTarget();
    this.swayPhase = Math.random() * Math.PI * 2;
    this.bobAmplitude = 0.003 + Math.random() * 0.006;
    this.bobOffset = Math.random() * Math.PI * 2;
    this._collisionCooldown = 0;
    this._targetTimer = 3 + Math.random() * 4;

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
      minReflectionSpeed: 0.05
    };

    // Vecteurs pré-alloués (évite le garbage collector dans tick)
    this._v = {
      desired: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      lateral: new THREE.Vector3(),
      nextPos: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      lookTarget: new THREE.Vector3(),
      currentQuat: new THREE.Quaternion(),
      targetQuat: new THREE.Quaternion(),
      reflDir: new THREE.Vector3(),
      reflHelper: new THREE.Vector3(),
      reflU: new THREE.Vector3(),
      reflV: new THREE.Vector3(),
      reflResult: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      local: new THREE.Vector3(),
      localVel: new THREE.Vector3(),
      corrected: new THREE.Vector3(),
      worldVel: new THREE.Vector3(),
      safeNormal: new THREE.Vector3()
    };

    var self = this;
    this.el.sceneEl.addEventListener('room-scanned', function (e) { self._updateZoneFromEvent(e.detail); });
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
    var r = this._v;
    r.reflDir.copy(normal).normalize();

    r.reflHelper.set(0, 1, 0);
    if (Math.abs(r.reflDir.dot(r.reflHelper)) > 0.9) r.reflHelper.set(1, 0, 0);
    r.reflU.crossVectors(r.reflDir, r.reflHelper).normalize();
    r.reflV.crossVectors(r.reflDir, r.reflU).normalize();

    var phi = Math.random() * Math.PI * 2;
    var coneRad = coneAngle * (Math.PI / 180);
    var theta = Math.acos(1 - Math.random() * (1 - Math.cos(coneRad)));
    var sinTheta = Math.sin(theta);
    var cosTheta = Math.cos(theta);

    r.reflResult.set(0, 0, 0)
      .addScaledVector(r.reflDir, cosTheta)
      .addScaledVector(r.reflU, sinTheta * Math.cos(phi))
      .addScaledVector(r.reflV, sinTheta * Math.sin(phi))
      .normalize();

    var newSpeed = Math.max(speed * damping, this._collisionConfig.minReflectionSpeed);
    r.reflResult.multiplyScalar(newSpeed);
    return r.reflResult;
  },

  _pickNewTarget: function () {
    if (this.roomBounds && isFinite(this.roomBounds.minX)) {
      var margin = 0.3;
      var pos = this.el.object3D.position;
      var minX = this.roomBounds.minX + margin;
      var maxX = this.roomBounds.maxX - margin;
      var minZ = this.roomBounds.minZ + margin;
      var maxZ = this.roomBounds.maxZ - margin;
      var minY = Math.max(this.floorY + 0.3, 0.2);
      var maxY = Math.min(this.ceilingY - 0.3, this.floorY + 2.0);

      // Essayer de trouver une cible à au moins 1m du poisson
      for (var attempt = 0; attempt < 15; attempt++) {
        this.target.set(
          minX + Math.random() * (maxX - minX),
          minY + Math.random() * (maxY - minY),
          minZ + Math.random() * (maxZ - minZ)
        );
        if (isPointInsideObstacle(this.target, this.obstacles, this.floorY)) continue;
        if (attempt >= 12 || pos.distanceTo(this.target) > 1.0) break;
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
    var v = this._v;

    if (nextPos.y <= this.floorY + 0.2) {
      v.normal.set(0, 1, 0);
      this.velocity.copy(this._generateConeReflection(v.normal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor));
      nextPos.y = this.floorY + 0.25;
      collision = true;
    } else if (nextPos.y >= this.ceilingY - 0.2) {
      v.normal.set(0, -1, 0);
      this.velocity.copy(this._generateConeReflection(v.normal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor));
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
    var v = this._v;

    var localX, localZ, velLocalX, velLocalZ, cos, sin;
    if (box.inverseMatrix) {
      v.local.set(nextPos.x, nextPos.y, nextPos.z).applyMatrix4(box.inverseMatrix);
      localX = v.local.x;
      localZ = v.local.z;
      // Rotation seule (sans translation) via éléments de matrice
      var mi = box.inverseMatrix.elements;
      var vx = this.velocity.x, vy = this.velocity.y, vz = this.velocity.z;
      velLocalX = mi[0] * vx + mi[4] * vy + mi[8] * vz;
      velLocalZ = mi[2] * vx + mi[6] * vy + mi[10] * vz;
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
    v.normal.set(0, 0, 0);

    if (localX < localMinX) {
      correctedLocalX = localMinX + 0.15;
      v.normal.x = 1;
      bounced = true;
    } else if (localX > localMaxX) {
      correctedLocalX = localMaxX - 0.15;
      v.normal.x = -1;
      bounced = true;
    }
    if (localZ < localMinZ) {
      correctedLocalZ = localMinZ + 0.15;
      v.normal.z = 1;
      bounced = true;
    } else if (localZ > localMaxZ) {
      correctedLocalZ = localMaxZ - 0.15;
      v.normal.z = -1;
      bounced = true;
    }

    if (bounced) {
      v.normal.normalize();
      v.localVel.set(velLocalX, this.velocity.y, velLocalZ);
      var newVel = this._generateConeReflection(v.normal, v.localVel.length(), cfg.coneAngle, cfg.dampingFactor);

      if (box.matrix) {
        v.corrected.set(correctedLocalX, nextPos.y, correctedLocalZ).applyMatrix4(box.matrix);
        nextPos.x = v.corrected.x;
        nextPos.z = v.corrected.z;
        // Rotation seule pour la vélocité
        var mf = box.matrix.elements;
        var nx = newVel.x, nz = newVel.z;
        this.velocity.x = mf[0] * nx + mf[4] * this.velocity.y + mf[8] * nz;
        this.velocity.z = mf[2] * nx + mf[6] * this.velocity.y + mf[10] * nz;
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
    var v = this._v;
    v.normal.set(0, 0, 0);
    var wallHit = false;

    if (nextPos.x <= this.roomBounds.minX + margin) {
      v.normal.x = 1;
      nextPos.x = this.roomBounds.minX + margin + 0.02;
      wallHit = true;
    } else if (nextPos.x >= this.roomBounds.maxX - margin) {
      v.normal.x = -1;
      nextPos.x = this.roomBounds.maxX - margin - 0.02;
      wallHit = true;
    }
    if (nextPos.z <= this.roomBounds.minZ + margin) {
      v.normal.z = 1;
      nextPos.z = this.roomBounds.minZ + margin + 0.02;
      wallHit = true;
    } else if (nextPos.z >= this.roomBounds.maxZ - margin) {
      v.normal.z = -1;
      nextPos.z = this.roomBounds.maxZ - margin - 0.02;
      wallHit = true;
    }

    if (wallHit) {
      v.normal.normalize();
      this.velocity.copy(this._generateConeReflection(v.normal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor));
    }
    return wallHit || this._checkFloorCeilingCollision(nextPos);
  },

  _checkObstacleCollision: function (pos, nextPos) {
    if (!this.obstacles || this.obstacles.length === 0) return false;

    var collision = false;
    var fishRadius = 0.03;
    var cfg = this._collisionConfig;
    var v = this._v;

    for (var i = 0; i < this.obstacles.length; i++) {
      var obsData = this.obstacles[i].data;
      if (!obsData.position || !obsData.bounds) continue;
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
        // Pénétration minimale sans allocation
        var penXMin = nextPos.x - (bounds.minX - fishRadius);
        var penXMax = (bounds.maxX + fishRadius) - nextPos.x;
        var penYMin = nextPos.y - (effectiveMinY - fishRadius);
        var penYMax = (effectiveMaxY + fishRadius) - nextPos.y;
        var penZMin = nextPos.z - (bounds.minZ - fishRadius);
        var penZMax = (bounds.maxZ + fishRadius) - nextPos.z;

        var minPen = penXMin, axis = 0, sign = -1;
        if (penXMax < minPen) { minPen = penXMax; axis = 0; sign = 1; }
        if (penYMin < minPen) { minPen = penYMin; axis = 1; sign = -1; }
        if (penYMax < minPen) { minPen = penYMax; axis = 1; sign = 1; }
        if (penZMin < minPen) { minPen = penZMin; axis = 2; sign = -1; }
        if (penZMax < minPen) { minPen = penZMax; axis = 2; sign = 1; }

        v.normal.set(0, 0, 0);
        if (axis === 0) {
          nextPos.x = (sign === -1) ? bounds.minX - fishRadius - 0.15 : bounds.maxX + fishRadius + 0.15;
          v.normal.x = (sign === -1) ? -1 : 1;
        } else if (axis === 1) {
          nextPos.y = (sign === -1) ? effectiveMinY - fishRadius - 0.15 : effectiveMaxY + fishRadius + 0.15;
          v.normal.y = (sign === -1) ? -1 : 1;
        } else {
          nextPos.z = (sign === -1) ? bounds.minZ - fishRadius - 0.15 : bounds.maxZ + fishRadius + 0.15;
          v.normal.z = (sign === -1) ? -1 : 1;
        }

        this.velocity.copy(this._generateConeReflection(v.normal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor));
        collision = true;
      }
    }

    return collision;
  },

  _setTargetAfterBounce: function (pos) {
    var v = this._v;
    v.dir.copy(this.velocity).normalize();
    var distToTarget = 1.5 + Math.random() * 2.0;
    this.target.copy(pos).addScaledVector(v.dir, distToTarget);
    this._clampTargetInBounds();
    this._targetTimer = 3 + Math.random() * 4;
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
    var v = this._v;
    v.safeNormal.set(0, 0, 0);

    if (pos.x < this.roomBounds.minX + safeMar) { pos.x = this.roomBounds.minX + safeMar; v.safeNormal.x += 1; safetyBounce = true; }
    if (pos.x > this.roomBounds.maxX - safeMar) { pos.x = this.roomBounds.maxX - safeMar; v.safeNormal.x -= 1; safetyBounce = true; }
    if (pos.y < this.floorY + 0.15) { pos.y = this.floorY + 0.15; v.safeNormal.y += 1; safetyBounce = true; }
    if (pos.y > this.ceilingY - 0.15) { pos.y = this.ceilingY - 0.15; v.safeNormal.y -= 1; safetyBounce = true; }
    if (pos.z < this.roomBounds.minZ + safeMar) { pos.z = this.roomBounds.minZ + safeMar; v.safeNormal.z += 1; safetyBounce = true; }
    if (pos.z > this.roomBounds.maxZ - safeMar) { pos.z = this.roomBounds.maxZ - safeMar; v.safeNormal.z -= 1; safetyBounce = true; }

    if (safetyBounce) {
      v.safeNormal.normalize();
      var cfg = this._collisionConfig;
      this.velocity.copy(this._generateConeReflection(v.safeNormal, this.velocity.length(), cfg.coneAngle, cfg.dampingFactor));
      this._collisionCooldown = 0.8;
      this._setTargetAfterBounce(pos);
    }
  },

  tick: function (time, delta) {
    if (!delta || this.el.__isGrabbed) return;

    var dt = Math.min(delta / 1000, 0.05);
    var pos = this.el.object3D.position;
    var v = this._v;

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
        this._targetTimer = 3 + Math.random() * 4;
      } else {
        pos.addScaledVector(this.velocity, dt);
        this.swayPhase += dt * 1.5;
        pos.y += Math.sin(this.swayPhase * 2.0) * 0.015 * dt * 60;

        if (this.velocity.lengthSq() > 0.000001) {
          this.el.object3D.rotation.y = Math.atan2(this.velocity.x, this.velocity.z);
          var hLen = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
          this.el.object3D.rotation.x = -Math.atan2(this.velocity.y, Math.max(hLen, 0.0001)) * 0.3;
        }
        return;
      }
    }

    // --- Comportement normal ---
    this._targetTimer -= dt;
    if (this._targetTimer <= 0 || pos.distanceTo(this.target) < 0.5) {
      this._pickNewTarget();
      this._targetTimer = 3 + Math.random() * 4;
    }
    if (this._collisionCooldown > 0) this._collisionCooldown -= dt;

    // Direction vers la cible (vecteurs pré-alloués)
    v.desired.copy(this.target).sub(pos);
    var distToTarget = v.desired.length();
    if (distToTarget > 0.001) v.desired.divideScalar(distToTarget);
    v.desired.multiplyScalar(this.speed);

    var lerpFactor = (this._collisionCooldown > 0) ? Math.min(1, dt * 0.5) : Math.min(1, dt * 2.5);
    this.velocity.lerp(v.desired, lerpFactor);

    this.swayPhase += dt * (0.35 + Math.random() * 0.2);
    v.up.set(0, 1, 0);
    v.lateral.crossVectors(this.velocity, v.up).normalize();
    var swayAmount = Math.sin(this.swayPhase) * 0.01;
    var verticalBob = Math.sin(this.swayPhase * 0.6 + this.bobOffset) * this.bobAmplitude;

    // Prochaine position (vecteur pré-alloué)
    v.nextPos.copy(pos);
    v.nextPos.addScaledVector(this.velocity, dt);
    v.nextPos.x += v.lateral.x * swayAmount;
    v.nextPos.z += v.lateral.z * swayAmount;

    var wallHit = this._checkWallCollision(pos, v.nextPos);
    var obstacleHit = this._checkObstacleCollision(pos, v.nextPos);

    if (wallHit || obstacleHit) {
      this._collisionCooldown = 0.8;
      this._setTargetAfterBounce(pos);
    }

    v.nextPos.y += verticalBob;
    pos.copy(v.nextPos);
    this._applySafetyBounce(pos);

    // Rotation douce vers la direction du mouvement
    if (this.velocity.lengthSq() > 0.0001) {
      var horizLen2 = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
      var safeHoriz = Math.max(horizLen2, 0.0001);
      var maxVY = safeHoriz;
      var clampedY = Math.max(-maxVY, Math.min(maxVY, this.velocity.y));
      v.dir.set(this.velocity.x, clampedY, this.velocity.z).normalize();
      v.lookTarget.copy(pos).add(v.dir);

      v.currentQuat.copy(this.el.object3D.quaternion);
      this.el.object3D.lookAt(v.lookTarget);
      v.targetQuat.copy(this.el.object3D.quaternion);
      this.el.object3D.quaternion.copy(v.currentQuat);
      this.el.object3D.quaternion.slerp(v.targetQuat, Math.min(1, dt * 2.0));
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
    console.log('[fish-spawner] \ud83d\udeaa Ouvertures disponibles:', openings.length);

    if (openings.length === 0) {
      console.warn('[fish-spawner] ⚠️ AUCUNE ouverture détectée - Création de fallback sur chaque mur');
      // Créer 1 ouverture au centre de chaque mur de la bounding box
      var cx = (bounds.minX + bounds.maxX) / 2;
      var cz = (bounds.minZ + bounds.maxZ) / 2;
      var w = bounds.maxX - bounds.minX;
      var d = bounds.maxZ - bounds.minZ;
      var doorH = Math.min(height * 0.8, 2.0);
      openings = [
        { type: 'door', position: { x: cx, y: floorY + doorH / 2, z: bounds.minZ }, normal: { x: 0, y: 0, z: -1 }, size: { width: Math.min(w * 0.3, 1.0), height: doorH }, wall: 'north' },
        { type: 'door', position: { x: cx, y: floorY + doorH / 2, z: bounds.maxZ }, normal: { x: 0, y: 0, z: 1 }, size: { width: Math.min(w * 0.3, 1.0), height: doorH }, wall: 'south' },
        { type: 'door', position: { x: bounds.minX, y: floorY + doorH / 2, z: cz }, normal: { x: -1, y: 0, z: 0 }, size: { width: Math.min(d * 0.3, 1.0), height: doorH }, wall: 'west' },
        { type: 'door', position: { x: bounds.maxX, y: floorY + doorH / 2, z: cz }, normal: { x: 1, y: 0, z: 0 }, size: { width: Math.min(d * 0.3, 1.0), height: doorH }, wall: 'east' }
      ];
      window.FISH_ZONE.openings = openings;
    }

    console.log('[fish-spawner] \ud83d\udc1f Spawn de', this.data.count, 'poissons via', openings.length, 'ouverture(s)');
    openings.forEach(function (o, i) {
      console.log('  [', i, ']', o.type, o.wall, 'pos:', o.position.x.toFixed(2), o.position.y.toFixed(2), o.position.z.toFixed(2));
    });

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

    var self = this;
    var staggerDelay = 800; // ms entre chaque poisson

    for (var i = 0; i < this.data.count; i++) {
      (function (index) {
        setTimeout(function () {
          var fish = document.createElement('a-entity');

          // Choisir un modèle aléatoire
          var chosen = fishModels[Math.floor(Math.random() * fishModels.length)];
          fish.setAttribute('gltf-model', chosen.model);

          var baseScale = (0.6 + Math.random() * 0.6) / 72.0;
          var finalScale = baseScale * chosen.scaleAdjust;
          fish.setAttribute('scale', finalScale + ' ' + finalScale + ' ' + finalScale);

          // Spawn depuis une ouverture aléatoire
          var opening = openings[Math.floor(Math.random() * openings.length)];
          var spawnData = self._computeSpawnFromOpening(opening);

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
          var baseSpeed = 0.4;
          var mc = 'speed: ' + baseSpeed + '; bounds: ' + self.data.area
            + '; entryMode: true; entryDuration: ' + spawnData.entryDuration
            + '; initialVelocity: ' + spawnData.velocity.x + ' ' + spawnData.velocity.y + ' ' + spawnData.velocity.z;
          fish.setAttribute('fish-movement', mc);

          parent.appendChild(fish);
          self.fishes.push(fish);
        }, index * staggerDelay);
      })(i);
    }

    this._startFishRemainingObserver(parent);
  },

  /**
   * Calcule position et vélocité de spawn depuis une ouverture.
   * Le poisson apparaît juste derrière le mur (à 0.3-0.6m) et nage à travers l'ouverture.
   */
  _computeSpawnFromOpening: function (opening) {
    // Distance derrière le mur (très proche pour effet visuel)
    var spawnDistance = 0.4 + Math.random() * 0.3;
    var nx = opening.normal.x;
    var nz = opening.normal.z;

    // Dispersion dans le cadre de l'ouverture - STRICTE pour rester dedans
    var perpX = -nz;
    var perpZ = nx;
    var halfW = (opening.size.width || 1.0) * 0.15;  // 15% de la largeur max
    var halfH = (opening.size.height || 1.0) * 0.15; // 15% de la hauteur max
    var spread = (Math.random() - 0.5) * 2.0 * halfW;
    var ySpread = (Math.random() - 0.5) * 2.0 * halfH;

    var startPos = {
      x: opening.position.x + nx * spawnDistance + perpX * spread,
      y: opening.position.y + ySpread,
      z: opening.position.z + nz * spawnDistance + perpZ * spread
    };

    // Vitesse d'entrée — le poisson nage VERS l'intérieur de la pièce
    var speed = 0.4 + Math.random() * 0.2;
    // Angle quasi-droit pour garantir l'entrée par l'ouverture
    var angleDeviation = (Math.random() - 0.5) * 0.1; // Très faible déviation
    var velocity = {
      x: -nx * speed + perpX * angleDeviation * speed,
      y: (Math.random() - 0.5) * speed * 0.04,
      z: -nz * speed + perpZ * angleDeviation * speed
    };

    // Temps pour traverser l'ouverture + entrer dans la pièce (2m environ)
    var travelTime = (spawnDistance + 2.5) / speed;

    console.log('[spawn] 🐟 pos:', startPos.x.toFixed(2), startPos.y.toFixed(2), startPos.z.toFixed(2),
      'opening:', opening.position.x.toFixed(2), opening.position.y.toFixed(2), opening.position.z.toFixed(2),
      'normal:', nx, nz, 'spread:', spread.toFixed(2), ySpread.toFixed(2));

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
