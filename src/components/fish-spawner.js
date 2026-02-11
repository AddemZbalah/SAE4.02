// Variables globales pour partager les infos de la zone entre spawner et fish-movement
window.FISH_ZONE = {
  roomBounds: null,
  orientedBox: null,
  floorY: 0,
  ceilingY: 2.5,
  scanned: false,
  obstacles: [],
  wallPlanes: []
};

AFRAME.registerComponent('fish-movement', {
  schema: {
    speed: { type: 'number', default: 0.05 },
    bounds: { type: 'number', default: 2 }
  },

  init: function () {
    // Swimming state: velocity, target point, sway for a natural swim
    this.velocity = new THREE.Vector3(0, 0, 0);
    // Slight random variation, but overall very slow — increase a bit so fish can escape walls
    this.speed = this.data.speed * (0.001 + Math.random() * 0.0006);
    this.bounds = this.data.bounds;
    this.target = new THREE.Vector3();
    this._pickNewTarget();
    this.swayPhase = Math.random() * Math.PI * 2;
    // vertical bobbing parameters (per-fish for subtle variation)
    this.bobAmplitude = 0.003 + Math.random() * 0.006; // meters (small)
    this.bobOffset = Math.random() * Math.PI * 2;

    // Cooldown après collision pour laisser le poisson s'éloigner avant de lerp vers une cible
    this._collisionCooldown = 0;

    // Utiliser les données globales de la zone
    this.roomBounds = null;
    this.orientedBox = null;
    this.obstacles = [];
    this.wallPlanes = [];
    this.floorY = 0;
    this.ceilingY = 2.5;

    // Configuration du système de réflexion avec cône
    // coneAngle: angle du cône en degrés autour de la NORMALE (80° = très aléatoire)
    // dampingFactor: réduction de vitesse après collision (0.5 = perd 50%, 1.0 = garde tout)
    // minReflectionSpeed: vitesse minimale après réflexion pour éviter l'arrêt total
    this._collisionConfig = {
      coneAngle: 160,
      dampingFactor: 0.85,
      minReflectionSpeed: 0.000005
    };

    // Écouter l'événement de scan de pièce
    this.el.sceneEl.addEventListener('room-scanned', (e) => {
      this._updateZoneFromEvent(e.detail);
    });

    // Écouter la réinitialisation de la room pour permettre un nouveau spawn si nécessaire
    this.el.sceneEl.addEventListener('room-reset', () => {
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🐟 fish-spawner: room-reset received - resetting spawn');
      // Permettre de respawner lors d'un nouveau scan sans recharger la page
      this.spawned = false;

      // Supprimer les poissons existants pour éviter duplication si on respawn
      if (this.fishes && this.fishes.length > 0) {
        this.fishes.forEach(f => {
          if (f.parentNode) f.parentNode.removeChild(f);
        });
        this.fishes = [];
      }
    });

    // Récupérer les infos si déjà disponibles
    if (window.FISH_ZONE.scanned) {
      this._updateZoneFromGlobal();
    }
  },

  _updateZoneFromEvent: function (data) {
    const centerX = data.centerX || 0;
    const centerZ = data.centerZ || -2;
    const width = data.width || 4;
    const depth = data.depth || 4;
    const height = data.height || 2.5;
    const floorY = data.floorY || 0;

    this.roomBounds = {
      minX: centerX - width / 2,
      maxX: centerX + width / 2,
      minZ: centerZ - depth / 2,
      maxZ: centerZ + depth / 2,
      minY: floorY,
      maxY: floorY + height
    };

    this.orientedBox = data.orientedBox || null;
    this.obstacles = data.obstaclePlanes || [];
    this.wallPlanes = data.wallPlanes || [];
    this.floorY = floorY;
    this.ceilingY = floorY + height - 0.3;

    if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🐟 Fish: zone detected', this.orientedBox ? '(ORIENTED)' : '(rect)');

    this._ensureInBounds();
  },

  _updateZoneFromGlobal: function () {
    this.roomBounds = window.FISH_ZONE.roomBounds;
    this.orientedBox = window.FISH_ZONE.orientedBox;
    this.obstacles = window.FISH_ZONE.obstacles;
    this.wallPlanes = window.FISH_ZONE.wallPlanes;
    this.floorY = window.FISH_ZONE.floorY;
    this.ceilingY = window.FISH_ZONE.ceilingY;

    if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🐟 Fish: got global zone', this.orientedBox ? '(ORIENTED)' : '(rect)');
  },

  // ==========================================
  // SYSTÈME DE RÉFLEXION PHYSIQUE AVEC CÔNE
  // ==========================================

  // Calcul du vecteur réfléchi parfait : R = D - 2(D·N)N
  // incident = direction actuelle du poisson (THREE.Vector3)
  // normal = vecteur normal de la surface (THREE.Vector3, normalisé)
  // Retourne un nouveau THREE.Vector3 réfléchi
  _calculateReflection: function (incident, normal) {
    // Produit scalaire entre la direction incidente et la normale
    var dotProduct = incident.dot(normal);
    // Formule de réflexion : R = D - 2(D·N)N
    var reflected = incident.clone().sub(
      normal.clone().multiplyScalar(2 * dotProduct)
    );
    return reflected;
  },

  // Crée une base orthonormée (U, V) perpendiculaire à un vecteur donné
  // Nécessaire pour construire le cône autour du vecteur réfléchi
  // Retourne { u: THREE.Vector3, v: THREE.Vector3 }
  _createOrthonormalBasis: function (vector) {
    var normalized = vector.clone().normalize();
    // Choisir un vecteur "helper" non parallèle au vecteur d'entrée
    // Si le vecteur est presque vertical (Y), on utilise X à la place
    var helper = new THREE.Vector3(0, 1, 0);
    if (Math.abs(normalized.dot(helper)) > 0.9) {
      helper = new THREE.Vector3(1, 0, 0);
    }
    // Premier vecteur perpendiculaire : produit vectoriel (vector × helper)
    var u = new THREE.Vector3().crossVectors(normalized, helper).normalize();
    // Second vecteur perpendiculaire : produit vectoriel (vector × u)
    var v = new THREE.Vector3().crossVectors(normalized, u).normalize();
    return { u: u, v: v };
  },

  // Génère un vecteur de direction aléatoire dans un cône autour de la NORMALE
  // Cela évite l'effet ping-pong : le poisson part dans une direction aléatoire
  // dans l'hémisphère opposé à l'obstacle, pas juste en miroir
  // normal = vecteur normal de la surface (direction "loin de l'obstacle")
  // speed = vitesse actuelle du poisson
  // coneAngleDeg = angle du cône en degrés (80° = très aléatoire)
  // dampingFactor = facteur d'amortissement (0.0 à 1.0)
  // Retourne un nouveau THREE.Vector3 avec la nouvelle direction et vitesse
  _generateConeReflection: function (normal, speed, coneAngleDeg, dampingFactor) {
    // Direction de base = la normale de la surface (pointe loin de l'obstacle)
    var direction = normal.clone().normalize();

    // Créer la base orthonormée (U, V) perpendiculaire à la normale
    var basis = this._createOrthonormalBasis(direction);
    var u = basis.u;
    var v = basis.v;

    // ---- Génération aléatoire dans le cône autour de la normale ----
    // phi = angle de rotation autour de la normale (0 à 2π) → direction aléatoire
    var phi = Math.random() * Math.PI * 2;

    // theta = angle par rapport à la normale (0 à coneAngle)
    // Distribution uniforme dans le cône solide
    var coneAngleRad = coneAngleDeg * (Math.PI / 180);
    var theta = Math.acos(1 - Math.random() * (1 - Math.cos(coneAngleRad)));

    // Composantes trigonométriques
    var sinTheta = Math.sin(theta);
    var cosTheta = Math.cos(theta);

    // Nouvelle direction = cos(θ)·N + sin(θ)·(cos(φ)·U + sin(φ)·V)
    // Cela donne une direction aléatoire dans le cône autour de la normale
    var newDirection = new THREE.Vector3()
      .addScaledVector(direction, cosTheta)
      .addScaledVector(u, sinTheta * Math.cos(phi))
      .addScaledVector(v, sinTheta * Math.sin(phi));
    newDirection.normalize();

    // Appliquer le damping (amortissement) : réduire la vitesse après collision
    var minSpeed = this._collisionConfig.minReflectionSpeed;
    var newSpeed = Math.max(speed * dampingFactor, minSpeed);

    // Retourner le vecteur direction × vitesse
    return newDirection.multiplyScalar(newSpeed);
  },

  _pickNewTarget: function () {
    // Si on a les vraies dimensions de la pièce, les utiliser
    if (this.roomBounds && isFinite(this.roomBounds.minX) && isFinite(this.roomBounds.maxX)) {
      const margin = 0.3; // Marge pour éviter les murs
      const minX = this.roomBounds.minX + margin;
      const maxX = this.roomBounds.maxX - margin;
      const minZ = this.roomBounds.minZ + margin;
      const maxZ = this.roomBounds.maxZ - margin;
      const minY = Math.max(this.floorY + 0.3, 0.2);
      const maxY = Math.min(this.ceilingY - 0.3, this.floorY + 2.0);

      // Essayer plusieurs fois pour éviter de placer la cible dans un obstacle
      const maxAttempts = 10;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        this.target.set(
          minX + Math.random() * (maxX - minX),
          minY + Math.random() * (maxY - minY),
          minZ + Math.random() * (maxZ - minZ)
        );
        if (!this._isInsideObstacle(this.target)) break;
      }

      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🎯 New fish target:', this.target.toArray().map(v => v.toFixed(2)));
    } else {
      // Fallback: utiliser les bounds par défaut
      const b = this.bounds;
      this.target.set(
        (Math.random() - 0.5) * b * 2,
        0.2 + Math.random() * (b - 0.2),
        (Math.random() - 0.5) * b * 2 - 1.0
      );
    }
  },

  // Vérifie si un point est à l'intérieur d'un obstacle (table, meuble, etc.)
  _isInsideObstacle: function (point) {
    if (!this.obstacles || this.obstacles.length === 0) return false;
    const fishRadius = 0.03;
    for (let i = 0; i < this.obstacles.length; i++) {
      const obsData = this.obstacles[i].data;
      const bounds = obsData.bounds;
      if (!bounds) continue;
      // Volume solide pour tables : du sol à la surface
      let effectiveMinY = bounds.minY;
      let effectiveMaxY = bounds.maxY;
      const obsType = obsData.obstacleType || '';
      if (obsType === 'table' || obsType === 'meuble_bas' || obsType === 'etagere' || obsType === 'obstacle') {
        effectiveMinY = this.floorY;
        effectiveMaxY = bounds.maxY + 0.05;
      }
      const inX = point.x > bounds.minX - fishRadius && point.x < bounds.maxX + fishRadius;
      const inY = point.y > effectiveMinY - fishRadius && point.y < effectiveMaxY + fishRadius;
      const inZ = point.z > bounds.minZ - fishRadius && point.z < bounds.maxZ + fishRadius;
      if (inX && inY && inZ) return true;
    }
    return false;
  },

  _ensureInBounds: function () {
    if (!this.roomBounds || !isFinite(this.roomBounds.minX)) return;

    const pos = this.el.object3D.position;
    const margin = 0.2;

    // Garder dans les limites X, Y, Z
    if (pos.x < this.roomBounds.minX + margin) pos.x = this.roomBounds.minX + margin;
    if (pos.x > this.roomBounds.maxX - margin) pos.x = this.roomBounds.maxX - margin;
    if (pos.y < this.floorY + 0.2) pos.y = this.floorY + 0.2;
    if (pos.y > this.ceilingY - 0.2) pos.y = this.ceilingY - 0.2;
    if (pos.z < this.roomBounds.minZ + margin) pos.z = this.roomBounds.minZ + margin;
    if (pos.z > this.roomBounds.maxZ - margin) pos.z = this.roomBounds.maxZ - margin;
  },

  _checkWallCollision: function (pos, nextPos) {
    // Vérifier collision avec les murs de la pièce
    if (!this.roomBounds || !isFinite(this.roomBounds.minX)) return false;

    let collision = false;

    // Si on a une box orientée, utiliser une collision précise
    if (this.orientedBox) {
      collision = this._checkOrientedBoxCollision(pos, nextPos);
    } else {
      // Sinon, collision rectangulaire classique
      collision = this._checkAxisAlignedCollision(pos, nextPos);
    }

    return collision;
  },

  _checkOrientedBoxCollision: function (pos, nextPos) {
    const box = this.orientedBox;
    let collision = false;
    const margin = 0.2;

    // Transformer la position du poisson dans l'espace local de la box (préférer la matrice inverse)
    let localX, localZ, velLocalX, velLocalZ, cos, sin;
    if (box.inverseMatrix) {
      const local = new THREE.Vector3(nextPos.x, nextPos.y, nextPos.z).applyMatrix4(box.inverseMatrix);
      localX = local.x;
      localZ = local.z;

      // Pour la vélocité, appliquer la rotation inverse sans translation
      const rotInv = box.inverseMatrix.clone();
      rotInv.setPosition(0, 0, 0);
      const localVel = new THREE.Vector3(this.velocity.x, this.velocity.y, this.velocity.z).applyMatrix4(rotInv);
      velLocalX = localVel.x;
      velLocalZ = localVel.z;

      // Keep cos/sin for fallback world reconversion if needed
      cos = Math.cos(box.rotationY);
      sin = Math.sin(box.rotationY);
    } else {
      // Fallback to trig if no matrix provided
      const dx = nextPos.x - box.centerX;
      const dz = nextPos.z - box.centerZ;
      cos = Math.cos(box.rotationY);
      sin = Math.sin(box.rotationY);
      localX = dx * cos + dz * sin;
      localZ = -dx * sin + dz * cos;
      velLocalX = this.velocity.x * cos + this.velocity.z * sin;
      velLocalZ = -this.velocity.x * sin + this.velocity.z * cos;
    }

    // Limites locales
    const halfW = box.halfWidth - margin;
    const halfD = box.halfDepth - margin;

    // Debug: afficher coordonnées locales et limites uniquement en mode debug
    if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) {
      console.debug('🐟 COLLISION_DEBUG local:', { localX: localX.toFixed(2), localZ: localZ.toFixed(2), halfW: halfW.toFixed(2), halfD: halfD.toFixed(2) });
    }

    let correctedLocalX = localX;
    let correctedLocalZ = localZ;
    let newVelLocalX = velLocalX;
    let newVelLocalZ = velLocalZ;
    let bounced = false;

    // Normale locale combinée (pour gérer les collisions en coin)
    const localNormal = new THREE.Vector3(0, 0, 0);

    // Collision X local (left/right)
    if (localX < -halfW) {
      correctedLocalX = -halfW + 0.15;
      localNormal.x = 1; // Normale pointe vers l'intérieur (droite)
      bounced = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Bounce LEFT (oriented) - localX:', localX.toFixed(2));
    } else if (localX > halfW) {
      correctedLocalX = halfW - 0.15;
      localNormal.x = -1; // Normale pointe vers l'intérieur (gauche)
      bounced = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Bounce RIGHT (oriented) - localX:', localX.toFixed(2));
    }

    // Collision Z local (front/back)
    if (localZ < -halfD) {
      correctedLocalZ = -halfD + 0.15;
      localNormal.z = 1; // Normale pointe vers l'intérieur
      bounced = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Bounce FRONT (oriented) - localZ:', localZ.toFixed(2));
    } else if (localZ > halfD) {
      correctedLocalZ = halfD - 0.15;
      localNormal.z = -1; // Normale pointe vers l'intérieur
      bounced = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Bounce BACK (oriented) - localZ:', localZ.toFixed(2));
    }

    // Appliquer la direction aléatoire dans le cône autour de la normale (espace local)
    if (bounced) {
      localNormal.normalize();
      // Vitesse actuelle du poisson en espace local
      const localVelVec = new THREE.Vector3(velLocalX, this.velocity.y, velLocalZ);
      var localSpeed = localVelVec.length();
      // Générer une direction aléatoire dans le cône autour de la normale locale
      const newVel = this._generateConeReflection(
        localNormal,
        localSpeed,
        this._collisionConfig.coneAngle,
        this._collisionConfig.dampingFactor
      );
      // Extraire les composantes locales
      newVelLocalX = newVel.x;
      newVelLocalZ = newVel.z;
      this.velocity.y = newVel.y;
    }

    // Retransformer TOUT en coordonnées monde si collision
    if (bounced) {
      if (box.matrix) {
        // Convertir la position locale corrigée en monde
        const correctedLocal = new THREE.Vector3(correctedLocalX, nextPos.y, correctedLocalZ);
        const worldCorrected = correctedLocal.applyMatrix4(box.matrix);
        nextPos.x = worldCorrected.x;
        nextPos.z = worldCorrected.z;

        // Appliquer rotation (sans translation) pour la vélocité
        const rot = box.matrix.clone();
        rot.setPosition(0, 0, 0);
        const worldVel = new THREE.Vector3(newVelLocalX, this.velocity.y, newVelLocalZ).applyMatrix4(rot);
        this.velocity.x = worldVel.x;
        this.velocity.z = worldVel.z;
      } else {
        // Fallback trig
        nextPos.x = box.centerX + (correctedLocalX * cos - correctedLocalZ * sin);
        nextPos.z = box.centerZ + (correctedLocalX * sin + correctedLocalZ * cos);
        this.velocity.x = newVelLocalX * cos - newVelLocalZ * sin;
        this.velocity.z = newVelLocalX * sin + newVelLocalZ * cos;
      }

      collision = true;
    }

    // Sol et plafond (pas de rotation Y) — direction aléatoire dans le cône
    if (nextPos.y <= this.floorY + 0.2) {
      const floorNormal = new THREE.Vector3(0, 1, 0);
      var floorSpeed = this.velocity.length();
      const newVel = this._generateConeReflection(floorNormal, floorSpeed, this._collisionConfig.coneAngle, this._collisionConfig.dampingFactor);
      this.velocity.copy(newVel);
      nextPos.y = this.floorY + 0.25;
      collision = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Rebond SOL (cône)');
    } else if (nextPos.y >= this.ceilingY - 0.2) {
      const ceilNormal = new THREE.Vector3(0, -1, 0);
      var ceilSpeed = this.velocity.length();
      const newVel = this._generateConeReflection(ceilNormal, ceilSpeed, this._collisionConfig.coneAngle, this._collisionConfig.dampingFactor);
      this.velocity.copy(newVel);
      nextPos.y = this.ceilingY - 0.25;
      collision = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Rebond PLAFOND (cône)');
    }

    return collision;
  },

  _checkAxisAlignedCollision: function (pos, nextPos) {
    const margin = 0.15;
    let collision = false;

    // Normale combinée pour les collisions multiples (coins)
    const wallNormal = new THREE.Vector3(0, 0, 0);
    let wallHit = false;

    // Collision avec les murs X
    if (nextPos.x <= this.roomBounds.minX + margin) {
      wallNormal.x = 1; // Normale pointe vers l'intérieur (droite)
      nextPos.x = this.roomBounds.minX + margin + 0.02;
      wallHit = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Rebond mur GAUCHE (cône)');
    } else if (nextPos.x >= this.roomBounds.maxX - margin) {
      wallNormal.x = -1; // Normale pointe vers l'intérieur (gauche)
      nextPos.x = this.roomBounds.maxX - margin - 0.02;
      wallHit = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Rebond mur DROIT (cône)');
    }

    // Collision avec les murs Z
    if (nextPos.z <= this.roomBounds.minZ + margin) {
      wallNormal.z = 1; // Normale pointe vers l'intérieur
      nextPos.z = this.roomBounds.minZ + margin + 0.02;
      wallHit = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Rebond mur ARRIÈRE (cône)');
    } else if (nextPos.z >= this.roomBounds.maxZ - margin) {
      wallNormal.z = -1; // Normale pointe vers l'intérieur
      nextPos.z = this.roomBounds.maxZ - margin - 0.02;
      wallHit = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Rebond mur AVANT (cône)');
    }

    // Appliquer la direction aléatoire dans le cône pour les murs X/Z
    if (wallHit) {
      wallNormal.normalize();
      var wallSpeed = this.velocity.length();
      const newVel = this._generateConeReflection(
        wallNormal,
        wallSpeed,
        this._collisionConfig.coneAngle,
        this._collisionConfig.dampingFactor
      );
      this.velocity.copy(newVel);
      collision = true;
    }

    // Collision avec le sol et plafond (traités séparément)
    if (nextPos.y <= this.floorY + 0.2) {
      const floorNormal = new THREE.Vector3(0, 1, 0);
      var floorSpeed2 = this.velocity.length();
      const newVel = this._generateConeReflection(floorNormal, floorSpeed2, this._collisionConfig.coneAngle, this._collisionConfig.dampingFactor);
      this.velocity.copy(newVel);
      nextPos.y = this.floorY + 0.2 + 0.02;
      collision = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Rebond SOL (cône)');
    } else if (nextPos.y >= this.ceilingY - 0.2) {
      const ceilNormal = new THREE.Vector3(0, -1, 0);
      var ceilSpeed2 = this.velocity.length();
      const newVel = this._generateConeReflection(ceilNormal, ceilSpeed2, this._collisionConfig.coneAngle, this._collisionConfig.dampingFactor);
      this.velocity.copy(newVel);
      nextPos.y = this.ceilingY - 0.2 - 0.02;
      collision = true;
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔴 Rebond PLAFOND (cône)');
    }

    return collision;
  },

  _checkObstacleCollision: function (pos, nextPos) {
    // Vérifier collision avec les tables et obstacles
    if (!this.obstacles || this.obstacles.length === 0) return false;

    let collision = false;
    const fishRadius = 0.03;

    this.obstacles.forEach(obstacle => {
      const obsData = obstacle.data;
      const obsPos = obsData.position;
      const bounds = obsData.bounds;

      if (!obsPos || !bounds) return;

      // Pour les tables et meubles, créer un volume SOLIDE du sol jusqu'à la surface
      // (un poisson ne doit pas traverser la table, ni passer dessous entre les pieds)
      let effectiveMinY = bounds.minY;
      let effectiveMaxY = bounds.maxY;
      const obsType = obsData.obstacleType || '';
      if (obsType === 'table' || obsType === 'meuble_bas' || obsType === 'etagere' || obsType === 'obstacle') {
        effectiveMinY = this.floorY; // Solide depuis le sol
        effectiveMaxY = bounds.maxY + 0.05; // Petite marge au-dessus de la surface
      }

      // Calculer si le poisson entre dans le volume de l'obstacle
      const inX = nextPos.x > bounds.minX - fishRadius && nextPos.x < bounds.maxX + fishRadius;
      const inY = nextPos.y > effectiveMinY - fishRadius && nextPos.y < effectiveMaxY + fishRadius;
      const inZ = nextPos.z > bounds.minZ - fishRadius && nextPos.z < bounds.maxZ + fishRadius;

      if (inX && inY && inZ) {
        // Collision détectée ! Calculer la pénétration sur chaque axe
        // pour éjecter le poisson par la face la plus proche
        const penLeft = nextPos.x - (bounds.minX - fishRadius);
        const penRight = (bounds.maxX + fishRadius) - nextPos.x;
        const penBottom = nextPos.y - (effectiveMinY - fishRadius);
        const penTop = (effectiveMaxY + fishRadius) - nextPos.y;
        const penFront = nextPos.z - (bounds.minZ - fishRadius);
        const penBack = (bounds.maxZ + fishRadius) - nextPos.z;

        // Trouver l'axe avec la plus petite pénétration (face la plus proche)
        const pens = [
          { axis: 'x', pen: penLeft, sign: -1 },
          { axis: 'x', pen: penRight, sign: 1 },
          { axis: 'y', pen: penBottom, sign: -1 },
          { axis: 'y', pen: penTop, sign: 1 },
          { axis: 'z', pen: penFront, sign: -1 },
          { axis: 'z', pen: penBack, sign: 1 }
        ];
        pens.sort((a, b) => a.pen - b.pen);
        const best = pens[0];

        // Déterminer le vecteur normal de la face de collision
        // La normale pointe VERS L'EXTÉRIEUR de l'obstacle (direction d'éjection)
        const normal = new THREE.Vector3(0, 0, 0);

        // Éjecter le poisson par la face la plus proche (augmenté à 0.15 pour éviter blocage)
        if (best.axis === 'x') {
          if (best.sign === -1) {
            nextPos.x = bounds.minX - fishRadius - 0.15;
            normal.x = -1; // Normale vers la gauche (extérieur)
          } else {
            nextPos.x = bounds.maxX + fishRadius + 0.15;
            normal.x = 1; // Normale vers la droite (extérieur)
          }
        } else if (best.axis === 'y') {
          if (best.sign === -1) {
            nextPos.y = effectiveMinY - fishRadius - 0.15;
            normal.y = -1; // Normale vers le bas (extérieur)
          } else {
            nextPos.y = effectiveMaxY + fishRadius + 0.15;
            normal.y = 1; // Normale vers le haut (extérieur)
          }
        } else {
          if (best.sign === -1) {
            nextPos.z = bounds.minZ - fishRadius - 0.15;
            normal.z = -1; // Normale vers l'arrière (extérieur)
          } else {
            nextPos.z = bounds.maxZ + fishRadius + 0.15;
            normal.z = 1; // Normale vers l'avant (extérieur)
          }
        }

        // Appliquer la direction aléatoire dans le cône autour de la normale
        // (le poisson part dans une direction aléatoire loin de l'obstacle)
        var currentSpeed = this.velocity.length();
        const newVel = this._generateConeReflection(
          normal,
          currentSpeed,
          this._collisionConfig.coneAngle,
          this._collisionConfig.dampingFactor
        );
        this.velocity.copy(newVel);

        collision = true;
      }
    });

    return collision;
  },

  tick: function (time, delta) {
    if (!delta) return;
    if (this.el.__isGrabbed) return; // when grabbed, let controller handle it

    const dt = delta / 1000;
    const pos = this.el.object3D.position;

    // Si proche de la cible, choisir une nouvelle cible
    if (pos.distanceTo(this.target) < 0.4) this._pickNewTarget();

    // Réduire le cooldown de collision
    if (this._collisionCooldown > 0) {
      this._collisionCooldown -= dt;
    }

    // Direction désirée vers la cible
    const desired = this.target.clone().sub(pos).normalize();

    // Ajuster progressivement la vélocité vers la direction désirée
    // SAUF pendant le cooldown post-collision : le poisson garde sa direction de rebond
    const desiredVel = desired.multiplyScalar(this.speed);
    if (this._collisionCooldown <= 0) {
      this.velocity.lerp(desiredVel, Math.min(1, dt * 0.8));
    } else {
      // Pendant le cooldown, lerp très faible pour ne pas annuler le rebond
      this.velocity.lerp(desiredVel, Math.min(1, dt * 0.05));
    }

    // Ajouter un mouvement de nage latéral naturel (subtil et lent)
    this.swayPhase += dt * (0.35 + Math.random() * 0.2);
    const lateral = new THREE.Vector3().crossVectors(this.velocity, new THREE.Vector3(0, 1, 0)).normalize();
    const sway = lateral.multiplyScalar(Math.sin(this.swayPhase) * 0.01);

    // Vertical bobbing for natural up/down motion
    const verticalBob = Math.sin(this.swayPhase * 0.6 + this.bobOffset) * this.bobAmplitude;

    // Occasionally adjust target.y slightly so fish change cruising altitude over time
    if (this.roomBounds && Math.random() < dt * 0.25) {
      const minY = this.floorY + 0.2;
      const maxY = this.ceilingY - 0.2;
      this.target.y = Math.max(minY, Math.min(maxY, this.target.y + (Math.random() - 0.5) * 0.6));
    }

    // Calculer la prochaine position
    const nextPos = pos.clone();
    nextPos.addScaledVector(this.velocity, dt);
    nextPos.addScaledVector(sway, 1);

    // Vérifier les collisions avec les murs de la pièce
    const wallHit = this._checkWallCollision(pos, nextPos);

    // Vérifier les collisions avec les obstacles (tables, etc.)
    const obstacleHit = this._checkObstacleCollision(pos, nextPos);

    // Si collision, placer la cible DANS LA DIRECTION DU REBOND pour éviter le ping-pong
    if (wallHit || obstacleHit) {
      // Activer le cooldown : le poisson garde sa direction de rebond pendant 1.5s
      this._collisionCooldown = 1.5;

      // Placer la cible dans la direction de la vélocité post-rebond (loin du mur)
      const reboundDir = this.velocity.clone().normalize();
      const distToTarget = 1.5 + Math.random() * 2.0; // 1.5 à 3.5m devant
      this.target.copy(pos).addScaledVector(reboundDir, distToTarget);

      // Clamper la cible dans les bounds pour qu'elle ne sorte pas de la pièce
      if (this.roomBounds && isFinite(this.roomBounds.minX)) {
        const m = 0.4;
        this.target.x = Math.max(this.roomBounds.minX + m, Math.min(this.roomBounds.maxX - m, this.target.x));
        this.target.z = Math.max(this.roomBounds.minZ + m, Math.min(this.roomBounds.maxZ - m, this.target.z));
        this.target.y = Math.max(this.floorY + 0.3, Math.min(this.ceilingY - 0.3, this.target.y));
      }
    }

    // Apply vertical bob before finalizing position
    nextPos.y += verticalBob;

    // Appliquer la position finale
    pos.copy(nextPos);

    // SÉCURITÉ FINALE: Forcer le poisson à rester strictement dans les bounds
    // Utilise le cône de réflexion au lieu d'un simple flip pour garder une direction naturelle
    if (this.roomBounds && isFinite(this.roomBounds.minX)) {
      const safeMar = 0.1;
      let safetyBounce = false;
      const safeNormal = new THREE.Vector3(0, 0, 0);

      if (pos.x < this.roomBounds.minX + safeMar) {
        pos.x = this.roomBounds.minX + safeMar;
        safeNormal.x += 1;
        safetyBounce = true;
      }
      if (pos.x > this.roomBounds.maxX - safeMar) {
        pos.x = this.roomBounds.maxX - safeMar;
        safeNormal.x += -1;
        safetyBounce = true;
      }
      if (pos.y < this.floorY + 0.15) {
        pos.y = this.floorY + 0.15;
        safeNormal.y += 1;
        safetyBounce = true;
      }
      if (pos.y > this.ceilingY - 0.15) {
        pos.y = this.ceilingY - 0.15;
        safeNormal.y += -1;
        safetyBounce = true;
      }
      if (pos.z < this.roomBounds.minZ + safeMar) {
        pos.z = this.roomBounds.minZ + safeMar;
        safeNormal.z += 1;
        safetyBounce = true;
      }
      if (pos.z > this.roomBounds.maxZ - safeMar) {
        pos.z = this.roomBounds.maxZ - safeMar;
        safeNormal.z += -1;
        safetyBounce = true;
      }

      // Appliquer le cône de réflexion pour la sécurité aussi
      if (safetyBounce) {
        safeNormal.normalize();
        var safeSpeed = this.velocity.length();
        var safeVel = this._generateConeReflection(safeNormal, safeSpeed, this._collisionConfig.coneAngle, this._collisionConfig.dampingFactor);
        this.velocity.copy(safeVel);
        this._collisionCooldown = 1.5;

        // Replacer la cible dans la direction du rebond
        var safeDir = this.velocity.clone().normalize();
        this.target.copy(pos).addScaledVector(safeDir, 1.0);
        if (this.roomBounds) {
          var sm = 0.4;
          this.target.x = Math.max(this.roomBounds.minX + sm, Math.min(this.roomBounds.maxX - sm, this.target.x));
          this.target.z = Math.max(this.roomBounds.minZ + sm, Math.min(this.roomBounds.maxZ - sm, this.target.z));
          this.target.y = Math.max(this.floorY + 0.3, Math.min(this.ceilingY - 0.3, this.target.y));
        }
      }
    }

    // Rotation douce pour faire face à la direction du mouvement
    if (this.velocity.lengthSq() > 0.0001) {
      // Contrainte: limiter l'inclinaison (pitch) pour éviter que le poisson se retourne
      const maxPitch = Math.PI / 4; // 45° max up/down

      // Compute desired direction from velocity
      const vel = this.velocity.clone();
      const horizLen = Math.sqrt(vel.x * vel.x + vel.z * vel.z);

      // If mostly vertical, prefer small horizontal component to avoid flip
      const safeHoriz = Math.max(horizLen, 0.0001);
      const maxY = Math.tan(maxPitch) * safeHoriz;

      // Clamp vertical component to allowed pitch
      const clampedY = Math.max(-maxY, Math.min(maxY, vel.y));
      const constrainedDir = new THREE.Vector3(vel.x, clampedY, vel.z).normalize();

      // Build a look target using constrained direction
      const lookTarget = pos.clone().add(constrainedDir);

      // Smoothly interpolate rotation towards constrained lookTarget
      const currentQuat = this.el.object3D.quaternion.clone();
      this.el.object3D.lookAt(lookTarget);
      const targetQuat = this.el.object3D.quaternion.clone();
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

    console.debug('🐟 Fish-spawner INIT - count:', this.data.count);

    // Wait for room scan: store room data but defer actual spawning until startSpawn() is called
    this._pendingRoomData = null;
    this.el.sceneEl.addEventListener('room-scanned', (e) => {
      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🔔 Fish-spawner received room-scanned — storing room data (spawn deferred until PLAY)');
      // store for later
      this._pendingRoomData = e.detail;
      // if already spawned, reposition
      if (this.spawned) {
        this._repositionFishes(e.detail);
      }
    });

    // FALLBACK: if no scan after 20s, prepare sensible default data but still defer spawning until PLAY
    setTimeout(() => {
      if (!this.spawned && !this._pendingRoomData) {
        if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.warn('⚠️ No room-scanned after 20s — using fallback room data (spawn deferred)');
        this._pendingRoomData = {
          centerX: 0,
          centerZ: -2,
          width: 4,
          depth: 4,
          height: 2.5,
          floorY: 0,
          bounds: { minX: -2, maxX: 2, minZ: -3, maxZ: 1 }
        };
      }
    }, 20000);

    console.debug('🐟 Fish-spawner: attente du scan de la pièce...');
  },

  _spawnFishesInRoom: function (roomData) {
    console.debug('🚀 DÉBUT SPAWN - spawned:', this.spawned, 'count:', this.data.count);
    console.debug('   roomData:', roomData);

    if (this.spawned) {
      console.warn('⚠️ SPAWN ANNULÉ - déjà spawné !');
      return;
    }

    this.spawned = true;
    // Track initial spawn metadata to avoid premature end-game detection
    this._initialFishCount = this.data.count || 0;
    this._spawnStartTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    console.debug('✅ Flag spawned = true');

    const floorY = roomData.floorY || 0;
    const height = roomData.height || 2.5;

    // UTILISER LES BOUNDS RÉELS du sol détecté
    const bounds = roomData.bounds || {
      minX: -2, maxX: 2,
      minZ: -3, maxZ: 1
    };

    // Ajouter une marge de sécurité pour éviter les murs
    const margin = 0.3;
    const minX = bounds.minX + margin;
    const maxX = bounds.maxX - margin;
    const minZ = bounds.minZ + margin;
    const maxZ = bounds.maxZ - margin;
    const minY = floorY + 0.3;
    const maxY = floorY + height - 0.4;

    // Stocker les infos de la box orientée si disponible
    this.orientedBox = roomData.orientedBox || null;

    // Stocker aussi dans la variable globale pour que fish-movement y accède
    window.FISH_ZONE.orientedBox = this.orientedBox;
    window.FISH_ZONE.floorY = floorY;
    window.FISH_ZONE.ceilingY = maxY;

    // Stocker pour le mouvement
    this.roomBounds = { minX, maxX, minY, maxY, minZ, maxZ };
    window.FISH_ZONE.roomBounds = this.roomBounds;
    this.floorY = floorY;
    this.ceilingY = maxY;

    // Stocker les obstacles (tables, meubles) pour la collision et le spawn
    this.obstacles = roomData.obstaclePlanes || [];
    window.FISH_ZONE.obstacles = this.obstacles;

    const scene = this.el.sceneEl;
    const parent = document.querySelector('#world-anchor') || scene;

    console.debug(`🐟 Spawn de ${this.data.count} poissons dans la pièce détectée:`);
    console.debug(`   Bounds RÉELS du sol:`);
    console.debug(`   Limites X: ${minX.toFixed(2)} à ${maxX.toFixed(2)} (largeur: ${(maxX - minX).toFixed(2)}m)`);
    console.debug(`   Limites Y: ${minY.toFixed(2)} à ${maxY.toFixed(2)} (hauteur: ${(maxY - minY).toFixed(2)}m)`);
    console.debug(`   Limites Z: ${minZ.toFixed(2)} à ${maxZ.toFixed(2)} (profondeur: ${(maxZ - minZ).toFixed(2)}m)`);

    if (this.orientedBox) {
      console.log(`   ✅ Zone ORIENTÉE - rotation: ${(this.orientedBox.rotationY * 180 / Math.PI).toFixed(1)}°`);
    }

    for (let i = 0; i < this.data.count; i++) {
      const fish = document.createElement('a-entity');
      // Replace placeholder box with one of the real glTF fish models
      // Use the renamed/organized fish model IDs so the specific fishes are visible
      // Removed #dory and #nemo as requested (they caused interaction issues)
      const models = ['#thon', '#piranha', '#goldfish', '#thon_bleu'];
      const chosen = models[Math.floor(Math.random() * models.length)];
      fish.setAttribute('gltf-model', chosen);
      const baseScale = (0.6 + Math.random() * 0.6) / 72.0; // ~0.0083 - 0.0167
      const defaultMultiplier = 4.0;
      const modelScaleAdjust = {
        '#goldfish': 0.5,
        '#thon': 0.5
      };
      const adjust = (modelScaleAdjust.hasOwnProperty(chosen)) ? modelScaleAdjust[chosen] : defaultMultiplier;
      const finalScale = baseScale * adjust;
      fish.setAttribute('scale', `${finalScale} ${finalScale} ${finalScale}`);
      // Slight random rotation so models don't all look identical
      const rx = (Math.random() - 0.5) * 20;
      const ry = (Math.random() - 0.5) * 180;
      const rz = (Math.random() - 0.5) * 20;
      fish.setAttribute('rotation', `${rx} ${ry} ${rz}`);

      // Position aléatoire DANS la zone orientée ou les bounds
      let x, y, z;

      if (this.orientedBox) {
        // Spawner dans l'espace local de la box orientée
        const box = this.orientedBox;
        const spawnMargin = 0.3;
        // No per-model shrink factors needed now (dory/nemo removed)
        const shrinkFactor = 1.0;
        const localX = (Math.random() - 0.5) * (box.width - spawnMargin * 2) * shrinkFactor;
        const localZ = (Math.random() - 0.5) * (box.depth - spawnMargin * 2) * shrinkFactor;

        // Transformer en coordonnées monde en utilisant la matrice fournie par room-detection si disponible
        const localVec = new THREE.Vector3(localX, 0, localZ);
        if (box.matrix) {
          const worldVec = localVec.clone().applyMatrix4(box.matrix);
          x = worldVec.x;
          z = worldVec.z;
        } else {
          const cos = Math.cos(box.rotationY);
          const sin = Math.sin(box.rotationY);
          // local -> world : x = cx + xl*cos - zl*sin ; z = cz + xl*sin + zl*cos
          x = box.centerX + (localX * cos - localZ * sin);
          z = box.centerZ + (localX * sin + localZ * cos);
        }
        y = minY + Math.random() * (maxY - minY);

        // Vérification: recalculer local coords depuis world pour valider l'appartenance
        let localX_check = localX;
        let localZ_check = localZ;
        if (box.inverseMatrix) {
          const w = new THREE.Vector3(x, 0, z).applyMatrix4(box.inverseMatrix);
          localX_check = w.x;
          localZ_check = w.z;
        }
        const inside = Math.abs(localX_check) <= (box.halfWidth - 0.25) && Math.abs(localZ_check) <= (box.halfDepth - 0.25);
        if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) {
          console.debug(`🐟 Fish #${i + 1} spawned (oriented) at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) inside:${inside}`);
        }
      } else {
        // Spawner classique dans les bounds rectangulaires
        // No per-model shrink factors needed now (dory/nemo removed)
        const shrinkFactor = 1.0;
        const centerX_rect = (minX + maxX) / 2;
        const centerZ_rect = (minZ + maxZ) / 2;
        const rangeX = (maxX - minX) * shrinkFactor;
        const rangeZ = (maxZ - minZ) * shrinkFactor;
        x = centerX_rect - rangeX / 2 + Math.random() * rangeX;
        z = centerZ_rect - rangeZ / 2 + Math.random() * rangeZ;
        y = minY + Math.random() * (maxY - minY);

        if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) {
          console.debug(`🐟 Fish #${i + 1} spawned (bounds) at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
        }
      }
      // Ensure the spawn position is strictly inside the room bounds (fix fish outside zone)
      // Pass the chosen model so we can apply per-model extra margins (for models with large pivots)
      let clamped = this._clampSpawnPosition({ x, y, z }, chosen);
      if (clamped.x !== x || clamped.y !== y || clamped.z !== z) {
        if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) {
          console.debug(`⚙️ Fish #${i + 1} position corrected -> (${clamped.x.toFixed(2)}, ${clamped.y.toFixed(2)}, ${clamped.z.toFixed(2)})`);
        }
      }

      // Vérifier que le poisson ne spawn pas dans un obstacle (table, meuble)
      if (this._isSpawnInsideObstacle(clamped)) {
        // Réessayer jusqu'à 15 fois pour trouver une position hors obstacle
        for (let attempt = 0; attempt < 15; attempt++) {
          const retryX = minX + Math.random() * (maxX - minX);
          const retryY = minY + Math.random() * (maxY - minY);
          const retryZ = minZ + Math.random() * (maxZ - minZ);
          const retryClamped = this._clampSpawnPosition({ x: retryX, y: retryY, z: retryZ }, chosen);
          if (!this._isSpawnInsideObstacle(retryClamped)) {
            clamped = retryClamped;
            break;
          }
        }
      }
      fish.setAttribute('position', `${clamped.x} ${clamped.y} ${clamped.z}`);

      // Mark as fish, collision target and grabbable
      fish.classList.add('fish');
      fish.classList.add('fish-target');
      fish.setAttribute('grabbable', '');
      // set data-fish-type so scoring can identify the fish
      try {
        const typeName = chosen.replace('#', '');
        fish.setAttribute('data-fish-type', typeName);
      } catch (e) { }

      // Add movement component (slightly increased so fishes can escape walls)
      // Make fishes ultra-slow overall but a bit faster than before: range ~0.00001 - 0.00003
      const baseSpeed = 0.00001 + Math.random() * 0.00002; // 0.00001 - 0.00003
      fish.setAttribute('fish-movement', `speed: ${baseSpeed}; bounds: ${this.data.area}`);

      parent.appendChild(fish);
      this.fishes.push(fish);
    }

    console.debug(`✅ ${this.fishes.length} fishes created and added to the scene.`);
    if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) {
      console.debug('   Parent:', parent.id || parent.tagName);
      console.debug('   First 3 positions:', this.fishes.slice(0, 3).map(f => {
        const pos = f.getAttribute('position');
        return `(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`;
      }));
    }
    // Start observing remaining fish so we can end the game early when none remain
    try { this._startFishRemainingObserver(parent); } catch (e) { /* ignore */ }
  },

  _startFishRemainingObserver: function (parent) {
    // Observe removals of fish-target nodes and trigger end-game when none remain
    try {
      if (this._observer) this._observer.disconnect();
      const checkAndEnd = () => {
        const remaining = (parent.querySelectorAll && parent.querySelectorAll('.fish-target')) ? parent.querySelectorAll('.fish-target').length : (this.fishes ? this.fishes.length : 0);
        if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.debug('🐟 fish-spawner: remaining fish count =', remaining);

        // Avoid false positives right after spawn: require that the spawn has occurred and
        // a short grace period elapsed before considering the game ended due to 0 fishes.
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const spawnAge = this._spawnStartTime ? (now - this._spawnStartTime) : Infinity;

        if (remaining === 0 && this._initialFishCount > 0 && spawnAge > 1500) {
          // If game is active, end it (show recap like time end)
          if (window.gameTimer && window.gameTimer.isGameActive && window.gameTimer.isGameActive()) {
            try { window.gameTimer.endGame(); } catch (e) { console.warn('fish-spawner: failed to call endGame', e); }
          }
        }
      };

      // Initial check
      checkAndEnd();

      // MutationObserver to watch for removed children
      this._observer = new MutationObserver((mutationsList) => {
        for (const m of mutationsList) {
          if (m.type === 'childList' && (m.removedNodes && m.removedNodes.length > 0)) {
            checkAndEnd();
            break;
          }
        }
      });
      this._observer.observe(parent, { childList: true, subtree: true });
    } catch (e) { /* ignore observer failures */ }
  },

  _repositionFishes: function (roomData) {
    // Utiliser centerX/centerZ et width/depth au lieu des bounds (plus fiable)
    const centerX = roomData.centerX || 0;
    const centerZ = roomData.centerZ || -2;
    const width = roomData.width || 4;
    const depth = roomData.depth || 4;
    const height = roomData.height || 2.5;
    const floorY = roomData.floorY || 0;

    // Calculer les vraies limites
    const minX = centerX - width / 2;
    const maxX = centerX + width / 2;
    const minZ = centerZ - depth / 2;
    const maxZ = centerZ + depth / 2;
    const minY = floorY + 0.2;
    const maxY = floorY + height - 0.3;

    // Stocker pour le mouvement
    this.roomBounds = { minX, maxX, minY, maxY, minZ, maxZ };
    this.floorY = floorY;
    this.ceilingY = maxY;

    if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) {
      console.debug('🔄 Repositioning fishes to new room bounds:');
      console.log(`   X: ${minX.toFixed(2)} to ${maxX.toFixed(2)}`);
      console.log(`   Y: ${minY.toFixed(2)} to ${maxY.toFixed(2)}`);
      console.log(`   Z: ${minZ.toFixed(2)} to ${maxZ.toFixed(2)}`);
    }

    this.fishes.forEach((fish, i) => {
      const margin = 0.3;
      const x = minX + margin + Math.random() * (maxX - minX - margin * 2);
      const y = minY + 0.2 + Math.random() * (maxY - minY - 0.4);
      const z = minZ + margin + Math.random() * (maxZ - minZ - margin * 2);

      if (this.el.sceneEl && this.el.sceneEl.is && this.el.sceneEl.is('debug')) console.log(`🔄 Fish #${i + 1} repositioned to (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
      fish.setAttribute('position', `${x} ${y} ${z}`);
    });
  },

  // Public API: start spawning using stored pending room data (called when player presses PLAY)
  startSpawn: function () {
    if (this.spawned) return;
    const roomData = this._pendingRoomData || { centerX: 0, centerZ: -2, width: 4, depth: 4, height: 2.5, floorY: 0, bounds: { minX: -2, maxX: 2, minZ: -3, maxZ: 1 } };
    this._spawnFishesInRoom(roomData);
    // clear pending
    this._pendingRoomData = null;
  },

  _clampSpawnPosition: function (pos, modelId) {
    // If we have an orientedBox, clamp in local coordinates then convert back to world
    if (this.orientedBox) {
      const box = this.orientedBox;
      // Convert world pos to local using inverseMatrix if available
      let local = new THREE.Vector3(pos.x, pos.y, pos.z);
      if (box.inverseMatrix) {
        local = local.applyMatrix4(box.inverseMatrix);
      } else {
        const cos = Math.cos(box.rotationY);
        const sin = Math.sin(box.rotationY);
        const dx = pos.x - box.centerX;
        const dz = pos.z - box.centerZ;
        local.x = dx * cos + dz * sin;
        local.z = -dx * sin + dz * cos;
      }

      // Per-model extra margin (some models have large visual extents/pivots)
      const perModelExtra = {
        '#thon_bleu': 0.1,
        '#piranha': 0.0,
        '#goldfish': 0.1,
        '#thon': 0.1
      };
      const extra = perModelExtra[modelId] || 0;

      // Clamp in local space with a small base margin + per-model extra
      const baseMargin = 0.15;
      const margin = baseMargin + extra;
      const halfW = box.halfWidth - margin;
      const halfD = box.halfDepth - margin;
      local.x = Math.max(-halfW, Math.min(halfW, local.x));
      local.z = Math.max(-halfD, Math.min(halfD, local.z));
      // Clamp Y between floor and ceiling
      const minY = this.floorY + 0.2 + extra; // push slightly higher for big fish
      const maxY = this.ceilingY - 0.2 - extra;
      const clampedY = Math.max(minY, Math.min(maxY, pos.y));

      // Convert back to world
      let world = new THREE.Vector3(local.x, clampedY, local.z);
      if (box.matrix) {
        world = world.applyMatrix4(box.matrix);
      } else {
        const cos = Math.cos(box.rotationY);
        const sin = Math.sin(box.rotationY);
        world.x = box.centerX + (local.x * cos - local.z * sin);
        world.z = box.centerZ + (local.x * sin + local.z * cos);
        world.y = clampedY;
      }
      return { x: world.x, y: world.y, z: world.z };
    }

    // Axis-aligned bounds fallback
    if (this.roomBounds && isFinite(this.roomBounds.minX)) {
      const perModelExtra = {
        '#thon_bleu': 0.1,
        '#piranha': 0.0,
        '#goldfish': 0.1,
        '#thon': 0.1
      };
      const extra = perModelExtra[modelId] || 0;
      const safeMar = 0.15 + extra;
      const x = Math.max(this.roomBounds.minX + safeMar, Math.min(this.roomBounds.maxX - safeMar, pos.x));
      const y = Math.max(this.roomBounds.minY + safeMar, Math.min(this.roomBounds.maxY - safeMar, pos.y));
      const z = Math.max(this.roomBounds.minZ + safeMar, Math.min(this.roomBounds.maxZ - safeMar, pos.z));
      return { x, y, z };
    }

    // No bounds available, return original
    return pos;
  },

  _randomColor: function () {
    const palette = ['#f39c12', '#e74c3c', '#1abc9c', '#3498db', '#9b59b6', '#f1c40f'];
    return palette[Math.floor(Math.random() * palette.length)];
  },

  // Vérifie si une position de spawn est à l'intérieur d'un obstacle (table, meuble)
  _isSpawnInsideObstacle: function (pos) {
    if (!this.obstacles || this.obstacles.length === 0) return false;
    const fishRadius = 0.05; // Marge réduite pour le spawn
    for (let i = 0; i < this.obstacles.length; i++) {
      const obsData = this.obstacles[i].data;
      const bounds = obsData.bounds;
      if (!bounds) continue;
      // Volume solide pour tables : du sol à la surface
      let effectiveMinY = bounds.minY;
      let effectiveMaxY = bounds.maxY;
      const obsType = obsData.obstacleType || '';
      if (obsType === 'table' || obsType === 'meuble_bas' || obsType === 'etagere' || obsType === 'obstacle') {
        effectiveMinY = this.floorY;
        effectiveMaxY = bounds.maxY + 0.1;
      }
      const inX = pos.x > bounds.minX - fishRadius && pos.x < bounds.maxX + fishRadius;
      const inY = pos.y > effectiveMinY - fishRadius && pos.y < effectiveMaxY + fishRadius;
      const inZ = pos.z > bounds.minZ - fishRadius && pos.z < bounds.maxZ + fishRadius;
      if (inX && inY && inZ) return true;
    }
    return false;
  }
});
