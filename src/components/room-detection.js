// COMPOSANT ROOM-DETECTION : Détection de l'environnement XR
AFRAME.registerComponent('room-detection', {
  schema: {
    debug: { type: 'boolean', default: true },
    scanDuration: { type: 'number', default: 15000 },
    showPlanes: { type: 'boolean', default: true },
    continuousDetection: { type: 'boolean', default: true },
    enableTest: { type: 'boolean', default: false }
  },

  init: function () {
    this.roomBounds = {
      minX: Infinity, maxX: -Infinity,
      minY: Infinity, maxY: -Infinity,
      minZ: Infinity, maxZ: -Infinity
    };

    this.detectedPlanes = new Map();
    this.floorPlanes = [];
    this.ceilingPlanes = [];
    this.wallPlanes = [];
    this.obstaclePlanes = [];
    this.openings = [];

    this.hitTestSource = null;
    this.controllerHitTestSource = null;
    this.hitTestSourceRequested = false;
    this.controllerHitTestRequested = false;
    this.hitSurfaces = new Map();
    this.cursorEl = null;

    this.planeMeshes = [];
    this.isScanning = false;
    this.scanComplete = false;
    this.scanStartTime = 0;
    this.floorY = 0;

    this.xrSession = null;
    this.xrRefSpace = null;
    this.xrSessionRequested = false;
    this._pendingVisualRebuild = false;
    this._resetDeltaMatrix = null;
    this._refSpaceResetHandler = null;

    this.createScanUI();
    this.el.sceneEl.addEventListener('enter-vr', this.onEnterXR.bind(this));
    this.el.sceneEl.addEventListener('exit-vr', this.onExitXR.bind(this));

    // Mode test : émettre des données simulées si WebXR absent
    let self = this;
    setTimeout(async function () {
      try {
        let urlParams = (typeof window !== 'undefined' && window.location && window.location.search)
          ? new URLSearchParams(window.location.search)
          : null;
        let allowParam = urlParams ? (urlParams.get('allowTest') === '1' || urlParams.get('allowTest') === 'true') : false;
        let allowTest = self.data.enableTest || allowParam;

        if (!allowTest) return; // pas d'émission automatique de test

        // N'émettre des données de test que si WebXR est absent (PC dev)
        if ('xr' in navigator) return;
      } catch (e) {
        // ignore
        return;
      }

      if (!self.xrSession && !self.xrSessionRequested && !self.scanComplete && !self.isScanning) {
        console.warn('⚠️ WebXR non présent — émission de données de test pour le développement PC');
        self.emitTestRoomData();
      }
    }, 8000);
  },

  emitTestRoomData: function () {
    this.scanComplete = true;
    let testData = {
      bounds: {
        minX: -3, maxX: 3,
        minY: 0, maxY: 2.5,
        minZ: -4, maxZ: 0
      },
      width: 6,
      depth: 4,
      height: 2.5,
      centerX: 0,
      centerZ: -2,
      floorY: 0,
      floorPlanes: [],
      wallPlanes: [],
      obstaclePlanes: [],
      ceilingPlanes: [],
      allPlanes: new Map()
    };

    this.createTestBoundingBox(testData);
    this.el.sceneEl.emit('room-scanned', testData);
  },

  createTestBoundingBox: function (data) {
    this.createSpawnZoneBoundingBox(data);
  },

  createSpawnZoneBoundingBox: function (data) {
    let oldBox = document.querySelector('#spawn-zone-bounds');
    if (oldBox) oldBox.parentNode.removeChild(oldBox);

    // Si on a le polygone du sol, calculer les VRAIS bounds à partir des vertices transformés
    if (data.floorPolygon && data.floorPolygon.length >= 3 && data.floorPose) {
      this.createBoxFromPolygon(data);
    } else {
      // Sinon, utiliser une box standard (mode test)
      this.createStandardBox(data);
    }
  },

  createBoxFromPolygon: function (data) {
    let polygon = data.floorPolygon;
    let pose = data.floorPose;
    let height = data.height;

    // Matrice de transformation locale -> monde
    let matrix = new THREE.Matrix4();
    matrix.fromArray(pose.transform.matrix);

    // Calculer les bounds dans l'espace LOCAL du plan (avant transformation)
    let localMinX = Infinity, localMaxX = -Infinity;
    let localMinZ = Infinity, localMaxZ = -Infinity;

    polygon.forEach(function (v) {
      localMinX = Math.min(localMinX, v.x);
      localMaxX = Math.max(localMaxX, v.x);
      localMinZ = Math.min(localMinZ, v.z);
      localMaxZ = Math.max(localMaxZ, v.z);
    });

    // Dimensions dans l'espace local
    let width = localMaxX - localMinX;
    let depth = localMaxZ - localMinZ;
    let localCenterX = (localMinX + localMaxX) / 2;
    let localCenterZ = (localMinZ + localMaxZ) / 2;

    // Transformer le centre local en monde
    let centerWorld = new THREE.Vector3(localCenterX, 0, localCenterZ);
    centerWorld.applyMatrix4(matrix);

    // Calculer la rotation Y depuis les arêtes RÉELLES transformées
    // (pas de gimbal lock comme avec Euler pour les plans horizontaux)
    let cornerA = new THREE.Vector3(localMinX, 0, localMinZ);
    let cornerB = new THREE.Vector3(localMaxX, 0, localMinZ);
    cornerA.applyMatrix4(matrix);
    cornerB.applyMatrix4(matrix);
    // Direction de l'arête "width" dans le monde (projection XZ)
    let edgeDx = cornerB.x - cornerA.x;
    let edgeDz = cornerB.z - cornerA.z;
    // A-Frame: rotation Y de θ° → local X pointe vers (cosθ, 0, -sinθ)
    let rotationYDeg = THREE.MathUtils.radToDeg(Math.atan2(-edgeDz, edgeDx));
    let rotationYRad = Math.atan2(-edgeDz, edgeDx);

    // Calculer les bounds RÉELS en monde (AABB pour collisions rapides)
    let realMinX = Infinity, realMaxX = -Infinity;
    let realMinZ = Infinity, realMaxZ = -Infinity;

    polygon.forEach(function (v) {
      let vec = new THREE.Vector3(v.x, v.y, v.z);
      vec.applyMatrix4(matrix);
      realMinX = Math.min(realMinX, vec.x);
      realMaxX = Math.max(realMaxX, vec.x);
      realMinZ = Math.min(realMinZ, vec.z);
      realMaxZ = Math.max(realMaxZ, vec.z);
    });

    // AABB bounds (pour collisions rapides)
    data.bounds = {
      minX: realMinX,
      maxX: realMaxX,
      minZ: realMinZ,
      maxZ: realMaxZ
    };

    // Box orientée (pour collisions précises des poissons)
    data.orientedBox = {
      centerX: centerWorld.x,
      centerZ: centerWorld.z,
      width: width,
      depth: depth,
      rotationY: rotationYRad,
      halfWidth: width / 2,
      halfDepth: depth / 2,
      localMinX: localMinX,
      localMaxX: localMaxX,
      localMinZ: localMinZ,
      localMaxZ: localMaxZ
    };

    // Stocker la matrice de transformation du plan (local -> world) et son inverse
    data.orientedBox.matrix = matrix.clone();
    data.orientedBox.inverseMatrix = new THREE.Matrix4().copy(matrix).invert();

    // Créer la box rouge ORIENTÉE
    let box = document.createElement('a-box');
    box.setAttribute('id', 'spawn-zone-bounds');
    box.setAttribute('position', centerWorld.x + ' ' + (data.floorY + height / 2) + ' ' + centerWorld.z);
    box.setAttribute('rotation', '0 ' + rotationYDeg + ' 0');
    box.setAttribute('width', width);
    box.setAttribute('height', height);
    box.setAttribute('depth', depth);
    box.setAttribute('material', 'color: #ff0000; opacity: 0.12; transparent: true; wireframe: true; side: double');
    box.setAttribute('geometry', 'primitive: box');

    console.log('[box-spawn]', 'center:', centerWorld.x.toFixed(2), centerWorld.z.toFixed(2),
      'rotY:', rotationYDeg.toFixed(1) + '°',
      'size:', width.toFixed(2), 'x', depth.toFixed(2),
      'edge dir:', edgeDx.toFixed(3), edgeDz.toFixed(3));

    this.el.sceneEl.appendChild(box);
  },

  createStandardBox: function (data) {
    // Box rectangulaire (MÊME ZONE que pour les collisions des poissons)
    let bounds = data.bounds || {};
    let centerX = (bounds.minX + bounds.maxX) / 2;
    let centerZ = (bounds.minZ + bounds.maxZ) / 2;
    let width = bounds.maxX - bounds.minX;
    let depth = bounds.maxZ - bounds.minZ;

    let box = document.createElement('a-box');
    box.setAttribute('id', 'spawn-zone-bounds');
    box.setAttribute('position', centerX + ' ' + (data.floorY + data.height / 2) + ' ' + centerZ);
    box.setAttribute('width', width);
    box.setAttribute('height', data.height);
    box.setAttribute('depth', depth);
    box.setAttribute('material', 'color: #ff0000; opacity: 0.12; transparent: true; wireframe: true; side: double');
    box.setAttribute('geometry', 'primitive: box');

    this.el.sceneEl.appendChild(box);
  },

  createScanUI: function () {
    this.scanPanel = document.createElement('a-entity');
    this.scanPanel.setAttribute('id', 'scan-panel');
    this.scanPanel.setAttribute('position', '0 1.5 -1.5');
    this.scanPanel.setAttribute('visible', 'false');

    // Fond du panneau
    let background = document.createElement('a-plane');
    background.setAttribute('width', '1.4');
    background.setAttribute('height', '0.7');
    background.setAttribute('color', '#000');
    background.setAttribute('opacity', '0.85');
    background.setAttribute('shader', 'flat');
    this.scanPanel.appendChild(background);

    // Titre
    this.scanTitle = document.createElement('a-text');
    this.scanTitle.setAttribute('value', '🔍 SCANNING ROOM');
    this.scanTitle.setAttribute('align', 'center');
    this.scanTitle.setAttribute('color', '#00ff00');
    this.scanTitle.setAttribute('width', '2.2');
    this.scanTitle.setAttribute('position', '0 0.22 0.01');
    this.scanPanel.appendChild(this.scanTitle);

    // Texte d'instructions
    this.scanText = document.createElement('a-text');
    this.scanText.setAttribute('value', 'Look at surfaces\nPoint the controller at tables');
    this.scanText.setAttribute('align', 'center');
    this.scanText.setAttribute('color', '#ffffff');
    this.scanText.setAttribute('width', '1.8');
    this.scanText.setAttribute('position', '0 0.06 0.01');
    this.scanPanel.appendChild(this.scanText);

    // Compteur de surfaces
    this.surfaceCount = document.createElement('a-text');
    this.surfaceCount.setAttribute('value', 'Surfaces: 0');
    this.surfaceCount.setAttribute('align', 'center');
    this.surfaceCount.setAttribute('color', '#00ffff');
    this.surfaceCount.setAttribute('width', '1.5');
    this.surfaceCount.setAttribute('position', '0 -0.08 0.01');
    this.scanPanel.appendChild(this.surfaceCount);

    // Fond barre de progression
    let progressBg = document.createElement('a-plane');
    progressBg.setAttribute('width', '1.1');
    progressBg.setAttribute('height', '0.05');
    progressBg.setAttribute('color', '#333');
    progressBg.setAttribute('position', '0 -0.26 0.01');
    this.scanPanel.appendChild(progressBg);

    // Barre de progression
    this.progressBar = document.createElement('a-plane');
    this.progressBar.setAttribute('width', '0.01');
    this.progressBar.setAttribute('height', '0.05');
    this.progressBar.setAttribute('color', '#00ff00');
    this.progressBar.setAttribute('position', '-0.545 -0.26 0.02');
    this.scanPanel.appendChild(this.progressBar);

    this.el.sceneEl.appendChild(this.scanPanel);
  },

  onEnterXR: function () {
    this.xrSessionRequested = true;
    console.log('[laser] 🎮 Entrée en XR détectée');

    // Réactiver les lasers avec un délai simple
    let self = this;
    setTimeout(function () {
      self.ensureLaserControlsActive();
    }, 2000);

    if (this.scanComplete) {
      this.initializeXRSession(true);
      return;
    }

    // Réinitialiser l'état de scan et les données globales
    try {
      if (window && window.FISH_ZONE) {
        window.FISH_ZONE.roomBounds = null;
        window.FISH_ZONE.orientedBox = null;
        window.FISH_ZONE.floorY = 0;
        window.FISH_ZONE.ceilingY = 2.5;
        window.FISH_ZONE.obstacles = [];
        window.FISH_ZONE.wallPlanes = [];
        window.FISH_ZONE.scanned = false;
      }
    } catch (e) {
      // ignore
    }

    // Réinitialiser l'état interne
    this.detectedPlanes = new Map();
    this.floorPlanes = [];
    this.ceilingPlanes = [];
    this.wallPlanes = [];
    this.obstaclePlanes = [];
    this.hitSurfaces = new Map();
    this.clearPlaneVisuals();
    this.isScanning = false;
    this.scanStartTime = 0;
    this.floorY = 0;

    try {
      this.el.sceneEl.emit('room-reset');
    } catch (e) { /* ignore */ }

    setTimeout(function () {
      self.initializeXRSession(false);
    }, 1000);
  },

  initializeXRSession: async function (resumeMode) {
    if (resumeMode === undefined) resumeMode = false;
    let self = this;
    let renderer = this.el.sceneEl.renderer;
    if (!renderer || !renderer.xr) {
      console.warn('❌ Renderer XR non disponible');
      return;
    }

    this.xrSession = renderer.xr.getSession();
    this.xrRefSpace = renderer.xr.getReferenceSpace();

    // Écouter les resets du reference space (casque retiré/remis)
    if (this.xrRefSpace) {
      if (this._refSpaceResetHandler && this._prevXrRefSpace) {
        try { this._prevXrRefSpace.removeEventListener('reset', this._refSpaceResetHandler); } catch (e) { /* ignore */ }
      }
      this._refSpaceResetHandler = function (event) {
        let upToDateRefSpace = self.el.sceneEl.renderer.xr.getReferenceSpace();
        if (upToDateRefSpace) self.xrRefSpace = upToDateRefSpace;

        if (self.scanComplete) {
          self._resetDeltaMatrix = event.transform
            ? new THREE.Matrix4().fromArray(event.transform.matrix)
            : null;
          self._pendingVisualRebuild = true;
        }
      };
      this._prevXrRefSpace = this.xrRefSpace;
      this.xrRefSpace.addEventListener('reset', this._refSpaceResetHandler);
    }

    if (!this.xrSession) return;

    // Hit-test source
    try {
      let viewerSpace = await this.xrSession.requestReferenceSpace('viewer');
      this.hitTestSource = await this.xrSession.requestHitTestSource({ space: viewerSpace });
    } catch (error) {
      console.warn('Hit-test viewer non disponible:', error.message);
    }

    if (!resumeMode && !this.cursorEl) this.createScanCursor();
    if (!resumeMode) {
      this.startScan();
    }
  },

  // Créer un curseur visuel pour indiquer les surfaces détectées
  createScanCursor: function () {
    this.cursorEl = document.createElement('a-entity');
    this.cursorEl.setAttribute('id', 'scan-cursor');

    // Anneau externe
    let ring1 = document.createElement('a-ring');
    ring1.setAttribute('radius-inner', '0.04');
    ring1.setAttribute('radius-outer', '0.06');
    ring1.setAttribute('color', '#00ff00');
    ring1.setAttribute('opacity', '0.8');
    ring1.setAttribute('rotation', '-90 0 0');
    this.cursorEl.appendChild(ring1);

    // Anneau interne
    let ring2 = document.createElement('a-ring');
    ring2.setAttribute('radius-inner', '0.01');
    ring2.setAttribute('radius-outer', '0.02');
    ring2.setAttribute('color', '#ffffff');
    ring2.setAttribute('opacity', '0.9');
    ring2.setAttribute('rotation', '-90 0 0');
    this.cursorEl.appendChild(ring2);

    this.cursorEl.object3D.visible = false;
    this.el.sceneEl.appendChild(this.cursorEl);
  },

  startScan: function () {
    if (this.scanComplete) return;

    this.isScanning = true;
    this.scanStartTime = Date.now();
    this.scanPanel.setAttribute('visible', 'true');

    let self = this;
    setTimeout(function () {
      if (self.isScanning) self.finishScan();
    }, this.data.scanDuration);
  },

  _cleanupHitTest: function () {
    if (this.hitTestSource) { this.hitTestSource.cancel(); this.hitTestSource = null; }
    if (this.controllerHitTestSource) { this.controllerHitTestSource.cancel(); this.controllerHitTestSource = null; }
    this.hitTestSourceRequested = false;
    this.controllerHitTestRequested = false;
    if (this.cursorEl) this.cursorEl.object3D.visible = false;
  },

  onExitXR: function () {
    if (this.scanComplete) {
      this._cleanupHitTest();
      return;
    }

    this.isScanning = false;
    this.scanPanel.setAttribute('visible', 'false');
    this.clearPlaneVisuals();
    this._cleanupHitTest();
  },

  tick: function (time, deltaTime) {
    // Reconstruire les visuels après reset via matrice delta
    if (this._pendingVisualRebuild && this.scanComplete) {
      this._pendingVisualRebuild = false;
      this._rebuildVisualsAfterReset(this._resetDeltaMatrix);
      this._resetDeltaMatrix = null;
    }

    // Ne pas détecter de nouveaux plans si scan terminé
    if (this.scanComplete && this.data.continuousDetection) {
      if (this.xrSession && this.xrRefSpace) this.performHitTest();
      return;
    }

    if (!this.isScanning || !this.xrSession || !this.xrRefSpace) return;

    // Barre de progression
    let elapsed = Date.now() - this.scanStartTime;
    let progress = Math.min(elapsed / this.data.scanDuration, 1);
    let width = 1.1 * progress;
    this.progressBar.setAttribute('width', Math.max(0.01, width));
    this.progressBar.setAttribute('position', (-0.55 + width / 2) + ' -0.26 0.02');

    this.detectPlanes();
    this.performHitTest();
  },

  performHitTest: function () {
    let renderer = this.el.sceneEl.renderer;
    if (!renderer?.xr) return;
    let frame = renderer.xr.getFrame();
    if (!frame) return;

    if (!this.controllerHitTestSource && this.xrSession) this.trySetupControllerHitTest(frame);
    this.processHitTestSource(frame, this.hitTestSource, 'viewer');
    this.processHitTestSource(frame, this.controllerHitTestSource, 'controller');
  },

  trySetupControllerHitTest: function (frame) {
    if (this.controllerHitTestRequested || !this.xrSession) return;

    try {
      let inputSources = this.xrSession.inputSources;
      for (let inputSource of inputSources) {
        if (inputSource.handedness === 'right' && inputSource.targetRaySpace) {
          this.controllerHitTestRequested = true;
          let self = this;
          this.xrSession.requestHitTestSource({ space: inputSource.targetRaySpace })
            .then(function (source) { self.controllerHitTestSource = source; })
            .catch(function () { });
          break;
        }
      }
    } catch (error) { /* ignore */ }
  },

  processHitTestSource: function (frame, hitTestSource, sourceType) {
    if (!hitTestSource) return;

    try {
      let hitTestResults = frame.getHitTestResults(hitTestSource);

      if (hitTestResults.length > 0) {
        let hit = hitTestResults[0];  // Prendre le premier résultat (plus proche)
        let hitPose = hit.getPose(this.xrRefSpace);

        if (hitPose) {
          let pos = hitPose.transform.position;
          let orient = hitPose.transform.orientation;

          // Mettre à jour le curseur visuel pour le viewer (style professeur)
          if (sourceType === 'viewer' && this.cursorEl && this.isScanning) {
            this.cursorEl.object3D.visible = true;
            this.cursorEl.object3D.position.set(pos.x, pos.y, pos.z);
            this.cursorEl.object3D.quaternion.set(orient.x, orient.y, orient.z, orient.w);

            // Couleur selon la hauteur (comme le professeur)
            let rings = this.cursorEl.querySelectorAll('a-ring');
            if (pos.y > 0.55 && pos.y <= 1.0) {
              rings.forEach(function (r) { r.setAttribute('color', '#ff8800'); }); // Table probable
            } else if (pos.y < 0.25) {
              rings.forEach(function (r) { r.setAttribute('color', '#00ff00'); }); // Sol
            } else {
              rings.forEach(function (r) { r.setAttribute('color', '#00ffff'); }); // Autre
            }
          }

          // Pour le contrôleur, appliquer le filtrage du professeur
          if (sourceType === 'controller' && this.xrSession) {
            // Vérifier la distance comme le professeur le fait (éviter la main)
            let inputSources = this.xrSession.inputSources;
            let rightController = null;

            for (let inputSource of inputSources) {
              if (inputSource.handedness === 'right') {
                rightController = inputSource;
                break;
              }
            }

            if (rightController && rightController.targetRaySpace) {
              let controllerPose = frame.getPose(rightController.targetRaySpace, this.xrRefSpace);
              if (controllerPose) {
                let dx = pos.x - controllerPose.transform.position.x;
                let dy = pos.y - controllerPose.transform.position.y;
                let dz = pos.z - controllerPose.transform.position.z;
                let distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                // N'accepter que si distance > 0.5m (méthode du professeur)
                if (distance <= 0.5) {
                  if (this.cursorEl) this.cursorEl.object3D.visible = false;
                  return;
                }
              }
            }
          }

          // Grille pour éviter les doublons
          let gridSize = sourceType === 'controller' ? 20 : 10;
          let key = sourceType + '_' + Math.round(pos.x * gridSize) + '_' + Math.round(pos.y * gridSize) + '_' + Math.round(pos.z * gridSize);

          // Enregistrer la surface si nouvelle
          if (!this.hitSurfaces.has(key)) {
            this.hitSurfaces.set(key, {
              position: { x: pos.x, y: pos.y, z: pos.z },
              orientation: { x: orient.x, y: orient.y, z: orient.z, w: orient.w },
              sourceType: sourceType,
              timestamp: Date.now()
            });

            // Mettre à jour les bounds
            this.roomBounds.minX = Math.min(this.roomBounds.minX, pos.x);
            this.roomBounds.maxX = Math.max(this.roomBounds.maxX, pos.x);
            this.roomBounds.minY = Math.min(this.roomBounds.minY, pos.y);
            this.roomBounds.maxY = Math.max(this.roomBounds.maxY, pos.y);
            this.roomBounds.minZ = Math.min(this.roomBounds.minZ, pos.z);
            this.roomBounds.maxZ = Math.max(this.roomBounds.maxZ, pos.z);
          }
        }
      } else if (sourceType === 'viewer' && this.cursorEl) {
        this.cursorEl.object3D.visible = false;
      }
    } catch (error) {
      // Silently ignore errors
    }
  },

  detectPlanes: function () {
    let self = this;
    let renderer = this.el.sceneEl.renderer;
    if (!renderer || !renderer.xr) return;

    // Toujours réactualiser le reference space depuis le renderer
    let currentRefSpace = renderer.xr.getReferenceSpace();
    if (currentRefSpace) this.xrRefSpace = currentRefSpace;

    let frame = renderer.xr.getFrame();
    if (!frame) return;

    // Vérifier si la détection de plans est disponible
    if (!frame.detectedPlanes) return;

    let detectedPlanes = frame.detectedPlanes;
    let newPlanesCount = 0;

    detectedPlanes.forEach(function (plane) {
      // Ignorer les plans déjà traités
      if (self.detectedPlanes.has(plane)) return;

      let planePose = frame.getPose(plane.planeSpace, self.xrRefSpace);
      if (!planePose) return;

      let position = planePose.transform.position;
      let orientation = planePose.transform.orientation;
      let polygon = plane.polygon;

      if (!polygon || polygon.length < 3) return;

      newPlanesCount++;

      // Stocker le plan
      let planeData = {
        position: { x: position.x, y: position.y, z: position.z },
        orientation: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w },
        polygon: polygon,
        type: plane.orientation,
        pose: planePose
      };
      // Flag pour éviter de recréer plusieurs fois la même visualisation
      planeData._visualCreated = false;
      self.detectedPlanes.set(plane, planeData);

      // Classifier le plan selon son orientation et sa hauteur
      self.classifyPlane(plane, planeData);

      // Mettre à jour les bounds avec la pose complète
      self.updateBoundsFromPolygon(planePose, polygon);

      // Créer la visualisation
      if (self.data.showPlanes) {
        self.createPlaneVisual(plane, planeData);
      }

      if (self.data.debug) {
        console.log('📋 ' + plane.orientation + ' détecté: y=' + position.y.toFixed(2) + 'm, vertices=' + polygon.length);
      }
    });

    // Mettre à jour l'UI
    if (newPlanesCount > 0) {
      this.updateScanUI();
    }
  },

  classifyPlane: function (plane, planeData) {
    // Stocker le semanticLabel si disponible (Quest 3 Space Setup)
    planeData.semanticLabel = plane.semanticLabel || null;

    // Approche du professeur : classification robuste basée sur la pose réelle
    let pose = planeData.pose;
    let matrix = new THREE.Matrix4();
    matrix.fromArray(pose.transform.matrix);

    // Transformer tous les vertices pour avoir les vraies coordonnées
    let polygon = planeData.polygon;
    let avgY = planeData.position.y;
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    if (polygon && polygon.length > 0) {
      let sumY = 0;
      polygon.forEach(function (v) {
        let vec = new THREE.Vector3(v.x, v.y, v.z);
        vec.applyMatrix4(matrix);
        sumY += vec.y;
        minX = Math.min(minX, vec.x);
        maxX = Math.max(maxX, vec.x);
        minY = Math.min(minY, vec.y);
        maxY = Math.max(maxY, vec.y);
        minZ = Math.min(minZ, vec.z);
        maxZ = Math.max(maxZ, vec.z);
      });
      avgY = sumY / polygon.length;
    }

    let planeWidth = maxX - minX;
    let planeDepth = maxZ - minZ;
    let planeArea = planeWidth * planeDepth;
    let heightVariance = maxY - minY;

    // Stocker les infos
    planeData.worldY = avgY;
    planeData.dimensions = { width: planeWidth, depth: planeDepth, area: planeArea };
    planeData.bounds = { minX, maxX, minY, maxY, minZ, maxZ };

    // Classification AMÉLIORÉE POUR LES TABLES
    if (plane.orientation === 'horizontal') {
      if (avgY < 0.3) {
        // SOL - hauteur basse
        this.floorPlanes.push({ plane, data: planeData });
        this.floorY = Math.max(this.floorY, avgY);
        if (this.data.debug) {
          console.log('🟢 SOL: y=' + avgY.toFixed(2) + 'm, size=' + planeArea.toFixed(2) + 'm²');
        }
      } else if (avgY > 2.0) {
        // PLAFOND - hauteur haute
        this.ceilingPlanes.push({ plane, data: planeData });
        if (this.data.debug) {
          console.log('🔵 PLAFOND: y=' + avgY.toFixed(2) + 'm');
        }
      } else {
        // OBSTACLE (tables, meubles) - hauteur intermédiaire
        let type = 'obstacle';

        // DÉTECTION AMÉLIORÉE DES TABLES
        // Critères : hauteur + aire + surface plate
        let isTableHeight = avgY >= 0.50 && avgY <= 1.1;
        let isTableSize = planeArea >= 0.12;  // Réduit de 0.2 à 0.12
        let isFlat = heightVariance < 0.15;   // Surface plate

        if (isTableHeight && isTableSize && isFlat) {
          type = 'table';
          if (this.data.debug) {
            console.log('🟡 TABLE DÉTECTÉE: y=' + avgY.toFixed(2) + 'm, ' + planeWidth.toFixed(2) + 'x' + planeDepth.toFixed(2) + 'm, area=' + planeArea.toFixed(2) + 'm²');
          }
        }
        // Sous-classification pour les autres obstacles
        else if (avgY >= 0.25 && avgY < 0.50) {
          type = 'meuble_bas';
        } else if (avgY > 1.1 && avgY <= 1.4) {
          type = 'etagere';
        } else {
          type = 'obstacle';
        }

        planeData.obstacleType = type;
        this.obstaclePlanes.push({ plane, data: planeData });

        if (this.data.debug && type !== 'table') {
          console.log('🟠 ' + type.toUpperCase() + ': y=' + avgY.toFixed(2) + 'm, ' + planeWidth.toFixed(2) + 'x' + planeDepth.toFixed(2) + 'm');
        }
      }
    } else if (plane.orientation === 'vertical') {
      // MUR
      this.wallPlanes.push({ plane, data: planeData });
      if (this.data.debug) {
        console.log('🔷 MUR: pos=(' + planeData.position.x.toFixed(2) + ', ' + planeData.position.z.toFixed(2) + ')');
      }
    }
  },

  updateBoundsFromPolygon: function (pose, polygon) {
    let self = this;
    let matrix = new THREE.Matrix4();
    matrix.fromArray(pose.transform.matrix);

    polygon.forEach(function (vertex) {
      let worldPos = new THREE.Vector3(vertex.x, vertex.y, vertex.z);
      worldPos.applyMatrix4(matrix);

      self.roomBounds.minX = Math.min(self.roomBounds.minX, worldPos.x);
      self.roomBounds.maxX = Math.max(self.roomBounds.maxX, worldPos.x);
      self.roomBounds.minY = Math.min(self.roomBounds.minY, worldPos.y);
      self.roomBounds.maxY = Math.max(self.roomBounds.maxY, worldPos.y);
      self.roomBounds.minZ = Math.min(self.roomBounds.minZ, worldPos.z);
      self.roomBounds.maxZ = Math.max(self.roomBounds.maxZ, worldPos.z);
    });
  },

  createPlaneVisual: function (plane, planeData) {
    let polygon = planeData.polygon;
    let pose = planeData.pose;
    if (!polygon || polygon.length < 3 || planeData._visualCreated) return;

    let matrix = new THREE.Matrix4();
    matrix.fromArray(pose.transform.matrix);
    let centerWorld = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);

    console.log('[plane-visual]', plane.orientation,
      'world:', centerWorld.x.toFixed(2), centerWorld.y.toFixed(2), centerWorld.z.toFixed(2),
      'det:', matrix.determinant().toFixed(4),
      'label:', planeData.semanticLabel || plane.semanticLabel || '-');

    let isTable = plane.orientation === 'horizontal' && planeData.obstacleType === 'table';

    if (isTable) this.createTableVisual(polygon, matrix, planeData);
    else this.createStandardPlaneVisual(polygon, matrix, planeData, plane, centerWorld);
  },

  createTableVisual: function (polygon, matrix, planeData) {
    // Contour jaune (vertices directs du polygone)
    let points = polygon.map(function (v) { return new THREE.Vector3(v.x, v.y, v.z); });
    let lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setFromPoints([...points, points[0]]);

    let lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffdd00,
      transparent: true,
      opacity: 1.0,
      linewidth: 5,
      fog: false
    });

    let lineSegments = new THREE.Line(lineGeometry, lineMaterial);
    lineSegments.matrixAutoUpdate = false;
    lineSegments.matrix.copy(matrix);

    this.el.sceneEl.object3D.add(lineSegments);
    this.planeMeshes.push(lineSegments);

    // Surface remplie - géométrie directe depuis les vertices (plus de ShapeGeometry/rotateX)
    let fillVerts = [];
    for (let i = 1; i < polygon.length - 1; i++) {
      fillVerts.push(polygon[0].x, polygon[0].y, polygon[0].z);
      fillVerts.push(polygon[i].x, polygon[i].y, polygon[i].z);
      fillVerts.push(polygon[i + 1].x, polygon[i + 1].y, polygon[i + 1].z);
    }
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(fillVerts, 3));
    geometry.computeVertexNormals();

    let material = new THREE.MeshBasicMaterial({
      color: 0xffdd00,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    let mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);

    this.el.sceneEl.object3D.add(mesh);
    this.planeMeshes.push(mesh);
    planeData._visualCreated = true;
  },

  createStandardPlaneVisual: function (polygon, matrix, planeData, plane, centerWorld) {
    // Géométrie directe depuis les vertices du polygone (plus de ShapeGeometry/rotateX)
    let fillVerts = [];
    for (let i = 1; i < polygon.length - 1; i++) {
      fillVerts.push(polygon[0].x, polygon[0].y, polygon[0].z);
      fillVerts.push(polygon[i].x, polygon[i].y, polygon[i].z);
      fillVerts.push(polygon[i + 1].x, polygon[i + 1].y, polygon[i + 1].z);
    }
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(fillVerts, 3));
    geometry.computeVertexNormals();

    // Couleur selon le type
    let color = 0x0088ff, opacity = 0.25;
    if (plane.orientation === 'horizontal') {
      if (centerWorld.y < 0.25) { color = 0x00ff00; opacity = 0.35; }
      else if (centerWorld.y > 2.2) { color = 0x00ffff; opacity = 0.2; }
      else { color = 0xff8800; opacity = 0.4; }
    }

    let material = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: opacity,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    let mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);

    // Contour direct (line loop depuis les vertices du polygone)
    let linePoints = polygon.map(function (v) { return new THREE.Vector3(v.x, v.y, v.z); });
    linePoints.push(linePoints[0].clone());
    let lineGeom = new THREE.BufferGeometry().setFromPoints(linePoints);
    let lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      linewidth: 2
    });
    let outline = new THREE.Line(lineGeom, lineMaterial);
    outline.matrixAutoUpdate = false;
    outline.matrix.copy(matrix);

    this.el.sceneEl.object3D.add(mesh);
    this.el.sceneEl.object3D.add(outline);
    this.planeMeshes.push(mesh, outline);
    planeData._visualCreated = true;
  },

  updateScanUI: function () {
    let floorCount = this.floorPlanes.length;
    let wallCount = this.wallPlanes.length;
    let obstacleCount = this.obstaclePlanes.length;
    let hitSurfaceCount = this.hitSurfaces.size;
    let total = floorCount + wallCount + obstacleCount + this.ceilingPlanes.length;

    // Compter les types d'obstacles
    let obstacleTypes = {};
    this.obstaclePlanes.forEach(function (item) {
      let type = item.data.obstacleType || 'autre';
      obstacleTypes[type] = (obstacleTypes[type] || 0) + 1;
    });

    this.surfaceCount.setAttribute('value',
      'Sol: ' + floorCount + ' | Murs: ' + wallCount + ' | Objets: ' + obstacleCount);

    // Afficher plus de détails sur les obstacles
    let details = total + ' surfaces + ' + hitSurfaceCount + ' points';
    if (obstacleCount > 0) {
      let typesList = Object.entries(obstacleTypes)
        .map(function (entry) { return entry[1] + ' ' + entry[0].split('/')[0]; })
        .slice(0, 2)
        .join(', ');
      details += '\n' + typesList;
    } else {
      details += '\nContinuez à scanner...';
    }

    this.scanText.setAttribute('value', details);
  },

  // Reconstruit visuels + bounds après un reset du reference space
  _rebuildVisualsAfterReset: function (deltaMatrix) {
    let delta = deltaMatrix || new THREE.Matrix4();

    this.clearPlaneVisuals();
    let oldBox = document.querySelector('#spawn-zone-bounds');
    if (oldBox && oldBox.parentNode) oldBox.parentNode.removeChild(oldBox);

    // Transformer les poses de tous les plans avec la matrice delta
    this.roomBounds = {
      minX: Infinity, maxX: -Infinity,
      minY: Infinity, maxY: -Infinity,
      minZ: Infinity, maxZ: -Infinity
    };
    this.floorY = 0;

    this.detectedPlanes.forEach(function (planeData, plane) {
      try {
        // Calculer la nouvelle matrice de pose : delta * oldPose
        let oldPoseMatrix = new THREE.Matrix4().fromArray(planeData.pose.transform.matrix);
        let newPoseMatrix = new THREE.Matrix4().multiplyMatrices(delta, oldPoseMatrix);

        // Décomposer pour extraire position + orientation (utiles pour detectOpenings)
        let newPos = new THREE.Vector3();
        let newQuat = new THREE.Quaternion();
        let newScale = new THREE.Vector3();
        newPoseMatrix.decompose(newPos, newQuat, newScale);

        // Créer un objet pose synthétique compatible avec le reste du code
        planeData.pose = {
          transform: {
            matrix: newPoseMatrix.elements,
            position: { x: newPos.x, y: newPos.y, z: newPos.z, w: 1 },
            orientation: { x: newQuat.x, y: newQuat.y, z: newQuat.z, w: newQuat.w }
          }
        };
        planeData._visualCreated = false;

        // Recalculer bounds / worldY / dimensions depuis polygon + nouvelle pose
        let polygon = planeData.polygon;
        if (polygon && polygon.length > 0) {
          let sumY = 0;
          let minX = Infinity, maxX = -Infinity;
          let minY = Infinity, maxY = -Infinity;
          let minZ = Infinity, maxZ = -Infinity;

          polygon.forEach(function (v) {
            let vec = new THREE.Vector3(v.x, v.y, v.z).applyMatrix4(newPoseMatrix);
            sumY += vec.y;
            if (vec.x < minX) minX = vec.x;
            if (vec.x > maxX) maxX = vec.x;
            if (vec.y < minY) minY = vec.y;
            if (vec.y > maxY) maxY = vec.y;
            if (vec.z < minZ) minZ = vec.z;
            if (vec.z > maxZ) maxZ = vec.z;
          });

          let avgY = sumY / polygon.length;
          planeData.worldY = avgY;
          planeData.bounds = { minX: minX, maxX: maxX, minY: minY, maxY: maxY, minZ: minZ, maxZ: maxZ };
          planeData.dimensions = {
            width: maxX - minX,
            depth: maxZ - minZ,
            area: (maxX - minX) * (maxZ - minZ)
          };

          // Mettre à jour les bounds globaux de la pièce
          this.roomBounds.minX = Math.min(this.roomBounds.minX, minX);
          this.roomBounds.maxX = Math.max(this.roomBounds.maxX, maxX);
          this.roomBounds.minY = Math.min(this.roomBounds.minY, minY);
          this.roomBounds.maxY = Math.max(this.roomBounds.maxY, maxY);
          this.roomBounds.minZ = Math.min(this.roomBounds.minZ, minZ);
          this.roomBounds.maxZ = Math.max(this.roomBounds.maxZ, maxZ);
        }

        // Recalculer floorY depuis les plans de sol
        if (plane.orientation === 'horizontal' && planeData.worldY < 0.3) {
          this.floorY = Math.max(this.floorY, planeData.worldY);
        }

        // Recréer le visuel du plan
        if (this.data.showPlanes) {
          this.createPlaneVisual(plane, planeData);
        }
      } catch (err) { /* ignore */ }
    }.bind(this));

    // Calculer la hauteur
    let newCeilingY = this.roomBounds.maxY;
    let height = newCeilingY - this.floorY;
    if (!isFinite(height) || height < 1.5) height = 2.5;
    height = Math.min(height, 4.0);

    // Recréer la boîte de spawn zone avec le plus grand sol
    let roomData = null;
    try {
      let largestFloorEntry = null;
      let maxArea = 0;
      this.floorPlanes.forEach(function (fp) {
        let area = fp.data && fp.data.dimensions ? fp.data.dimensions.area : 0;
        if (area > maxArea) { maxArea = area; largestFloorEntry = fp; }
      });

      if (largestFloorEntry && largestFloorEntry.data.pose) {
        let floorBounds = largestFloorEntry.data.bounds;
        roomData = {
          width: floorBounds.maxX - floorBounds.minX,
          depth: floorBounds.maxZ - floorBounds.minZ,
          height: height,
          centerX: (floorBounds.minX + floorBounds.maxX) / 2,
          centerZ: (floorBounds.minZ + floorBounds.maxZ) / 2,
          floorY: this.floorY,
          bounds: floorBounds,
          floorPolygon: largestFloorEntry.data.polygon,
          floorPose: largestFloorEntry.data.pose,
          orientedBox: null
        };
        this.createSpawnZoneBoundingBox(roomData);
      }
    } catch (err) { /* ignore */ }

    // Fallback
    if (!roomData) {
      roomData = {
        bounds: this.roomBounds,
        floorY: this.floorY,
        height: height
      };
      this.createSpawnZoneBoundingBox(roomData);
    }

    this.detectOpenings();

    // Mettre à jour window.FISH_ZONE
    if (window && window.FISH_ZONE) {
      window.FISH_ZONE.roomBounds = roomData.bounds;
      window.FISH_ZONE.orientedBox = roomData.orientedBox || null;
      window.FISH_ZONE.floorY = this.floorY;
      window.FISH_ZONE.ceilingY = this.floorY + height;
      window.FISH_ZONE.openings = this.openings;
      window.FISH_ZONE.scanned = true;
    }

    // Notifier les composants dépendants
    this.el.sceneEl.emit('zone-updated', {
      bounds: roomData.bounds,
      orientedBox: roomData.orientedBox || null,
      floorY: this.floorY,
      ceilingY: this.floorY + height,
      height: height,
      openings: this.openings
    });
  },

  clearPlaneVisuals: function () {
    let scene = this.el.sceneEl;
    this.planeMeshes.forEach(function (mesh) {
      scene.object3D.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    });
    this.planeMeshes = [];
  },

  detectOpenings: function () {
    this.openings = [];

    try {
      let centerX = (this.roomBounds.minX + this.roomBounds.maxX) / 2;
      let centerZ = (this.roomBounds.minZ + this.roomBounds.maxZ) / 2;

      // --- Extraire la vraie normale d'un plan vertical depuis sa pose ---
      function getWallNormal(poseData, cx, cz) {
        // La matrice du plan donne l'orientation réelle
        let mat = new THREE.Matrix4();
        mat.fromArray(poseData.transform.matrix);
        // Le vecteur Y local du plan = la normale de la surface
        let normalVec = new THREE.Vector3(mat.elements[4], mat.elements[5], mat.elements[6]).normalize();
        // N'utiliser que XZ (on veut la direction horizontale)
        let n = { x: normalVec.x, y: 0, z: normalVec.z };
        let len = Math.sqrt(n.x * n.x + n.z * n.z);
        if (len < 0.01) return null; // plan horizontal, pas un mur
        n.x /= len;
        n.z /= len;
        // S'assurer que la normale pointe VERS L'EXTÉRIEUR (opposé au centre)
        let pos = poseData.transform.position;
        let toCenter = { x: cx - pos.x, z: cz - pos.z };
        let dot = n.x * toCenter.x + n.z * toCenter.z;
        if (dot > 0) { n.x = -n.x; n.z = -n.z; } // inverser si elle pointe vers le centre
        return n;
      }

      function getWallName(normal) {
        if (Math.abs(normal.z) > Math.abs(normal.x)) {
          return normal.z < 0 ? 'north' : 'south';
        }
        return normal.x < 0 ? 'west' : 'east';
      }

      // 1) Par semanticLabel (Quest 3) ou heuristique par taille
      let labeledOpenings = this.wallPlanes.filter(function (wp) {
        let label = (wp.data.semanticLabel || wp.plane.semanticLabel || '').toLowerCase();
        return label === 'door' || label === 'window' || label === 'opening';
      });

      let candidates;
      if (labeledOpenings.length > 0) {
        candidates = labeledOpenings;
      } else {
        // Seuil adaptatif : moitié de l'aire du plus grand mur
        let maxArea = 0;
        this.wallPlanes.forEach(function (wp) {
          if (!wp.data || !wp.data.bounds) return;
          let b = wp.data.bounds;
          let w = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
          let h = b.maxY - b.minY;
          if (w * h > maxArea) maxArea = w * h;
        });
        let areaThreshold = Math.max(maxArea * 0.5, 2.5);

        candidates = this.wallPlanes.filter(function (wp) {
          if (!wp.data || !wp.data.bounds) return false;
          let b = wp.data.bounds;
          let a = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * (b.maxY - b.minY);
          return a < areaThreshold;
        });
      }

      // 2) Créer les openings avec la VRAIE normale du mur
      let self = this;
      candidates.forEach(function (wp) {
        try {
          let plane = wp.plane, data = wp.data;
          if (!data || !data.pose || !data.bounds) return;

          let pos = data.pose.transform.position;
          let bounds = data.bounds;
          let width = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
          let height = bounds.maxY - bounds.minY;

          // Normale RÉELLE depuis la pose du plan
          let normal = getWallNormal(data.pose, centerX, centerZ);
          if (!normal) return; // skip if not a wall
          let wallName = getWallName(normal);

          let label = (data.semanticLabel || plane.semanticLabel || '').toLowerCase();
          let type = (label === 'door') ? 'door' : (label === 'window') ? 'window' : (height > 1.8 ? 'door' : 'window');

          console.log('[opening]', type, wallName, 'pos:', pos.x.toFixed(2), pos.y.toFixed(2), pos.z.toFixed(2),
            'normal:', normal.x.toFixed(2), normal.z.toFixed(2), 'size:', width.toFixed(2), 'x', height.toFixed(2));

          self.openings.push({
            type: type,
            position: { x: pos.x, y: pos.y, z: pos.z },
            normal: normal,
            size: { width: width, height: height },
            wall: wallName,
            area: width * height
          });
        } catch (err) { /* ignore */ }
      });

      console.log('[detectOpenings] 📍 TOTAL détecté:', self.openings.length, 'ouverture(s)');

    } catch (err) {
      console.error('detectOpenings error:', err);
    }
  },

  finishScan: function () {
    this.isScanning = false;
    this.scanComplete = true;

    let totalPlanes = this.detectedPlanes.size;

    // Mettre à jour l'UI
    this.scanTitle.setAttribute('value', '✅ SCAN COMPLETE');
    this.scanTitle.setAttribute('color', '#00ff00');
    this.scanText.setAttribute('value', totalPlanes + ' surfaces\nAdapting water...');
    this.progressBar.setAttribute('color', '#00ff00');

    let roomData = null;

    if (this.floorPlanes.length > 0) {
      let largestFloor = this.floorPlanes[0];
      let maxArea = 0;

      this.floorPlanes.forEach(function (fp) {
        let area = fp.data.dimensions ? fp.data.dimensions.area || 0 : 0;
        if (area > maxArea) {
          maxArea = area;
          largestFloor = fp;
        }
      });

      let floorData = largestFloor.data;
      let floorBounds = floorData.bounds;
      let width = floorBounds.maxX - floorBounds.minX;
      let depth = floorBounds.maxZ - floorBounds.minZ;
      let centerX = (floorBounds.minX + floorBounds.maxX) / 2;
      let centerZ = (floorBounds.minZ + floorBounds.maxZ) / 2;

      let height = this.roomBounds.maxY - this.floorY;
      if (!isFinite(height) || height < 1.5) height = 2.5;
      height = Math.min(height, 4.0);

      roomData = {
        width: width,
        depth: depth,
        height: height,
        centerX: centerX,
        centerZ: centerZ,
        floorY: this.floorY,
        bounds: floorBounds,
        floorPolygon: floorData.polygon,
        floorPose: floorData.pose,
        orientedBox: null
      };
    } else {
      let bounds = this.roomBounds;
      let width = bounds.maxX - bounds.minX;
      let depth = bounds.maxZ - bounds.minZ;
      let height = bounds.maxY - bounds.minY;

      if (!isFinite(width) || width < 1) width = 6;
      if (!isFinite(depth) || depth < 1) depth = 6;
      if (!isFinite(height) || height < 1) height = 2.5;
      width = Math.min(Math.max(width, 2), 20);
      depth = Math.min(Math.max(depth, 2), 20);
      height = Math.min(Math.max(height, 1.5), 5);

      let centerX = isFinite(bounds.minX) && isFinite(bounds.maxX) ? (bounds.minX + bounds.maxX) / 2 : 0;
      let centerZ = isFinite(bounds.minZ) && isFinite(bounds.maxZ) ? (bounds.minZ + bounds.maxZ) / 2 : -2;

      roomData = {
        width: width, depth: depth, height: height,
        centerX: centerX, centerZ: centerZ,
        floorY: this.floorY, bounds: bounds
      };
    }

    try {
      this.createSpawnZoneBoundingBox(roomData);
    } catch (e) {
      console.warn('[room-detection] createSpawnZoneBoundingBox error:', e);
    }

    try {
      this.detectOpenings();
    } catch (e) {
      console.warn('[room-detection] detectOpenings error:', e);
    }

    if (window && window.FISH_ZONE) {
      window.FISH_ZONE.roomBounds = roomData.bounds;
      window.FISH_ZONE.orientedBox = roomData.orientedBox || null;
      window.FISH_ZONE.floorY = roomData.floorY;
      window.FISH_ZONE.ceilingY = roomData.floorY + roomData.height;
      window.FISH_ZONE.openings = this.openings;
      window.FISH_ZONE.scanned = true;
    }

    console.log('[room-detection] Emitting room-scanned: w=' + roomData.width +
      ' d=' + roomData.depth + ' h=' + roomData.height +
      ' cx=' + roomData.centerX + ' cz=' + roomData.centerZ +
      ' orientedBox=' + !!roomData.orientedBox);

    this.el.sceneEl.emit('room-scanned', {
      bounds: roomData.bounds,
      width: roomData.width,
      depth: roomData.depth,
      height: roomData.height,
      centerX: roomData.centerX,
      centerZ: roomData.centerZ,
      floorY: roomData.floorY,
      orientedBox: roomData.orientedBox || null,
      floorPlanes: this.floorPlanes,
      wallPlanes: this.wallPlanes,
      obstaclePlanes: this.obstaclePlanes,
      ceilingPlanes: this.ceilingPlanes,
      allPlanes: this.detectedPlanes,
      openings: this.openings
    });

    this.ensureLaserControlsActive();

    let self = this;
    setTimeout(function () {
      self.scanPanel.setAttribute('visible', 'false');
      if (!self.data.debug) {
        setTimeout(function () {
          self.fadeOutPlaneVisuals();
        }, 2000);
      }
    }, 3000);
  },

  ensureLaserControlsActive: function () {
    console.log('[laser] 🎯 Activation laser');

    function activateHands() {
      let hands = document.querySelectorAll('#leftHand, #rightHand');
      hands.forEach(function (hand) {
        try {
          // Forcer le raycaster à montrer la ligne
          let rc = hand.components['raycaster'];
          if (rc) {
            // Reconfigurer showLine via setAttribute pour que A-Frame mette à jour internement
            hand.setAttribute('raycaster', 'showLine', true);
            if (rc.refreshObjects) rc.refreshObjects();
            console.log('[laser] ✅', hand.id, 'raycaster ligne activée');
          }
        } catch (e) {
          console.log('[laser] ⚠️', hand.id, 'erreur:', e);
        }
      });
    }

    // Activer immédiatement + avec délai pour laisser les contrôleurs s'initialiser
    activateHands();
    setTimeout(activateHands, 500);
    setTimeout(activateHands, 2000);
  },

  fadeOutPlaneVisuals: function () {
    let fadeTime = 1500;
    let startTime = Date.now();
    let self = this;
    function fade() {
      let progress = Math.min((Date.now() - startTime) / fadeTime, 1);
      let opacity = 1 - progress;
      self.planeMeshes.forEach(function (mesh) {
        if (mesh.material) mesh.material.opacity *= opacity;
      });
      if (progress < 1) requestAnimationFrame(fade);
      else self.clearPlaneVisuals();
    }
    fade();
  },

  remove: function () {
    this.isScanning = false;
    this.clearPlaneVisuals();
  }
});
