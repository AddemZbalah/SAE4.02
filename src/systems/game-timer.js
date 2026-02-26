// Timer, score et écrans de fin
(function () {
  var gameActive = false;
  var timeRemaining = 60;
  var caughtFishes = [];
  var totalScore = 0;
  var timerInterval = null;

  function formatTime(sec) {
    var minutes = Math.floor(sec / 60);
    var seconds = sec % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function groupCaughtFishes() {
    var config = window.GAME_CONFIG || {};
    var displayNames = config.FISH_DISPLAY_NAMES || {};
    var groups = {};
    var calcTotal = 0;

    caughtFishes.forEach(function (f) {
      var key = f.type + '_' + (f.isCorrect ? 'correct' : 'incorrect');
      if (!groups[key]) {
        var name = displayNames[f.type] || ('🐟 ' + f.type);
        groups[key] = {
          name: name + (f.isCorrect ? ' ✅' : ' ❌'),
          count: 0,
          points: 0,
          isCorrect: f.isCorrect
        };
      }
      groups[key].count++;
      groups[key].points += f.points;
      calcTotal += f.points;
    });

    totalScore = calcTotal;
    return { groups: groups, totalScore: calcTotal };
  }

  window.gameTimer = {

    startGame: function (duration) {
      var config = window.GAME_CONFIG || {};
      duration = duration || config.GAME_DURATION || 60;

      gameActive = true;
      timeRemaining = duration;
      caughtFishes = [];
      totalScore = 0;

      // Afficher le timer HTML
      var timerDisplay = document.getElementById('timer-display');
      if (timerDisplay) timerDisplay.style.display = 'block';
      var timer3D = document.querySelector('#timer-3d');
      if (timer3D) timer3D.setAttribute('visible', 'true');

      var bonusFish = document.querySelector('#bonus-fish');
      if (bonusFish) bonusFish.setAttribute('visible', 'true');

      var scoreDisplay = document.querySelector('#score-display');
      if (scoreDisplay) {
        scoreDisplay.setAttribute('visible', 'true');
        scoreDisplay.setAttribute('value', 'Fish: 0 | Points: 0');
      }
      var waterSurface = document.querySelector('#water-surface');
      if (waterSurface) {
        waterSurface.setAttribute('visible', 'true');
      }
      var bubbles = document.querySelector('#bubbles');
      if (bubbles) bubbles.setAttribute('visible', 'true');

      var spear = document.querySelector('#spear');
      if (spear) spear.setAttribute('visible', 'true');

      var fishTargets = document.querySelectorAll('.fish-target');
      fishTargets.forEach(function (f) { f.setAttribute('visible', 'true'); });

      this.updateTimerDisplay();
      var self = this;
      timerInterval = setInterval(function () {
        timeRemaining--;
        self.updateTimerDisplay();
        if (timeRemaining <= 0) self.endGame();
      }, 1000);
    },

    updateTimerDisplay: function () {
      var t = formatTime(timeRemaining);
      var isWarning = timeRemaining <= 15;

      // Timer HTML
      var timerDisplay = document.getElementById('timer-display');
      if (timerDisplay) {
        timerDisplay.textContent = t;
        timerDisplay.style.color = isWarning ? '#e74c3c' : '#FFD700';
        if (isWarning && !timerDisplay._pulsing && window.GameAnimations) {
          timerDisplay._pulsing = true;
          GameAnimations.startPulse(timerDisplay);
        } else if (!isWarning && timerDisplay._pulsing && window.GameAnimations) {
          timerDisplay._pulsing = false;
          GameAnimations.stopPulse(timerDisplay);
        }
      }

      // Timer 3D
      var timerText3D = document.querySelector('#timer-text');
      if (timerText3D) {
        timerText3D.setAttribute('value', t);
        try { timerText3D.setAttribute('color', isWarning ? '#e74c3c' : '#FFD700'); } catch (e) { /* ignore */ }
      }
    },

    addCaughtFish: function (fishType, isCorrect, points) {
      caughtFishes.push({
        type: fishType,
        isCorrect: isCorrect,
        points: points,
        timestamp: new Date().toLocaleTimeString()
      });
      totalScore += points;

      // Mettre à jour le score
      try {
        var scoreDisplay = document.querySelector('#score-display');
        if (scoreDisplay) {
          scoreDisplay.setAttribute('value', 'Fish: ' + caughtFishes.length + ' | Points: ' + totalScore);
        }
      } catch (e) { /* ignore */ }
    },

    endGame: function () {
      gameActive = false;
      if (timerInterval) clearInterval(timerInterval);
      this.showEndGameScreen();
    },

    showEndGameScreen: function () {
      // Cacher les éléments de jeu
      var timer3D = document.querySelector('#timer-3d');
      if (timer3D) timer3D.setAttribute('visible', 'false');
      var bonusFish = document.querySelector('#bonus-fish');
      if (bonusFish) bonusFish.setAttribute('visible', 'false');
      var scoreDisplay = document.querySelector('#score-display');
      if (scoreDisplay) scoreDisplay.setAttribute('visible', 'false');

      // Afficher l'écran de fin 3D
      var endScreen3D = document.querySelector('#end-screen-3d');
      if (endScreen3D) {
        endScreen3D.setAttribute('visible', 'true');
        this._populateScoreTable3D();
      }

      // Afficher l'écran de fin HTML
      var endGameScreen = document.getElementById('end-game-screen');
      if (endGameScreen) {
        this._populateScoreTableHTML();
        endGameScreen.style.display = 'flex';
        // Fade in GSAP
        if (window.GameAnimations) GameAnimations.fadeIn(endGameScreen, 500);
      }
    },

    // Tableau HTML (overlay navigateur)
    _populateScoreTableHTML: function () {
      var tableBody = document.getElementById('score-table-body');
      if (!tableBody) return;
      tableBody.innerHTML = '';

      if (caughtFishes.length === 0) {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="3" style="text-align:center;color:#999;">😢 No fish caught...</td>';
        tableBody.appendChild(emptyRow);
        return;
      }

      var result = groupCaughtFishes();
      var groups = result.groups;

      Object.values(groups).forEach(function (g) {
        var row = document.createElement('tr');
        row.className = g.isCorrect ? 'correct-row' : 'incorrect-row';
        var pointsColor = g.points >= 0 ? '#00ff00' : '#ff0000';
        var sign = g.points > 0 ? '+' : '';
        row.innerHTML = '<td>' + g.name + '</td>' +
          '<td>x ' + g.count + '</td>' +
          '<td style="color:' + pointsColor + '">' + sign + g.points + ' pts</td>';
        tableBody.appendChild(row);
      });

      // Ligne TOTAL
      var totalRow = document.createElement('tr');
      totalRow.className = 'total-row';
      var totalColor = totalScore >= 0 ? '#FFD700' : '#ff6b6b';
      var totalSign = totalScore > 0 ? '+' : '';
      totalRow.innerHTML = '<td><strong>TOTAL</strong></td><td></td>' +
        '<td style="color:' + totalColor + '"><strong>' + totalSign + totalScore + ' pts</strong></td>';
      tableBody.appendChild(totalRow);
    },

    // Tableau 3D (dans le casque VR)
    _populateScoreTable3D: function () {
      var endScreen3D = document.querySelector('#end-screen-3d');
      if (!endScreen3D) return;

      // Supprimer l'ancien tableau
      var old = document.querySelector('#dynamic-score-table-3d');
      if (old) old.parentNode.removeChild(old);
      if (caughtFishes.length === 0) {
        var emptyText = document.createElement('a-text');
        emptyText.setAttribute('id', 'dynamic-score-table-3d');
        emptyText.setAttribute('value', 'No fish caught...');
        emptyText.setAttribute('align', 'center');
        emptyText.setAttribute('color', '#999999');
        emptyText.setAttribute('width', '1.8');
        emptyText.setAttribute('position', '0 0 0');
        endScreen3D.appendChild(emptyText);
        return;
      }

      var result = groupCaughtFishes();
      var groups = result.groups;

      var container = document.createElement('a-entity');
      container.setAttribute('id', 'dynamic-score-table-3d');
      container.setAttribute('position', '0 0.3 0.01');

      // En-tête
      this._add3DPlane(container, '#FFD700', 0.2, '1.1', '0.08', '0 0 -0.01');
      this._add3DText(container, 'Fish Type', 'left', '#FFD700', '-0.52 0 0');
      this._add3DText(container, 'Quantity', 'center', '#FFD700', '0 0 0');
      this._add3DText(container, 'Points', 'right', '#FFD700', '0.52 0 0');

      // Lignes par groupe
      var yPos = -0.12;
      var self = this;
      Object.values(groups).forEach(function (group) {
        var bgColor = group.isCorrect ? '#00ff00' : '#ff0000';
        self._add3DPlane(container, bgColor, 0.1, '1.1', '0.08', '0 ' + yPos + ' -0.01');
        self._add3DText(container, group.name, 'left', '#ffffff', '-0.52 ' + yPos + ' 0', '0.9');
        self._add3DText(container, 'x ' + group.count, 'center', '#ffffff', '0 ' + yPos + ' 0');

        var pointsColor = group.points >= 0 ? '#00ff00' : '#ff0000';
        var sign = group.points > 0 ? '+' : '';
        self._add3DText(container, sign + group.points + ' pts', 'right', pointsColor, '0.52 ' + yPos + ' 0');

        yPos -= 0.10;
      });

      // Ligne TOTAL
      yPos -= 0.02;
      this._add3DPlane(container, '#FFD700', 0.25, '1.1', '0.09', '0 ' + yPos + ' -0.01');
      this._add3DText(container, 'TOTAL', 'left', '#FFD700', '-0.52 ' + yPos + ' 0');

      var totalColor = totalScore >= 0 ? '#FFD700' : '#ff6b6b';
      var totalSign = totalScore > 0 ? '+' : '';
      this._add3DText(container, totalSign + totalScore + ' pts', 'right', totalColor, '0.52 ' + yPos + ' 0');

      endScreen3D.appendChild(container);
    },

    // Helpers pour créer les éléments 3D
    _add3DText: function (parent, value, align, color, position, width) {
      var text = document.createElement('a-text');
      text.setAttribute('value', value);
      text.setAttribute('align', align);
      text.setAttribute('color', color);
      text.setAttribute('width', width || '1');
      text.setAttribute('position', position);
      parent.appendChild(text);
    },

    _add3DPlane: function (parent, color, opacity, width, height, position) {
      var plane = document.createElement('a-plane');
      plane.setAttribute('color', color);
      plane.setAttribute('opacity', opacity);
      plane.setAttribute('width', width);
      plane.setAttribute('height', height);
      plane.setAttribute('position', position);
      parent.appendChild(plane);
    },

    resetGame: function () {
      gameActive = false;
      if (timerInterval) clearInterval(timerInterval);
      timeRemaining = 60;
      caughtFishes = [];
      totalScore = 0;

      // Cacher les écrans de fin
      var endGameScreen = document.getElementById('end-game-screen');
      if (endGameScreen) endGameScreen.style.display = 'none';
      var endScreen3D = document.querySelector('#end-screen-3d');
      if (endScreen3D) endScreen3D.setAttribute('visible', 'false');
      var timer3D = document.querySelector('#timer-3d');
      if (timer3D) timer3D.setAttribute('visible', 'false');

      // Réinitialiser le timer HTML
      var timerDisplay = document.getElementById('timer-display');
      if (timerDisplay) {
        timerDisplay.style.display = 'none';
        timerDisplay.textContent = '1:00';
        timerDisplay.style.color = '#FFD700';
        // Arrêter le pulse GSAP si actif
        if (timerDisplay._pulsing && window.GameAnimations) {
          timerDisplay._pulsing = false;
          GameAnimations.stopPulse(timerDisplay);
        }
      }

      // Réinitialiser le timer 3D
      var timerText3D = document.querySelector('#timer-text');
      if (timerText3D) {
        timerText3D.setAttribute('value', '1:00');
        timerText3D.setAttribute('color', '#FFD700');
      }

      // Réinitialiser le score
      var scoreDisplay = document.querySelector('#score-display');
      if (scoreDisplay) scoreDisplay.setAttribute('value', 'Fish: 0 | Points: 0');
      var grabManager = document.querySelector('[grab-manager]');
      if (grabManager && grabManager.components && grabManager.components['grab-manager']) {
        grabManager.components['grab-manager'].fishCaught = 0;
        grabManager.components['grab-manager'].points = 0;
      }

      // Cacher les poissons restants
      var fishTargets = document.querySelectorAll('.fish-target');
      fishTargets.forEach(function (f) {
        delete f.dataset.caught;
        f.setAttribute('visible', 'false');
      });
    },

    isGameActive: function () { return gameActive; },
    getCaughtFishes: function () { return caughtFishes; },
    getTotalScore: function () { return totalScore; }
  };

})();
