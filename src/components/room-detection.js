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
    setTimeout(async () => {
      try {
        const urlParams = (typeof window !== 'undefined' && window.location && window.location.search)
          ? new URLSearchParams(window.location.search)
          : null;
        const allowParam = urlParams ? (urlParams.get('allowTest') === '1' || urlParams.get('allowTest') === 'true') : false;
        const allowTest = this.data.enableTest || allowParam;

        if (!allowTest) return; // pas d'émission automatique de test

        // N'émettre des données de test que si WebXR est absent (PC dev)
        if ('xr' in navigator) return;
      } catch (e) {
        // ignore
        return;
      }

      if (!this.xrSession && !this.xrSessionRequested && !this.scanComplete && !this.isScanning) {
        console.warn('⚠️ WebXR non présent — émission de données de test pour le développement PC');
        this.emitTestRoomData();
      }
    }, 8000);
  },

  emitTestRoomData: function () {
    this.scanComplete = true;
    const testData = {
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
    const oldBox = document.querySelector('#spawn-zone-bounds');
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
    const polygon = data.floorPolygon;
    const pose = data.floorPose;
    const height = data.height;

    // Transformer tous les vertices avec la matrice du sol
    const matrix = new THREE.Matrix4();
    matrix.fromArray(pose.transform.matrix);

    // Extraire la position et rotation de la matrice
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);

    // Convertir quaternion en angles Euler
    const euler = new THREE.Euler();
    euler.setFromQuaternion(quaternion);
    const rotationY = THREE.MathUtils.radToDeg(euler.y);

    // Calculer les bounds dans l'espace LOCAL du plan (avant transformation)
    let localMinX = Infinity, localMaxX = -Infinity;
    let localMinZ = Infinity, localMaxZ = -Infinity;

    polygon.forEach(v => {
      localMinX = Math.min(localMinX, v.x);
      localMaxX = Math.max(localMaxX, v.x);
      localMinZ = Math.min(localMinZ, v.z);
      localMaxZ = Math.max(localMaxZ, v.z);
    });

    // Dimensions dans l'espace local
    const width = localMaxX - localMinX;
    const depth = localMaxZ - localMinZ;
    const localCenterX = (localMinX + localMaxX) / 2;
    const localCenterZ = (localMinZ + localMaxZ) / 2;

    // Transformer le centre local en monde
    const centerLocal = new THREE.Vector3(localCenterX, 0, localCenterZ);
    centerLocal.applyMatrix4(matrix);

    // Calculer les bounds RÉELS en monde (pour les collisions)
    let realMinX = Infinity, realMaxX = -Infinity;
    let realMinZ = Infinity, realMaxZ = -Infinity;

    polygon.forEach(v => {
      const vec = new THREE.Vector3(v.x, v.y, v.z);
      vec.applyMatrix4(matrix);

      realMinX = Math.min(realMinX, vec.x);
      realMaxX = Math.max(realMaxX, vec.x);
      realMinZ = Math.min(realMinZ, vec.z);
      realMaxZ = Math.max(realMaxZ, vec.z);
    });

    // Mettre à jour les bounds ET infos de la box orientée pour les poissons
    data.bounds = {
      minX: realMinX,
      maxX: realMaxX,
      minZ: realMinZ,
      maxZ: realMaxZ
    };

    // Infos de la box orientée pour collisions précises
    data.orientedBox = {
      centerX: centerLocal.x,
      centerZ: centerLocal.z,
      width: width,
      depth: depth,
      rotationY: rotationY * Math.PI / 180, // En radians
      halfWidth: width / 2,
      halfDepth: depth / 2,
      // Bounds locaux EXACTS (le polygone n'est pas forcément centré à l'origine locale)
      localMinX: localMinX,
      localMaxX: localMaxX,
      localMinZ: localMinZ,
      localMaxZ: localMaxZ
    };

    // Stocker la matrice de transformation du plan (local -> world) et son inverse
    data.orientedBox.matrix = matrix.clone();
    data.orientedBox.inverseMatrix = new THREE.Matrix4().copy(matrix).invert();

    // Créer la box rouge ORIENTÉE comme le sol réel
    const box = document.createElement('a-box');
    box.setAttribute('id', 'spawn-zone-bounds');
    box.setAttribute('position', `${centerLocal.x} ${data.floorY + height / 2} ${centerLocal.z}`);
    box.setAttribute('rotation', `0 ${rotationY} 0`);
    box.setAttribute('width', width);
    box.setAttribute('height', height);
    box.setAttribute('depth', depth);
    box.setAttribute('material', 'color: #ff0000; opacity: 0.12; transparent: true; wireframe: true; side: double');
    box.setAttribute('geometry', 'primitive: box');

    this.el.sceneEl.appendChild(box);
  },

  drawPolygonLoop: function (points, container, color, opacity) {
    const closedPoints = [...points, points[0]];
    const lineGeom = new THREE.BufferGeometry().setFromPoints(closedPoints);
    const lineMat = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: opacity,
      linewidth: 3
    });
    const line = new THREE.Line(lineGeom, lineMat);
    this.el.sceneEl.object3D.add(line);
    this.planeMeshes.push(line);
  },

  createStandardBox: function (data) {
    // Box rectangulaire (MÊME ZONE que pour les collisions des poissons)
    const bounds = data.bounds || {};
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;

    const box = document.createElement('a-box');
    box.setAttribute('id', 'spawn-zone-bounds');
    box.setAttribute('position', `${centerX} ${data.floorY + data.height / 2} ${centerZ}`);
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
    const background = document.createElement('a-plane');
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
    const progressBg = document.createElement('a-plane');
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

  ensureLaserControlsActive: function () {
    setTimeout(() => {
      ['#leftHand', '#rightHand'].forEach(sel => {
        var hand = document.querySelector(sel);
        if (!hand) return;
        var lc = hand.components['laser-controls'];
        var rc = hand.components['raycaster'];
        if (lc) { lc.pause(); lc.play(); }
        if (rc) rc.refreshObjects();
      });
    }, 500);
  },

  onEnterXR: function () {
    this.xrSessionRequested = true;

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

    setTimeout(() => {
      this.initializeXRSession(false);
    }, 1000);
  },

  initializeXRSession: async function (resumeMode = false) {
    const renderer = this.el.sceneEl.renderer;
    if (!renderer?.xr) {
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
      this._refSpaceResetHandler = (event) => {
        var upToDateRefSpace = this.el.sceneEl.renderer.xr.getReferenceSpace();
        if (upToDateRefSpace) this.xrRefSpace = upToDateRefSpace;

        if (this.scanComplete) {
          this._resetDeltaMatrix = event.transform
            ? new THREE.Matrix4().fromArray(event.transform.matrix)
            : null;
          this._pendingVisualRebuild = true;
        }
      };
      this._prevXrRefSpace = this.xrRefSpace;
      this.xrRefSpace.addEventListener('reset', this._refSpaceResetHandler);
    }

    if (!this.xrSession) return;

    // Hit-test source
    try {
      const viewerSpace = await this.xrSession.requestReferenceSpace('viewer');
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
    const ring1 = document.createElement('a-ring');
    ring1.setAttribute('radius-inner', '0.04');
    ring1.setAttribute('radius-outer', '0.06');
    ring1.setAttribute('color', '#00ff00');
    ring1.setAttribute('opacity', '0.8');
    ring1.setAttribute('rotation', '-90 0 0');
    this.cursorEl.appendChild(ring1);

    // Anneau interne
    const ring2 = document.createElement('a-ring');
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

    setTimeout(() => {
      if (this.isScanning) this.finishScan();
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
    var elapsed = Date.now() - this.scanStartTime;
    var progress = Math.min(elapsed / this.data.scanDuration, 1);
    var width = 1.1 * progress;
    this.progressBar.setAttribute('width', Math.max(0.01, width));
    this.progressBar.setAttribute('position', `${-0.55 + width / 2} -0.26 0.02`);

    this.detectPlanes();
    this.performHitTest();
  },

  performHitTest: function () {
    var renderer = this.el.sceneEl.renderer;
    if (!renderer?.xr) return;
    var frame = renderer.xr.getFrame();
    if (!frame) return;

    if (!this.controllerHitTestSource && this.xrSession) this.trySetupControllerHitTest(frame);
    this.processHitTestSource(frame, this.hitTestSource, 'viewer');
    this.processHitTestSource(frame, this.controllerHitTestSource, 'controller');
  },

  trySetupControllerHitTest: function (frame) {
    if (this.controllerHitTestRequested || !this.xrSession) return;

    try {
      var inputSources = this.xrSession.inputSources;
      for (var inputSource of inputSources) {
        if (inputSource.handedness === 'right' && inputSource.targetRaySpace) {
          this.controllerHitTestRequested = true;
          this.xrSession.requestHitTestSource({ space: inputSource.targetRaySpace })
            .then((source) => { this.controllerHitTestSource = source; })
            .catch(() => { });
          break;
        }
      }
    } catch (error) { /* ignore */ }
  },

  processHitTestSource: function (frame, hitTestSource, sourceType) {
    if (!hitTestSource) return;

    try {
      const hitTestResults = frame.getHitTestResults(hitTestSource);

      if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];  // Prendre le premier résultat (plus proche)
        const hitPose = hit.getPose(this.xrRefSpace);

        if (hitPose) {
          const pos = hitPose.transform.position;
          const orient = hitPose.transform.orientation;

          // Mettre à jour le curseur visuel pour le viewer (style professeur)
          if (sourceType === 'viewer' && this.cursorEl && this.isScanning) {
            this.cursorEl.object3D.visible = true;
            this.cursorEl.object3D.position.set(pos.x, pos.y, pos.z);
            this.cursorEl.object3D.quaternion.set(orient.x, orient.y, orient.z, orient.w);

            // Couleur selon la hauteur (comme le professeur)
            const rings = this.cursorEl.querySelectorAll('a-ring');
            if (pos.y > 0.55 && pos.y <= 1.0) {
              rings.forEach(r => r.setAttribute('color', '#ff8800')); // Table probable
            } else if (pos.y < 0.25) {
              rings.forEach(r => r.setAttribute('color', '#00ff00')); // Sol
            } else {
              rings.forEach(r => r.setAttribute('color', '#00ffff')); // Autre
            }
          }

          // Pour le contrôleur, appliquer le filtrage du professeur
          if (sourceType === 'controller' && this.xrSession) {
            // Vérifier la distance comme le professeur le fait (éviter la main)
            const inputSources = this.xrSession.inputSources;
            let rightController = null;

            for (let inputSource of inputSources) {
              if (inputSource.handedness === 'right') {
                rightController = inputSource;
                break;
              }
            }

            if (rightController && rightController.targetRaySpace) {
              const controllerPose = frame.getPose(rightController.targetRaySpace, this.xrRefSpace);
              if (controllerPose) {
                const dx = pos.x - controllerPose.transform.position.x;
                const dy = pos.y - controllerPose.transform.position.y;
                const dz = pos.z - controllerPose.transform.position.z;
                const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                // N'accepter que si distance > 0.5m (méthode du professeur)
                if (distance <= 0.5) {
                  if (this.cursorEl) this.cursorEl.object3D.visible = false;
                  return;
                }
              }
            }
          }

          // Grille pour éviter les doublons
          const gridSize = sourceType === 'controller' ? 20 : 10;
          const key = `${sourceType}_${Math.round(pos.x * gridSize)}_${Math.round(pos.y * gridSize)}_${Math.round(pos.z * gridSize)}`;

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
    const renderer = this.el.sceneEl.renderer;
    if (!renderer?.xr) return;

    const frame = renderer.xr.getFrame();
    if (!frame) return;

    // Vérifier si la détection de plans est disponible
    if (!frame.detectedPlanes) return;

    const detectedPlanes = frame.detectedPlanes;
    let newPlanesCount = 0;

    detectedPlanes.forEach((plane) => {
      // Ignorer les plans déjà traités
      if (this.detectedPlanes.has(plane)) return;

      const planePose = frame.getPose(plane.planeSpace, this.xrRefSpace);
      if (!planePose) return;

      const position = planePose.transform.position;
      const orientation = planePose.transform.orientation;
      const polygon = plane.polygon;

      if (!polygon || polygon.length < 3) return;

      newPlanesCount++;

      // Stocker le plan
      const planeData = {
        position: { x: position.x, y: position.y, z: position.z },
        orientation: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w },
        polygon: polygon,
        type: plane.orientation,
        pose: planePose
      };
      // Flag pour éviter de recréer plusieurs fois la même visualisation
      planeData._visualCreated = false;
      this.detectedPlanes.set(plane, planeData);

      // Classifier le plan selon son orientation et sa hauteur
      this.classifyPlane(plane, planeData);

      // Mettre à jour les bounds avec la pose complète
      this.updateBoundsFromPolygon(planePose, polygon);

      // Créer la visualisation
      if (this.data.showPlanes) {
        this.createPlaneVisual(plane, planeData);
      }

      if (this.data.debug) {
        console.log(`📋 ${plane.orientation} détecté: y=${position.y.toFixed(2)}m, vertices=${polygon.length}`);
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
    const pose = planeData.pose;
    const matrix = new THREE.Matrix4();
    matrix.fromArray(pose.transform.matrix);

    // Transformer tous les vertices pour avoir les vraies coordonnées
    const polygon = planeData.polygon;
    let avgY = planeData.position.y;
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    if (polygon && polygon.length > 0) {
      let sumY = 0;
      polygon.forEach(v => {
        const vec = new THREE.Vector3(v.x, v.y, v.z);
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

    var planeWidth = maxX - minX;
    var planeDepth = maxZ - minZ;
    var planeArea = planeWidth * planeDepth;
    var heightVariance = maxY - minY;

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
          console.log(`🟢 SOL: y=${avgY.toFixed(2)}m, size=${planeArea.toFixed(2)}m²`);
        }
      } else if (avgY > 2.0) {
        // PLAFOND - hauteur haute
        this.ceilingPlanes.push({ plane, data: planeData });
        if (this.data.debug) {
          console.log(`🔵 PLAFOND: y=${avgY.toFixed(2)}m`);
        }
      } else {
        // OBSTACLE (tables, meubles) - hauteur intermédiaire
        let type = 'obstacle';

        // DÉTECTION AMÉLIORÉE DES TABLES
        // Critères : hauteur + aire + surface plate
        const isTableHeight = avgY >= 0.50 && avgY <= 1.1;
        const isTableSize = planeArea >= 0.12;  // Réduit de 0.2 à 0.12
        const isFlat = heightVariance < 0.15;   // Surface plate

        if (isTableHeight && isTableSize && isFlat) {
          type = 'table';
          if (this.data.debug) {
            console.log(`🟡 TABLE DÉTECTÉE: y=${avgY.toFixed(2)}m, ${planeWidth.toFixed(2)}x${planeDepth.toFixed(2)}m, area=${planeArea.toFixed(2)}m²`);
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
          console.log(`🟠 ${type.toUpperCase()}: y=${avgY.toFixed(2)}m, ${planeWidth.toFixed(2)}x${planeDepth.toFixed(2)}m`);
        }
      }
    } else if (plane.orientation === 'vertical') {
      // MUR
      this.wallPlanes.push({ plane, data: planeData });
      if (this.data.debug) {
        console.log(`🔷 MUR: pos=(${planeData.position.x.toFixed(2)}, ${planeData.position.z.toFixed(2)})`);
      }
    }
  },

  updateBoundsFromPolygon: function (pose, polygon) {
    var matrix = new THREE.Matrix4();
    matrix.fromArray(pose.transform.matrix);

    polygon.forEach(vertex => {
      var worldPos = new THREE.Vector3(vertex.x, vertex.y, vertex.z);
      worldPos.applyMatrix4(matrix);

      this.roomBounds.minX = Math.min(this.roomBounds.minX, worldPos.x);
      this.roomBounds.maxX = Math.max(this.roomBounds.maxX, worldPos.x);
      this.roomBounds.minY = Math.min(this.roomBounds.minY, worldPos.y);
      this.roomBounds.maxY = Math.max(this.roomBounds.maxY, worldPos.y);
      this.roomBounds.minZ = Math.min(this.roomBounds.minZ, worldPos.z);
      this.roomBounds.maxZ = Math.max(this.roomBounds.maxZ, worldPos.z);
    });
  },

  createPlaneVisual: function (plane, planeData) {
    var polygon = planeData.polygon;
    var pose = planeData.pose;
    if (!polygon || polygon.length < 3 || planeData._visualCreated) return;

    var matrix = new THREE.Matrix4();
    matrix.fromArray(pose.transform.matrix);
    var centerWorld = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);
    var isTable = plane.orientation === 'horizontal' && planeData.obstacleType === 'table';

    if (isTable) this.createTableVisual(polygon, matrix, planeData);
    else this.createStandardPlaneVisual(polygon, matrix, planeData, plane, centerWorld);
  },

  createTableVisual: function (polygon, matrix, planeData) {
    var points = polygon.map(v => new THREE.Vector3(v.x, v.y, v.z));
    var lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setFromPoints([...points, points[0]]);

    // Matériau pour le contour (JAUNE BRILLANT pour les tables)
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffdd00,  // Jaune vif
      transparent: true,
      opacity: 1.0,
      linewidth: 5,
      fog: false
    });

    const lineSegments = new THREE.Line(lineGeometry, lineMaterial);
    lineSegments.matrixAutoUpdate = false;
    lineSegments.matrix.copy(matrix);

    this.el.sceneEl.object3D.add(lineSegments);
    this.planeMeshes.push(lineSegments);

    // Créer aussi une version transparente remplie JAUNE pour bien voir la surface
    const shape = new THREE.Shape();
    shape.moveTo(polygon[0].x, polygon[0].z);
    for (let i = 1; i < polygon.length; i++) {
      shape.lineTo(polygon[i].x, polygon[i].z);
    }
    shape.closePath();

    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
      color: 0xffdd00,  // Jaune
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);

    this.el.sceneEl.object3D.add(mesh);
    this.planeMeshes.push(mesh);
    // Marquer la visualisation comme créée pour ce plane
    planeData._visualCreated = true;
  },

  createStandardPlaneVisual: function (polygon, matrix, planeData, plane, centerWorld) {
    var shape = new THREE.Shape();
    shape.moveTo(polygon[0].x, polygon[0].z);
    for (var i = 1; i < polygon.length; i++) shape.lineTo(polygon[i].x, polygon[i].z);
    shape.closePath();

    var geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);

    // Couleur selon le type
    var color = 0x0088ff, opacity = 0.25;
    if (plane.orientation === 'horizontal') {
      if (centerWorld.y < 0.25) { color = 0x00ff00; opacity = 0.35; }
      else if (centerWorld.y > 2.2) { color = 0x00ffff; opacity = 0.2; }
      else { color = 0xff8800; opacity = 0.4; }
    }

    const material = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: opacity,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const mesh = new THREE.Mesh(geometry, material);

    // Appliquer directement la matrice de transformation de la pose
    // Cela positionne et oriente correctement le mesh dans l'espace monde
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);

    // Ajouter un contour plus épais pour mieux voir
    const edges = new THREE.EdgesGeometry(geometry);
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff, // Contour blanc pour meilleure visibilité
      transparent: true,
      opacity: 0.9,
      linewidth: 2
    });
    const wireframe = new THREE.LineSegments(edges, lineMaterial);
    wireframe.matrixAutoUpdate = false;
    wireframe.matrix.copy(matrix);

    this.el.sceneEl.object3D.add(mesh);
    this.el.sceneEl.object3D.add(wireframe);
    this.planeMeshes.push(mesh, wireframe);
    // Marquer la visualisation comme créée pour ce plane
    planeData._visualCreated = true;
  },

  updateScanUI: function () {
    const floorCount = this.floorPlanes.length;
    const wallCount = this.wallPlanes.length;
    const obstacleCount = this.obstaclePlanes.length;
    const hitSurfaceCount = this.hitSurfaces.size;
    const total = floorCount + wallCount + obstacleCount + this.ceilingPlanes.length;

    // Compter les types d'obstacles
    const obstacleTypes = {};
    this.obstaclePlanes.forEach(({ data }) => {
      const type = data.obstacleType || 'autre';
      obstacleTypes[type] = (obstacleTypes[type] || 0) + 1;
    });

    this.surfaceCount.setAttribute('value',
      `Sol: ${floorCount} | Murs: ${wallCount} | Objets: ${obstacleCount}`);

    // Afficher plus de détails sur les obstacles
    let details = `${total} surfaces + ${hitSurfaceCount} points`;
    if (obstacleCount > 0) {
      const typesList = Object.entries(obstacleTypes)
        .map(([type, count]) => `${count} ${type.split('/')[0]}`)
        .slice(0, 2)
        .join(', ');
      details += `\n${typesList}`;
    } else {
      details += `\nContinuez à scanner...`;
    }

    this.scanText.setAttribute('value', details);
  },

  // Reconstruit visuels + bounds après un reset du reference space
  _rebuildVisualsAfterReset: function (deltaMatrix) {
    var delta = deltaMatrix || new THREE.Matrix4();

    this.clearPlaneVisuals();
    var oldBox = document.querySelector('#spawn-zone-bounds');
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
        var oldPoseMatrix = new THREE.Matrix4().fromArray(planeData.pose.transform.matrix);
        var newPoseMatrix = new THREE.Matrix4().multiplyMatrices(delta, oldPoseMatrix);

        // Décomposer pour extraire position + orientation (utiles pour detectOpenings)
        var newPos = new THREE.Vector3();
        var newQuat = new THREE.Quaternion();
        var newScale = new THREE.Vector3();
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
        var polygon = planeData.polygon;
        if (polygon && polygon.length > 0) {
          var sumY = 0;
          var minX = Infinity, maxX = -Infinity;
          var minY = Infinity, maxY = -Infinity;
          var minZ = Infinity, maxZ = -Infinity;

          polygon.forEach(function (v) {
            var vec = new THREE.Vector3(v.x, v.y, v.z).applyMatrix4(newPoseMatrix);
            sumY += vec.y;
            if (vec.x < minX) minX = vec.x;
            if (vec.x > maxX) maxX = vec.x;
            if (vec.y < minY) minY = vec.y;
            if (vec.y > maxY) maxY = vec.y;
            if (vec.z < minZ) minZ = vec.z;
            if (vec.z > maxZ) maxZ = vec.z;
          });

          var avgY = sumY / polygon.length;
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
    var newCeilingY = this.roomBounds.maxY;
    var height = newCeilingY - this.floorY;
    if (!isFinite(height) || height < 1.5) height = 2.5;
    height = Math.min(height, 4.0);

    // Recréer la boîte de spawn zone avec le plus grand sol
    var roomData = null;
    try {
      var largestFloorEntry = null;
      var maxArea = 0;
      this.floorPlanes.forEach(function (fp) {
        var area = fp.data && fp.data.dimensions ? fp.data.dimensions.area : 0;
        if (area > maxArea) { maxArea = area; largestFloorEntry = fp; }
      });

      if (largestFloorEntry && largestFloorEntry.data.pose) {
        var floorBounds = largestFloorEntry.data.bounds;
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
    this.planeMeshes.forEach(mesh => {
      this.el.sceneEl.object3D.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    });
    this.planeMeshes = [];
  },

  detectOpenings: function () {
    this.openings = [];

    try {
      var centerX = (this.roomBounds.minX + this.roomBounds.maxX) / 2;
      var centerZ = (this.roomBounds.minZ + this.roomBounds.maxZ) / 2;

      // 1) Par semanticLabel (Quest 3) ou heuristique par taille
      var labeledOpenings = this.wallPlanes.filter(function (wp) {
        var label = (wp.data.semanticLabel || wp.plane.semanticLabel || '').toLowerCase();
        return label === 'door' || label === 'window' || label === 'opening';
      });

      var candidates;
      if (labeledOpenings.length > 0) {
        candidates = labeledOpenings;
      } else {
        // Seuil adaptatif : moitié de l'aire du plus grand mur
        var maxArea = 0;
        this.wallPlanes.forEach(function (wp) {
          if (!wp.data || !wp.data.bounds) return;
          var b = wp.data.bounds;
          var w = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
          var h = b.maxY - b.minY;
          if (w * h > maxArea) maxArea = w * h;
        });
        var areaThreshold = Math.max(maxArea * 0.5, 2.5);

        candidates = this.wallPlanes.filter(function (wp) {
          if (!wp.data || !wp.data.bounds) return false;
          var b = wp.data.bounds;
          var a = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * (b.maxY - b.minY);
          return a < areaThreshold;
        });
      }

      // 2) Créer les openings
      var self = this;
      candidates.forEach(function (wp) {
        try {
          var plane = wp.plane, data = wp.data;
          if (!data || !data.pose || !data.bounds) return;

          var pos = data.pose.transform.position;
          var bounds = data.bounds;
          var width = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
          var height = bounds.maxY - bounds.minY;

          var toCenter = { x: centerX - pos.x, z: centerZ - pos.z };
          var normal = { x: 0, y: 0, z: 0 };
          var wallName = '';

          if (Math.abs(toCenter.z) > Math.abs(toCenter.x)) {
            if (pos.z < centerZ) { normal = { x: 0, y: 0, z: -1 }; wallName = 'north'; }
            else { normal = { x: 0, y: 0, z: 1 }; wallName = 'south'; }
          } else {
            if (pos.x < centerX) { normal = { x: -1, y: 0, z: 0 }; wallName = 'west'; }
            else { normal = { x: 1, y: 0, z: 0 }; wallName = 'east'; }
          }

          var label = (data.semanticLabel || plane.semanticLabel || '').toLowerCase();
          var type = (label === 'door') ? 'door' : (label === 'window') ? 'window' : (height > 1.8 ? 'door' : 'window');

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

      // Fallback : ouvertures par défaut
      if (this.openings.length === 0) {
        var doorY = this.floorY + 1.0;
        var windowY = this.floorY + 1.8;

        this.openings.push({
          type: 'door',
          position: { x: centerX, y: doorY, z: this.roomBounds.minZ },
          normal: { x: 0, y: 0, z: -1 },
          size: { width: 1.0, height: 2.0 },
          wall: 'north'
        });
        this.openings.push({
          type: 'window',
          position: { x: this.roomBounds.maxX, y: windowY, z: centerZ },
          normal: { x: 1, y: 0, z: 0 },
          size: { width: 1.2, height: 1.2 },
          wall: 'east'
        });
      }
    } catch (err) {
      console.error('detectOpenings error:', err);
      if (this.openings.length === 0) {
        var cx = (this.roomBounds.minX + this.roomBounds.maxX) / 2;
        this.openings.push({
          type: 'door',
          position: { x: cx, y: this.floorY + 1.0, z: this.roomBounds.minZ },
          normal: { x: 0, y: 0, z: -1 },
          size: { width: 1.0, height: 2.0 },
          wall: 'north'
        });
      }
    }
  },

  finishScan: function () {
    this.isScanning = false;
    this.scanComplete = true;

    var totalPlanes = this.detectedPlanes.size;
    console.log('Scan complete:', totalPlanes, 'surfaces');

    // Mettre à jour l'UI
    this.scanTitle.setAttribute('value', '✅ SCAN COMPLETE');
    this.scanTitle.setAttribute('color', '#00ff00');
    this.scanText.setAttribute('value', `${totalPlanes} surfaces\nAdapting water...`);
    this.progressBar.setAttribute('color', '#00ff00');

    var roomData = null;

    if (this.floorPlanes.length > 0) {
      var largestFloor = this.floorPlanes[0];
      var maxArea = 0;

      this.floorPlanes.forEach(function (fp) {
        var area = fp.data.dimensions ? fp.data.dimensions.area || 0 : 0;
        if (area > maxArea) {
          maxArea = area;
          largestFloor = fp;
        }
      });

      var floorData = largestFloor.data;
      var floorBounds = floorData.bounds;
      var width = floorBounds.maxX - floorBounds.minX;
      var depth = floorBounds.maxZ - floorBounds.minZ;
      var centerX = (floorBounds.minX + floorBounds.maxX) / 2;
      var centerZ = (floorBounds.minZ + floorBounds.maxZ) / 2;

      var height = this.roomBounds.maxY - this.floorY;
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
      var bounds = this.roomBounds;
      var width = bounds.maxX - bounds.minX;
      var depth = bounds.maxZ - bounds.minZ;
      var height = bounds.maxY - bounds.minY;

      if (!isFinite(width) || width < 1) width = 6;
      if (!isFinite(depth) || depth < 1) depth = 6;
      if (!isFinite(height) || height < 1) height = 2.5;
      width = Math.min(Math.max(width, 2), 20);
      depth = Math.min(Math.max(depth, 2), 20);
      height = Math.min(Math.max(height, 1.5), 5);

      var centerX = isFinite(bounds.minX) && isFinite(bounds.maxX) ? (bounds.minX + bounds.maxX) / 2 : 0;
      var centerZ = isFinite(bounds.minZ) && isFinite(bounds.maxZ) ? (bounds.minZ + bounds.maxZ) / 2 : -2;

      roomData = {
        width: width, depth: depth, height: height,
        centerX: centerX, centerZ: centerZ,
        floorY: this.floorY, bounds: bounds
      };
    }

    this.createSpawnZoneBoundingBox(roomData);
    this.detectOpenings();

    if (window && window.FISH_ZONE) {
      window.FISH_ZONE.roomBounds = roomData.bounds;
      window.FISH_ZONE.orientedBox = roomData.orientedBox || null;
      window.FISH_ZONE.floorY = roomData.floorY;
      window.FISH_ZONE.ceilingY = roomData.floorY + roomData.height;
      window.FISH_ZONE.openings = this.openings;
      window.FISH_ZONE.scanned = true;
    }

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

    var self = this;
    setTimeout(function () {
      self.scanPanel.setAttribute('visible', 'false');
      if (!self.data.debug) {
        setTimeout(function () { self.fadeOutPlaneVisuals(); }, 2000);
      }
    }, 3000);
  },

  fadeOutPlaneVisuals: function () {
    var fadeTime = 1500;
    var startTime = Date.now();
    var self = this;
    function fade() {
      var progress = Math.min((Date.now() - startTime) / fadeTime, 1);
      var opacity = 1 - progress;
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
