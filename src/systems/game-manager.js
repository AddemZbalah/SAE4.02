// Game manager system: handles UI buttons and AR session entry
(function () {
  // Wait until DOM ready
  function initARButton() {
    var arButton = document.getElementById('ar-button');
    var scene = document.querySelector('a-scene');
    if (!arButton || !scene) return;

    arButton.addEventListener('click', async function () {
      if (!navigator.xr) { alert('WebXR non supporté'); return; }
      var isArSupported = await navigator.xr.isSessionSupported('immersive-ar');
      if (!isArSupported) { alert('Mode AR non supporté.'); return; }
      try {
        scene.enterAR();
        arButton.style.display = 'none';
        scene.addEventListener('exit-vr', function onExitAR() {
          arButton.style.display = 'block';
          scene.removeEventListener('exit-vr', onExitAR);
        });
      } catch (err) {
        console.error('AR launch error:', err);
        alert('Erreur: ' + err.message);
      }
    });

    scene.addEventListener('loaded', async function () {
      if (navigator.xr) {
        var isArSupported = await navigator.xr.isSessionSupported('immersive-ar');
        if (!isArSupported) { arButton.textContent = 'AR non disponible'; arButton.disabled = true; }
      } else {
        arButton.textContent = 'WebXR non supporté'; arButton.disabled = true;
      }
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(initARButton, 0);
  } else {
    document.addEventListener('DOMContentLoaded', initARButton);
  }
  // Setup simple game UI handlers (start/restart/quit)
  function initGameUI() {
    var start3D = document.querySelector('#start-button-3d');
    var scene = document.querySelector('a-scene');
    if (start3D) {
      start3D.setAttribute('visible', 'false');
      start3D.addEventListener('click', function () {
        start3D.setAttribute('visible', 'false');
        try {
          // Réactiver les lasers au lancement du jeu
          var rd = document.querySelector('[room-detection]');
          if (rd && rd.components && rd.components['room-detection'] && rd.components['room-detection'].ensureLaserControlsActive) {
            rd.components['room-detection'].ensureLaserControlsActive();
          }

          var spear = document.querySelector('#spear');
          if (spear) spear.setAttribute('visible', 'true');

          var water = document.querySelector('#water-surface');
          if (water) {
            var adapter = water.components && water.components['water-adapter'];
            try {
              if (adapter && adapter.startRise) {
                adapter.startRise();
              } else {
                water.setAttribute('visible', 'true');
                if (window.GameAnimations) GameAnimations.waterRise(water, null, '0 2.5 -2', 10000);
              }
            } catch (e) { /* ignore */ }

            var onAnim = function (ev) {
              try { water.removeEventListener('animationcomplete', onAnim); } catch (e) { }
              if (onAnim._triggered) return;
              onAnim._triggered = true;
              try {
                var spawner = document.querySelector('[fish-spawner]');
                if (spawner && spawner.components && spawner.components['fish-spawner'] && spawner.components['fish-spawner'].startSpawn) {
                  spawner.components['fish-spawner'].startSpawn();
                }
              } catch (e) { /* ignore */ }
              try { if (window.gameTimer && window.gameTimer.startGame) window.gameTimer.startGame(60); } catch (e) { }
            };

            water.addEventListener('animationcomplete', onAnim);
            setTimeout(function () { onAnim({ type: 'timeout-fallback' }); }, 12000);
          } else {
            // No water, just spawn and start
            try {
              var spawner = document.querySelector('[fish-spawner]');
              if (spawner && spawner.components && spawner.components['fish-spawner'] && spawner.components['fish-spawner'].startSpawn) spawner.components['fish-spawner'].startSpawn();
            } catch (e) { }
            try { if (window.gameTimer && window.gameTimer.startGame) window.gameTimer.startGame(60); } catch (e) { }
          }
        } catch (e) { console.warn('start button handler error', e); }
      });

      // Show PLAY after room scan
      if (scene) {
        scene.addEventListener('room-scanned', function () {
          try { if (window.GameAnimations) GameAnimations.delayedShow(start3D, 300); } catch (e) { }
          setTimeout(function () {
            if (start3D && start3D.getAttribute('visible') !== 'true') start3D.setAttribute('visible', 'true');
          }, 500);
        }, { once: true });
      }
    }

    var duration = (window.GAME_CONFIG && window.GAME_CONFIG.GAME_DURATION) || 60;

    // --- Boutons RESTART ---
    var btnRestart = document.getElementById('btn-restart');
    if (btnRestart) btnRestart.addEventListener('click', function () {
      if (window.gameTimer && window.gameTimer.resetGame) {
        window.gameTimer.resetGame();
        window.gameTimer.startGame(duration);
      }
    });
    var btnRestart3D = document.querySelector('#btn-restart-3d');
    if (btnRestart3D) btnRestart3D.addEventListener('click', function () {
      if (window.gameTimer && window.gameTimer.resetGame) {
        window.gameTimer.resetGame();
        window.gameTimer.startGame(duration);
      }
    });

    // --- Boutons QUIT (reset + reload page) ---
    var btnQuit = document.getElementById('btn-quit');
    if (btnQuit) btnQuit.addEventListener('click', function () {
      if (window.gameTimer && window.gameTimer.resetGame) window.gameTimer.resetGame();
      window.location.reload();
    });
    var btnQuit3D = document.querySelector('#btn-quit-3d');
    if (btnQuit3D) btnQuit3D.addEventListener('click', function () {
      if (window.gameTimer && window.gameTimer.resetGame) window.gameTimer.resetGame();
      window.location.reload();
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') initGameUI(); else document.addEventListener('DOMContentLoaded', initGameUI);
})();
